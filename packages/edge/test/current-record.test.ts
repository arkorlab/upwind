import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  type GenerationPackHeader,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { DEFAULT_RUNTIME_CACHE_SETTINGS } from '@stayingupwind/host/delivery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordCopyUrl } from '../src/cache/generation-copy.ts';
import { readAbsentRecordBehind } from '../src/cache/generation-current.ts';
import { loadGeneration, readServedAgain } from '../src/cache/generation-hold.ts';
import { readGeneration } from '../src/cache/generation-loader.ts';
import type { EdgeHost } from '../src/edge-host.ts';
import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

/** Real pack validation and isolate memory, with KV and the Cache API held in memory in Node. */
const SCOPE = 'dpl_current';
const ENTRY = 'ent_current';
const KEY = { scopeId: SCOPE, entryId: ENTRY };
const RECORD_KEY = kvGenerationKey(SCOPE, ENTRY);
const T0 = 1_800_000_000_000;
const SETTINGS = {
  ...DEFAULT_RUNTIME_CACHE_SETTINGS,
  generations: 'on' as const,
  holdMs: 5000,
  cacheApiMaxAgeMs: 300_000,
};
const COPY_URL = recordCopyUrl('copy.test.invalid', RECORD_KEY);

async function record(
  seq: number,
  fields: Partial<GenerationPackHeader> = {},
): Promise<ArrayBuffer> {
  const html = new TextEncoder().encode(`generation ${seq}`);
  const header: GenerationPackHeader = {
    schemaVersion: 1,
    scopeId: SCOPE,
    entryId: ENTRY,
    generationId: `gen_${seq}`,
    seq,
    revision: seq,
    source: 'runtime',
    kind: 'app-page',
    route: '/page',
    pathname: '/page',
    cacheTimestamp: seq === 1 ? T0 - 2000 : T0,
    producedAt: T0,
    policy: policyFromBuild({ initialRevalidate: 1, initialExpiration: 300 }),
    status: 200,
    headers: { 'content-type': 'text/html' },
    tags: [],
    htmlSha256: await sha256Hex(html),
    htmlLength: html.byteLength,
    postponedSha256: null,
    postponedLength: 0,
    artifacts: [],
    ...fields,
  };
  return new Uint8Array(encodeGenerationPack(header, html, undefined)).buffer;
}

function packOf(bytes: ArrayBuffer) {
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (decoded.kind !== 'ok') throw new Error('test record must decode');
  return decoded.pack;
}

interface Fixture {
  readonly edge: EdgeContext;
  readonly clock: { now: number };
  readonly kv: { bytes: ArrayBuffer; get: ReturnType<typeof vi.fn> };
  readonly tasks: Promise<unknown>[];
}

function fixture(bytes: ArrayBuffer, currentRecord?: EdgeHost['currentRecord']): Fixture {
  const clock = { now: T0 };
  const tasks: Promise<unknown>[] = [];
  const kv = { bytes, get: vi.fn(() => Promise.resolve(new Uint8Array(kv.bytes).buffer)) };
  const now = () => clock.now;
  const runtime: EdgeRuntime = {
    now,
    memory: createEdgeMemory(now),
    fetchImpl: vi.fn(),
    dispatchApp: undefined,
    transformImage: undefined,
    blobWorker: undefined,
  };
  const edge = {
    env: { CACHE_STATE: { get: kv.get } },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    host: {
      names: { cacheKeyHost: 'copy.test.invalid', recordCache: 'test-records' },
      currentRecord,
    },
    runtime,
    app: undefined,
    cacheApi: true,
    validated: false,
  } as unknown as EdgeContext;
  return { edge, clock, kv, tasks };
}

async function drain(test: Fixture): Promise<void> {
  while (test.tasks.length > 0) await Promise.all(test.tasks.splice(0));
}

function held(test: Fixture) {
  return test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack;
}

