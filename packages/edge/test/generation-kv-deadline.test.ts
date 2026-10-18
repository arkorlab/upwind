import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readGeneration } from '../src/cache/generation-loader.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const NOW = 100;
const KEY = { scopeId: 'scope-deadline', entryId: 'entry-deadline' };
const RECORD_KEY = kvGenerationKey(KEY.scopeId, KEY.entryId);
const RECORD_HTML = new TextEncoder().encode('<html><body>current generation</body></html>');

async function record(revision = 3) {
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      ...KEY,
      generationId: 'gen_deadline',
      seq: 1,
      revision,
      source: 'runtime',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: await sha256Hex(RECORD_HTML),
      htmlLength: RECORD_HTML.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    RECORD_HTML,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('record fixture did not decode');
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new TypeError('record buffer must be owned');
  return { bytes: bytes.buffer, pack: decoded.pack };
}

async function fixture(copies = false) {
  const document = pprDocument();
  const site = await seedSite({ document });
  const settings = {
    ...DEFAULT_RUNTIME_CACHE_SETTINGS,
    generations: 'on' as const,
    holdMs: 5000,
    cacheApiMaxAgeMs: copies ? 1000 : 0,
  };
  const policy = { ...DEFAULT_DELIVERY_POLICY, runtimeCache: settings };
  const manifest = {
    ...site.manifest,
    cache: { keySchemaVersion: 1 as const, scopeId: KEY.scopeId },
    routes: {
      '/': {
        ...site.manifest.routes['/']!,
        cache: { entryId: KEY.entryId, kind: 'app-page' as const, delivery: 'resume' as const },
      },
    },
  };
  const runtime = standaloneRuntime(env, {
    now: () => NOW,
    memory: createEdgeMemory(() => NOW),
    dispatchApp: () => Promise.resolve(htmlResponse(document.suffix)),
  });
  // A build shell already in hand must not wait forever for a separate generation lookup.
  runtime.memory.shells.set(
    manifest.routes['/'].shell.sha256,
    document.shell,
    document.shell.byteLength,
  );
  const edge: EdgeContext = {
    env,
    ctx: createExecutionContext(),
    runtime,
    host: standaloneHost(env),
    forwarding: { previewDomain: 'example', previewHost: 'site.example', clientIp: undefined },
    app: site.pointer.app,
    originalUrl: undefined,
    policy,
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: true,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: site.manifestId,
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: undefined },
  };
  const cache = await caches.open(edge.host.names.recordCache);
  vi.spyOn(caches, 'open').mockResolvedValue(cache);
  const match = vi.spyOn(cache, 'match').mockResolvedValue(undefined);
  return { edge, settings, site, manifest, document, match };
}

function serve(test: Awaited<ReturnType<typeof fixture>>) {
  const request = navigation('/');
  return serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx: test.edge.ctx,
      runtime: test.edge.runtime,
      host: test.edge.host,
      pointer: test.site.pointer,
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: test.manifest }),
      policyLookup: Promise.resolve({ kind: 'found', source: 'exact', policy: test.edge.policy }),
    },
  );
}

function holdKv() {
  const pending = Promise.withResolvers<ArrayBuffer | null>();
  const entered = Promise.withResolvers<undefined>();
  const heldGet = () => {
    entered.resolve(undefined);
    return pending.promise;
  };
  // Keep the binding object, viewed through the one overload the record loader calls.
  const records: {
    get(
      key: string,
      options: { type: 'arrayBuffer'; cacheTtl?: number },
    ): Promise<ArrayBuffer | null>;
  } = env.CACHE_STATE;
  const get = vi.spyOn(records, 'get').mockImplementation(heldGet);
  return { pending, entered, get };
}

function settleKv(
  kv: ReturnType<typeof holdKv>,
  answer: 'bytes' | 'none' | 'rejection',
  bytes: ArrayBuffer,
): void {
  if (answer === 'rejection') kv.pending.reject(new Error('regional failure'));
  else kv.pending.resolve(answer === 'bytes' ? bytes : null);
}

