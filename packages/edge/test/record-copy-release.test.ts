import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dropCopyIf,
  keepCopyAhead,
  readCopy,
  recordCopyUrl,
} from '../src/cache/generation-copy.ts';
import { readGeneration } from '../src/cache/generation-loader.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const BYTES = encodeUtf8('the complete delivery record');
const NOW = 100;
const MAX_AGE_MS = 1000;

async function fixture() {
  const edge: EdgeContext = {
    env,
    ctx: createExecutionContext(),
    runtime: standaloneRuntime(env, { memory: createEdgeMemory(() => NOW), now: () => NOW }),
    host: standaloneHost(env),
    forwarding: {
      previewDomain: 'example.test',
      previewHost: 'customer.example.test',
      clientIp: undefined,
    },
    app: undefined,
    originalUrl: undefined,
    policy: DEFAULT_DELIVERY_POLICY,
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: true,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: 'a'.repeat(64),
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: 0 },
  };
  const cache = await caches.open(edge.host.names.recordCache);
  const open = vi.spyOn(caches, 'open').mockResolvedValue(cache);
  const match = vi.spyOn(cache, 'match');
  return { edge, cache, open, match };
}

function copy(body: ReadableStream<Uint8Array> | null, keptAt = NOW): Response {
  return new Response(body, {
    headers: { 'x-arkor-kept-at': String(keptAt), 'x-arkor-revision': '3' },
  });
}

function holdLookup(
  test: Awaited<ReturnType<typeof fixture>>,
  late: 'lookup' | 'open',
  hit: Response,
) {
  const pending = Promise.withResolvers<Response | undefined>();
  const pendingCache = Promise.withResolvers<Cache>();
  if (late === 'lookup') test.match.mockImplementation(() => pending.promise);
  else {
    test.open.mockImplementation(() => pendingCache.promise);

    test.match.mockResolvedValue(hit);
  }
  return () => {
    pending.resolve(hit);
    pendingCache.resolve(test.cache);
  };
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new TypeError('record buffer must be owned');
  return bytes.buffer;
}

function byteView(
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer> | undefined,
): Uint8Array<ArrayBuffer> {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('missing native cached bytes');
  return bytes;
}

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing cache answer');
  return value;
}

async function record() {
  return encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: 'scope-copy',
      entryId: 'entry-copy',
      generationId: 'gen_copy',
      seq: 1,
      revision: 3,
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
      htmlSha256: await sha256Hex(BYTES),
      htmlLength: BYTES.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    BYTES,
    undefined,
  );
}