function generation(load: Awaited<ReturnType<typeof loadGeneration>>) {
  if (load.kind !== 'generation') throw new Error('a delivery record must answer');
  return load.pack;
}

const copies = new Map<string, Response>();
const copyReads: { gate: Promise<undefined> | undefined } = { gate: undefined };

describe('a stale served record behind regional KV', () => {
  beforeEach(() => {
    copies.clear();
    copyReads.gate = undefined;
    vi.stubGlobal('caches', {
      open: () => {
        return Promise.resolve({
          match: async (request: Request) => {
            if (copyReads.gate !== undefined) await copyReads.gate;
            return copies.get(request.url)?.clone();
          },
          put: (request: Request, response: Response) => {
            copies.set(request.url, response.clone());
            return Promise.resolve();
          },
          delete: (request: Request) => Promise.resolve(copies.delete(request.url)),
        });
      },
    });
    vi.spyOn(console, 'warn').mockReturnValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('finishes serving A before the authority answers, then shares B with another isolate', async () => {
    const old = await record(1);
    const next = await record(2);
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const authority = vi.fn(() => gate.promise);
    const test = fixture(old, authority);
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);

    test.clock.now += 1000;

    readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });
    const served = generation(await loadGeneration(test.edge, KEY, SETTINGS));
    const body = await new Response(new Uint8Array(served.html).buffer).text();

    expect(body).toBe('generation 1');
    expect(authority).toHaveBeenCalledWith(SCOPE, ENTRY, 1);

    gate.resolve(next);
    await drain(test);

    expect(held(test)?.header.seq).toBe(2);
    expect(copies.get(COPY_URL)?.headers.get('x-arkor-revision')).toBe('2');

    const other = fixture(old);
    const gateForCopy = Promise.withResolvers<undefined>();
    copyReads.gate = gateForCopy.promise;

    await expect(loadGeneration(other.edge, KEY, SETTINGS)).resolves.toMatchObject({
      kind: 'generation',
      source: 'kv',
      pack: { header: { seq: 1 } },
    });

    gateForCopy.resolve(undefined);
    await drain(other);

    expect(held(other)?.header.seq).toBe(2);
    await expect(loadGeneration(other.edge, KEY, SETTINGS)).resolves.toMatchObject({
      kind: 'generation',
      source: 'memory',
      pack: { header: { seq: 2 } },
    });
  });

  it('keeps only the existing authority proof when an identical regional copy answers first', async () => {
    const bytes = await record(1);
    const authority = vi.fn(() => Promise.resolve(bytes));
    const test = fixture(bytes, authority);

    test.kv.get.mockResolvedValue(null);

    await readGeneration(test.edge, KEY, SETTINGS);
    readAbsentRecordBehind(test.edge, KEY, SETTINGS);
    await drain(test);

    test.clock.now += 25_000;

    await readGeneration(test.edge, KEY, SETTINGS);
    await drain(test);
    const confirmedAt = test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt;

    test.clock.now = T0 + 31_001;

    const regional = Promise.withResolvers<ArrayBuffer | null>();

    test.kv.get.mockReturnValueOnce(regional.promise);

    const loaded = await readGeneration(test.edge, KEY, SETTINGS);

    expect(loaded).toMatchObject({ kind: 'generation', source: 'cache-api' });
    expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt).toBe(
      confirmedAt,
    );

    regional.resolve(null);
    await drain(test);

    expect(held(test)?.header.seq).toBe(1);
    expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt).toBe(
      test.clock.now,
    );
    expect(authority).toHaveBeenLastCalledWith(SCOPE, ENTRY, 0);
  });

  it('does not grant authority grace to a regional copy without an isolate proof', async () => {
    const test = fixture(await record(1));
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);

    test.clock.now += 31_001;

    const regional = Promise.withResolvers<ArrayBuffer | null>();

    test.kv.get.mockReturnValueOnce(regional.promise);

    await readGeneration(test.edge, KEY, SETTINGS);

    expect(
      test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt,
    ).toBeUndefined();

    regional.resolve(null);
    await drain(test);

    expect(held(test)).toBeUndefined();
    expect(copies.get(COPY_URL)).toBeUndefined();
  });

  it('shares pending reads and retries only after the stale-read cadence', async () => {
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const authority = vi.fn(() => gate.promise);
    const test = fixture(await record(1), authority);
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);
    for (let request = 0; request < 10; request += 1) {
      readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(authority).toHaveBeenCalledTimes(1);

    test.clock.now += 1000;

    readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });

    expect(authority).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    await drain(test);
    readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });
    await drain(test);

    expect(authority).toHaveBeenCalledTimes(2);
  });

  it('does not let a late B replace C in memory or in the data-center copy', async () => {
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const test = fixture(await record(1), () => gate.promise);
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);
    readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });

    test.kv.bytes = await record(3);

    await readGeneration(test.edge, KEY, SETTINGS);
    gate.resolve(await record(2));
    await drain(test);

    expect(held(test)?.header.seq).toBe(3);
    expect(copies.get(COPY_URL)?.headers.get('x-arkor-revision')).toBe('3');
  });

  it.each([
    ['another scope', { scopeId: 'dpl_other' }],
    ['another entry', { entryId: 'ent_other' }],
    ['a bad digest', { htmlSha256: '0'.repeat(64) }],
    ['the same revision', { revision: 1 }],
    ['an earlier revision', { revision: 0 }],
  ] as const)('keeps A when the authority supplies %s', async (_reason, fields) => {
    const test = fixture(await record(1), () => record(2, fields));
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);
    readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });
    await drain(test);

    expect(held(test)?.header.seq).toBe(1);
    expect(copies.get(COPY_URL)?.headers.get('x-arkor-revision')).toBe('1');
  });

  it.each(['absent', 'reject', 'corrupt', 'oversized'] as const)(
    'keeps A and KV refreshes working when the authority is %s',
    async (kind) => {
      const authority = () => {
        if (kind === 'reject') return Promise.reject(new Error('authority unavailable'));
        if (kind === 'corrupt') return Promise.resolve(new ArrayBuffer(8));
        if (kind === 'oversized') return Promise.resolve(new ArrayBuffer(4 * 1024 * 1024 + 1));
        return Promise.resolve(undefined);
      };
      const test = fixture(await record(1), authority);
      await loadGeneration(test.edge, KEY, SETTINGS);
      await drain(test);

      test.clock.now += 1000;

      readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });
      await drain(test);

      expect(held(test)?.header.seq).toBe(1);
      expect(test.kv.get).toHaveBeenCalledTimes(2);
    },
  );

  it('finishes a timed-out background task and ignores its late B', async () => {
    const old = await record(1);
    const next = await record(2);
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const test = fixture(old, () => gate.promise);
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);
    vi.useFakeTimers();
    readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });
    await vi.advanceTimersByTimeAsync(2000);
    await drain(test);

    expect(held(test)?.header.seq).toBe(1);

    gate.resolve(next);
    await Promise.resolve();

    expect(held(test)?.header.seq).toBe(1);
  });

  it('does not adopt B when validation finishes after the background deadline', async () => {
    const old = await record(1);
    const next = await record(2);
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(packOf(next).html));
    const gate = Promise.withResolvers<ArrayBuffer>();
    const test = fixture(old, () => Promise.resolve(next));
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);
    vi.useFakeTimers();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => gate.promise);
    readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });
    await vi.advanceTimersByTimeAsync(2000);
    await drain(test);
    gate.resolve(digest);
    await vi.advanceTimersByTimeAsync(0);

    expect(held(test)?.header.seq).toBe(1);
    expect(copies.get(COPY_URL)?.headers.get('x-arkor-revision')).toBe('1');
  });

  it('bounds unanswered authority calls, including calls past their deadline', async () => {
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const authority = vi.fn(() => gate.promise);
    const test = fixture(await record(1), authority);
    vi.useFakeTimers();
    for (let entry = 0; entry < 5; entry += 1) {
      const entryId = `ent_${entry}`;
      const pack = packOf(await record(1, { entryId }));

      test.edge.runtime.memory.generations.set(
        kvGenerationKey(SCOPE, entryId),
        { pack, readAt: T0, bytes: 1024 },
        1024,
      );

      readServedAgain(test.edge, pack, SETTINGS, { servedStale: true });
    }
    await vi.advanceTimersByTimeAsync(2000);
    await drain(test);

    expect(authority).toHaveBeenCalledTimes(2);

    test.clock.now += 2000;

    const extra = packOf(await record(1, { entryId: 'ent_extra' }));

    test.edge.runtime.memory.generations.set(
      kvGenerationKey(SCOPE, 'ent_extra'),
      { pack: extra, readAt: T0, bytes: 1024 },
      1024,
    );

    readServedAgain(test.edge, extra, SETTINGS, { servedStale: true });
    await drain(test);

    expect(authority).toHaveBeenCalledTimes(2);

    gate.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);

    test.edge.runtime.memory.generations.set(
      kvGenerationKey(SCOPE, 'ent_extra'),
      { pack: extra, readAt: test.clock.now, bytes: 1024 },
      1024,
    );

    readServedAgain(test.edge, extra, SETTINGS, { servedStale: true });
    await drain(test);

    expect(authority).toHaveBeenCalledTimes(3);
  });

  it('asks the authority even when the ordinary hold refresh just renewed readAt', async () => {
    const authority = vi.fn(() => record(2));
    const test = fixture(await record(1), authority);
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);

    test.clock.now += SETTINGS.holdMs;

    const served = generation(await loadGeneration(test.edge, KEY, SETTINGS));
    readServedAgain(test.edge, served, SETTINGS, { servedStale: true });
    await drain(test);

    expect(authority).toHaveBeenCalledTimes(1);
    expect(held(test)?.header.seq).toBe(2);
  });

  it('adds no authority read to fresh loads or a different fresh entry', async () => {
    const authority = vi.fn(() => Promise.resolve(undefined));
    const test = fixture(await record(1, { cacheTimestamp: T0 }), authority);
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);

    test.clock.now += 1000;

    await loadGeneration(test.edge, KEY, SETTINGS);

    test.kv.bytes = await record(1, { entryId: 'ent_fresh', cacheTimestamp: T0 });

    await loadGeneration(test.edge, { scopeId: SCOPE, entryId: 'ent_fresh' }, SETTINGS);
    await drain(test);

    expect(authority).not.toHaveBeenCalled();
  });

  it('preserves KV-only hosts and the hold-zero measurement path', async () => {
    const old = await record(1);
    const test = fixture(old);
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);

    test.clock.now += 1000;

    readServedAgain(test.edge, held(test)!, SETTINGS, { servedStale: true });
    await drain(test);

    expect(test.kv.get).toHaveBeenCalledTimes(2);

    const authority = vi.fn(() => Promise.resolve(undefined));
    const noHold = fixture(old, authority);
    await loadGeneration(noHold.edge, KEY, { ...SETTINGS, holdMs: 0 });
    readServedAgain(noHold.edge, packOf(old), { ...SETTINGS, holdMs: 0 }, { servedStale: true });
    await drain(noHold);

    expect(authority).not.toHaveBeenCalled();
  });

  it('adds no authority read to the existing foreground-regeneration refresh', async () => {
    const authority = vi.fn(() => Promise.resolve(undefined));
    const test = fixture(await record(1), authority);
    await loadGeneration(test.edge, KEY, SETTINGS);
    await drain(test);

    test.clock.now += 1000;

    readServedAgain(test.edge, held(test)!, SETTINGS);
    await drain(test);

    expect(authority).not.toHaveBeenCalled();
    expect(test.kv.get).toHaveBeenCalledTimes(2);
  });
});