describe('a delivery record KV wait has a deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'serves the public build fallback with copies=%s when KV stalls',
    async (copies) => {
      const test = await fixture(copies);
      const kv = holdKv();
      vi.useFakeTimers();
      let answered = false;
      const response = (async () => {
        const value = await serve(test);
        answered = true;
        return value;
      })();
      try {
        await kv.entered.promise;
        await vi.advanceTimersByTimeAsync(2001);

        expect(answered).toBe(true);

        const value = await response;

        expect(value.status).toBe(200);
        await expect(value.text()).resolves.toBe(
          test.document.shellText + test.document.suffixText,
        );
        expect(value.headers.get('server-timing')).toContain('record-unavailable');
        expect(test.edge.runtime.memory.kvAnswered.get(RECORD_KEY)).toBeUndefined();
      } finally {
        kv.pending.resolve(null);
        await response;
        await waitOnExecutionContext(test.edge.ctx);
      }
    },
  );

  it.each(['bytes', 'none', 'rejection'] as const)(
    'discards a late KV %s without changing newer held state',
    async (late) => {
      const test = await fixture();
      const old = await record();
      const newer = await record(10);
      const kv = holdKv();
      vi.useFakeTimers();
      let load: Awaited<ReturnType<typeof readGeneration>> | undefined;
      const reading = (async () => {
        load = await readGeneration(test.edge, KEY, test.settings);
        return load;
      })();
      try {
        await vi.advanceTimersByTimeAsync(2001);

        expect(load?.kind).toBe('unavailable');

        test.edge.runtime.memory.generations.set(
          RECORD_KEY,
          { pack: newer.pack, readAt: NOW, bytes: newer.bytes.byteLength },
          newer.bytes.byteLength,
        );

        settleKv(kv, late, old.bytes);
        await vi.advanceTimersByTimeAsync(0);

        expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack).toBe(newer.pack);
        expect(test.edge.runtime.memory.kvAnswered.get(RECORD_KEY)).toBeUndefined();
      } finally {
        kv.pending.resolve(null);
        await reading;
      }
    },
  );

  it.each(['bytes', 'none', 'rejection'] as const)(
    'lets a valid copy win before KV and ignores its late %s',
    async (late) => {
      const test = await fixture(true);
      const current = await record();

      test.match.mockResolvedValue(
        new Response(current.bytes, {
          headers: { 'x-arkor-kept-at': String(NOW), 'x-arkor-revision': '3' },
        }),
      );

      const kv = holdKv();
      vi.useFakeTimers();
      const load = await readGeneration(test.edge, KEY, test.settings);

      expect(load.kind === 'generation' && load.source).toBe('cache-api');

      await vi.advanceTimersByTimeAsync(2001);
      await waitOnExecutionContext(test.edge.ctx);

      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack.header.revision).toBe(3);
      expect(test.edge.runtime.memory.kvAnswered.get(RECORD_KEY)).toBeUndefined();

      settleKv(kv, late, (await record(10)).bytes);
      await vi.advanceTimersByTimeAsync(0);

      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack.header.revision).toBe(3);
    },
  );

  it.each([
    { answer: 'bytes', expected: 'generation' },
    { answer: 'none', expected: 'none' },
    { answer: 'rejection', expected: 'unavailable' },
  ] as const)('keeps a timely KV $answer and clears its timer', async ({ answer, expected }) => {
    const test = await fixture();
    const current = await record();
    const kv = holdKv();
    vi.useFakeTimers();
    const reading = readGeneration(test.edge, KEY, test.settings);
    settleKv(kv, answer, current.bytes);
    const load = await reading;

    expect(load.kind).toBe(expected);
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens the copy after a formerly fast KV stalls, then keeps its answer', async () => {
    const test = await fixture(true);
    const current = await record();

    test.match.mockResolvedValue(
      new Response(current.bytes, {
        headers: { 'x-arkor-kept-at': String(NOW), 'x-arkor-revision': '3' },
      }),
    );

    test.edge.runtime.memory.kvAnswered.set(RECORD_KEY, true);

    const kv = holdKv();
    vi.useFakeTimers();
    const reading = readGeneration(test.edge, KEY, test.settings);
    try {
      await vi.advanceTimersByTimeAsync(1000);

      expect(test.match).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1001);
      const load = await reading;

      expect(load.kind === 'generation' && load.source).toBe('cache-api');
      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack.header.revision).toBe(3);
    } finally {
      kv.pending.resolve(null);
      await reading;
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it('normalizes a synchronous KV binding failure without leaving a timer', async () => {
    const test = await fixture();
    vi.spyOn(env.CACHE_STATE, 'get').mockImplementation(() => {
      throw new Error('binding unavailable');
    });
    vi.useFakeTimers();
    const load = await readGeneration(test.edge, KEY, test.settings);

    expect(load.kind === 'unavailable' && load.detail).toBe('binding unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles the owner if deadline failure logging itself throws', async () => {
    const test = await fixture();
    const kv = holdKv();
    const failure = new Error('logging failed');
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw failure;
    });
    vi.useFakeTimers();
    const handled = (async () => {
      try {
        return await readGeneration(test.edge, KEY, test.settings);
      } catch (error) {
        return error;
      }
    })();
    try {
      await vi.advanceTimersByTimeAsync(2001);

      await expect(handled).resolves.toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      kv.pending.resolve(null);
      await handled;
    }
  });

  it('serves a fresh held generation through the public entry without KV or a deadline timer', async () => {
    const test = await fixture();
    const current = await record();

    test.edge.runtime.memory.generations.set(
      RECORD_KEY,
      { pack: current.pack, readAt: NOW, bytes: current.bytes.byteLength },
      current.bytes.byteLength,
    );

    const get = vi.spyOn(env.CACHE_STATE, 'get');
    vi.useFakeTimers();
    const value = await serve(test);

    await expect(value.text()).resolves.toBe(new TextDecoder().decode(RECORD_HTML));
    expect(get).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await waitOnExecutionContext(test.edge.ctx);
  });
});