describe('giving up a record copy after its existing read deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['high surrogate in scope', 'scope-\uD800', 'entry'],
    ['low surrogate in entry', 'scope', 'entry-\uDC00'],
    ['another high surrogate', 'scope-\uD801', 'entry'],
  ])('keeps, reads and deletes a copy with %s', async (_what, scopeId, entryId) => {
    const { edge, match } = await fixture();
    match.mockRestore();
    const key = kvGenerationKey(scopeId, entryId);
    await keepCopyAhead(
      edge,
      key,
      { bytes: BYTES, revision: 3 },
      { maxAgeMs: MAX_AGE_MS, wanted: () => true },
    );
    const found = await readCopy(edge, key, MAX_AGE_MS);

    expect(found?.revision).toBe(3);
    expect(byteView(found?.bytes)).toStrictEqual(BYTES);

    await dropCopyIf(edge, key, MAX_AGE_MS, () => true);

    await expect(readCopy(edge, key, MAX_AGE_MS)).resolves.toBeUndefined();
  });

  it('keeps existing copy URLs and distinguishes surrogate spellings from escaped text', () => {
    const host = 'records.example.test';
    const ordinary = [
      'record',
      'scope/entry',
      'utf16/value',
      String.raw`scope-\ud800`,
      'scope-\uFFFD',
      '日本語-😀',
    ];
    for (const key of ordinary) {
      expect(recordCopyUrl(host, key)).toBe(`https://${host}/${encodeURIComponent(key)}`);
    }
    const keys = ['scope-\uD800', 'scope-\uD801', 'scope-\uDC00'];
    const urls = keys.map((key) => recordCopyUrl(host, key));
    const ordinaryUrls = ordinary.map((key) => recordCopyUrl(host, key));

    expect(new Set([...urls, ...ordinaryUrls]).size).toBe(urls.length + ordinary.length);
    for (const [index, url] of urls.entries()) {
      const path = new URL(url).pathname;

      expect(path.startsWith('/utf16/')).toBe(true);
      expect(JSON.parse(decodeURIComponent(path.slice('/utf16/'.length)))).toBe(keys[index]);
    }
  });

  it.each(['resolved', 'pending', 'rejected'] as const)(
    'cancels an active body without waiting for %s cancellation',
    async (acknowledgment) => {
      const { edge, match } = await fixture();
      vi.useFakeTimers();
      const ack = Promise.withResolvers<undefined>();
      const latePull = Promise.withResolvers<undefined>();
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(BYTES.subarray(0, 1));
        },
        pull: () => latePull.promise,
        cancel() {
          cancelled();
          if (acknowledgment === 'pending') return ack.promise;
          if (acknowledgment === 'rejected') return Promise.reject(new Error('cancel failed'));
          return Promise.resolve();
        },
      });
      match.mockResolvedValue(copy(body));
      const reading = readCopy(edge, 'record', MAX_AGE_MS);
      try {
        await vi.advanceTimersByTimeAsync(101);

        await expect(reading).resolves.toBeUndefined();
        expect(cancelled).toHaveBeenCalledTimes(1);

        latePull.reject(new Error('pull failed after cancellation'));
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        latePull.resolve(undefined);
        ack.resolve(undefined);
        await reading;
      }
    },
  );

  it.each(['lookup', 'open'] as const)(
    'releases a response after a late cache %s before reading it',
    async (late) => {
      const test = await fixture();
      vi.useFakeTimers();
      const cancelled = vi.fn();
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        { pull, cancel: cancelled },
        { highWaterMark: 0 },
      );
      const hit = copy(body);
      const release = holdLookup(test, late, hit);
      const reading = readCopy(test.edge, 'record', MAX_AGE_MS);
      try {
        await vi.advanceTimersByTimeAsync(101);

        await expect(reading).resolves.toBeUndefined();

        release();
        await vi.advanceTimersByTimeAsync(0);

        expect(cancelled).toHaveBeenCalledTimes(1);
        expect(pull).not.toHaveBeenCalled();
      } finally {
        release();
        await reading;
      }
    },
  );

  it('keeps the fast copy bytes and stamps on one native arrayBuffer read', async () => {
    const { edge, match } = await fixture();
    const arrayBuffer = vi.spyOn(Response.prototype, 'arrayBuffer');
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.subarray(0, 3));
        controller.enqueue(BYTES.subarray(3));
        controller.close();
      },
      cancel: cancelled,
    });
    match.mockResolvedValue(copy(body));
    const found = await readCopy(edge, 'record', MAX_AGE_MS);

    expect(found).toStrictEqual({ keptAt: NOW, revision: 3, bytes: BYTES.buffer });
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('decodes and keeps a native cached record view without its sentinel capacity', async () => {
    const { edge, cache, match } = await fixture();
    match.mockRestore();
    const bytes = await record();
    const buffer = ownedBuffer(bytes);
    const recordKey = kvGenerationKey('scope-copy', 'entry-copy');
    const request = new Request(recordCopyUrl(edge.host.names.cacheKeyHost, recordKey));
    await keepCopyAhead(
      edge,
      recordKey,
      { bytes: buffer, revision: 3 },
      { maxAgeMs: MAX_AGE_MS, wanted: () => true },
    );
    const hit = await cache.match(request);

    expect(hit?.headers.get('content-length')).toBe(String(bytes.byteLength));

    await hit?.body?.cancel();
    const copied = await readCopy(edge, recordKey, MAX_AGE_MS);

    expect(copied?.bytes).toBeInstanceOf(Uint8Array);
    expect(copied?.bytes.byteLength).toBe(bytes.byteLength);

    const view = byteView(copied?.bytes);

    expect(view.buffer.byteLength).toBe(bytes.byteLength + 1);
    await expect(sha256Hex(view)).resolves.toBe(await sha256Hex(bytes));

    const decoded = decodeGenerationPack(view);

    expect(decoded.kind).toBe('ok');

    const padded = new Uint8Array(view.byteLength + 7);
    padded.set(view, 3);
    const offset = padded.subarray(3, 3 + view.byteLength);
    await keepCopyAhead(
      edge,
      recordKey,
      { bytes: offset, revision: 4 },
      { maxAgeMs: MAX_AGE_MS, wanted: () => true },
    );
    const rewritten = await cache.match(request);

    expect(rewritten?.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await present(rewritten).arrayBuffer())).toStrictEqual(bytes);

    // Recreate the original revision so the normal loader can adopt it beside pending KV.
    await cache.delete(request);
    await keepCopyAhead(
      edge,
      recordKey,
      { bytes: view, revision: 3 },
      { maxAgeMs: MAX_AGE_MS, wanted: () => true },
    );
    const kv = Promise.withResolvers<never>();
    vi.spyOn(env.CACHE_STATE, 'get').mockImplementation(() => kv.promise);
    try {
      const load = await readGeneration(
        edge,
        { scopeId: 'scope-copy', entryId: 'entry-copy' },
        {
          ...DEFAULT_RUNTIME_CACHE_SETTINGS,
          generations: 'on',
          cacheApiMaxAgeMs: MAX_AGE_MS,
        },
      );

      expect(load.kind === 'generation' && load.source).toBe('cache-api');
      expect(edge.runtime.memory.generations.get(recordKey)?.pack.html).toStrictEqual(BYTES);

      const retained = bytes.byteLength + 1;

      expect(edge.runtime.memory.generations.get(recordKey)?.bytes).toBe(
        retained + 4 * (retained - BYTES.byteLength),
      );
    } finally {
      kv.reject(new Error('KV read failed after the copy answered'));
      await waitOnExecutionContext(edge.ctx);
      await cache.delete(request);
    }
  });

  it.each(['x-arkor-kept-at', 'x-arkor-revision'] as const)(
    'releases a copy without %s without buffering',
    async (missing) => {
      const { edge, match } = await fixture();
      const cancelled = vi.fn();
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        { pull, cancel: cancelled },
        { highWaterMark: 0 },
      );
      const hit = copy(body);
      hit.headers.delete(missing);
      match.mockResolvedValue(hit);
      const found = await readCopy(edge, 'record', MAX_AGE_MS);

      expect(found).toBeUndefined();
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(pull).not.toHaveBeenCalled();
    },
  );

  it('keeps an expired copy absent', async () => {
    const { edge, match } = await fixture();
    match.mockResolvedValue(copy(new Response(BYTES).body, 0));

    await expect(readCopy(edge, 'record', 1)).resolves.toBeUndefined();
  });

  it('keeps a cache miss absent without a body read', async () => {
    const { edge, match } = await fixture();
    const arrayBuffer = vi.spyOn(Response.prototype, 'arrayBuffer');
    match.mockResolvedValue(undefined);

    await expect(readCopy(edge, 'record', MAX_AGE_MS)).resolves.toBeUndefined();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('preserves a null body as an empty native buffer', async () => {
    const { edge, match } = await fixture();
    match.mockResolvedValue(copy(null));

    await expect(readCopy(edge, 'record', MAX_AGE_MS)).resolves.toStrictEqual({
      keptAt: NOW,
      revision: 3,
      bytes: new ArrayBuffer(0),
    });
  });

  it('keeps a failed body absent and consumes its rejection', async () => {
    const { edge, match } = await fixture();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('read failed'));
      },
    });
    match.mockResolvedValue(copy(body));

    await expect(readCopy(edge, 'record', MAX_AGE_MS)).resolves.toBeUndefined();
  });
});
