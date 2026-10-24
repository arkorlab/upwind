import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  type GenerationPackHeader,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { ProjectManifest, RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_RUNTIME_CACHE_SETTINGS } from '@stayingupwind/host/delivery';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { takeInvalidation } from '../src/cache/condemned.ts';
import { readCurrentBehind } from '../src/cache/generation-current.ts';
import { readGeneration } from '../src/cache/generation-loader.ts';
import { partialFallbackInHand } from '../src/cache/partial-fallback.ts';
import type { EdgeHost } from '../src/edge-host.ts';
import { createEdgeMemory, memberEntryKey } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const SCOPE = 'dpl_partial';
const ROUTE = '/[slug]';
const T0 = 1_800_000_000_000;
const SETTINGS = { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'on' as const, holdMs: 5000 };
const MANIFEST = { cache: { scopeId: SCOPE } } as ProjectManifest;
const ENTRY = { pathname: ROUTE, partialFallback: { route: ROUTE } } as RouteEntry;
const TAG = 'partial-page';

async function record(seq = 1, fields: Partial<GenerationPackHeader> = {}) {
  const pathname = fields.pathname ?? '/two';
  const route = fields.route ?? ROUTE;
  const { entryId } = await deriveEntry(SCOPE, { kind: 'app-page', route, pathname });
  const html = new TextEncoder().encode(`completed ${pathname}`);
  const header: GenerationPackHeader = {
    schemaVersion: 1,
    scopeId: SCOPE,
    entryId,
    generationId: `gen_${seq}`,
    seq,
    revision: seq,
    source: 'runtime',
    kind: 'app-page',
    route,
    pathname,
    cacheTimestamp: T0,
    producedAt: T0,
    policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 300 }),
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

/** A host that gives the scope's signals, which bring an isolate the scope's invalidations. */
const SIGNALS: NonNullable<EdgeHost['scopeSignals']> = {
  scopeSignals: () => Promise.reject(new Error('not asked in these tests')),
  cacheTagOf: (scopeId) => scopeId,
};

function fixture(
  currentRecord: NonNullable<EdgeHost['currentRecord']>,
  scopeSignals?: EdgeHost['scopeSignals'],
  settings = SETTINGS,
) {
  const clock = { now: T0 };
  const tasks: Promise<unknown>[] = [];
  const kv = vi.fn<() => Promise<ArrayBuffer | null>>(() => Promise.resolve(null));
  const edge = {
    env: { CACHE_STATE: { get: kv } },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    runtime: { now: () => clock.now, memory: createEdgeMemory(() => clock.now) },
    policy: { runtimeCache: settings },
    host: { currentRecord, scopeSignals },
    validated: false,
    app: undefined,
  } as unknown as EdgeContext;
  const drain = async (): Promise<void> => {
    while (tasks.length > 0) await Promise.all(tasks.splice(0));
  };
  return {
    edge,
    clock,
    tasks,
    kv,
    read: (pathname = '/two', entry = ENTRY) =>
      partialFallbackInHand(edge, MANIFEST, entry, pathname),
    drain,
    /** A request for `/two` at `elapsed` past T0, and the read it sets off behind it, done. */
    visit: async (elapsed: number): Promise<void> => {
      clock.now = T0 + elapsed;
      partialFallbackInHand(edge, MANIFEST, ENTRY, '/two')?.refresh();
      await drain();
    },
  };
}

describe('completed partial shells behind build delivery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the build immediately, then adopts the authority record without reading a KV absence', async () => {
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const host = vi.fn(() => gate.promise);
    const test = fixture(host);
    const initial = test.read();

    expect(host).not.toHaveBeenCalled();

    initial?.refresh();

    expect(test.read()?.load.kind).toBe('none');

    gate.resolve(await record());

    await test.drain();

    expect(test.read()?.load).toMatchObject({
      kind: 'generation',
      pack: { header: { pathname: '/two' } },
    });
    expect(host).toHaveBeenCalledWith(SCOPE, expect.any(String), 0);

    test.clock.now += 5001;

    test.read()?.refresh();

    await test.drain();

    expect(test.read()?.load.kind).toBe('generation');
    expect(host).toHaveBeenLastCalledWith(SCOPE, expect.any(String), 1);
    expect(test.kv).not.toHaveBeenCalled();
    expect(test.read('/three')?.load.kind).toBe('none');
  });

  it('keys only the parameters Next.js can prerender', async () => {
    const entry = {
      ...ENTRY,
      pathname: '/prefix/[one]/[two]',
      partialFallback: { route: '/prefix/[one]/[two]', keyedBy: ['one'] },
    };
    const host = vi.fn(() => record(1, { route: entry.pathname, pathname: '/prefix/c/[two]' }));
    const test = fixture(host);

    test.read('/prefix/c/foo', entry)?.refresh();

    await test.drain();

    expect(test.read('/prefix/c/bar', entry)?.load).toMatchObject({
      kind: 'generation',
      pack: { header: { pathname: '/prefix/c/[two]' } },
    });
    expect(test.read('/prefix/d/foo', entry)?.load.kind).toBe('none');
  });

  it.each([1001, 2001])(
    'refreshes a stale or expired record without waiting out a fresh hold (%i ms)',
    async (elapsed) => {
      const policy = policyFromBuild({ initialRevalidate: 2, initialExpiration: 3 });
      const host = vi
        .fn<NonNullable<EdgeHost['currentRecord']>>()
        .mockResolvedValue(await record(1, { policy }));
      const test = fixture(host);

      test.read()?.refresh();

      await test.drain();

      test.clock.now += 1001;

      test.read()?.refresh();

      await test.drain();

      expect(host).toHaveBeenCalledTimes(1);

      test.clock.now += elapsed;

      host.mockResolvedValueOnce(await record(2, { policy, cacheTimestamp: test.clock.now }));

      test.read()?.refresh();

      await test.drain();

      expect(host).toHaveBeenCalledTimes(2);
      expect(host).toHaveBeenLastCalledWith(SCOPE, expect.any(String), 1);
      expect(test.read()?.load).toMatchObject({
        kind: 'generation',
        pack: { header: { revision: 2 } },
      });
      expect(test.kv).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['scope', { scopeId: 'other' }],
    ['entry', { entryId: 'other' }],
    ['digest', { htmlSha256: '0'.repeat(64) }],
  ] as const)('does not adopt a record with a wrong %s', async (_label, fields) => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const test = fixture(() => record(1, fields));

    test.read()?.refresh();

    await test.drain();

    expect(test.read()?.load.kind).toBe('none');
  });

  it('retains the held generation when the authority cannot return a record or rejects', async () => {
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>().mockResolvedValue(await record());
    const test = fixture(host);

    test.read()?.refresh();

    await test.drain();

    host.mockRejectedValueOnce(new Error('unavailable'));
    vi.spyOn(console, 'warn').mockReturnValue();

    test.clock.now += 5001;

    test.read()?.refresh();

    await test.drain();

    expect(test.read()?.load.kind).toBe('generation');

    host.mockResolvedValueOnce(undefined);

    test.clock.now += 5001;

    test.read()?.refresh();

    await test.drain();

    expect(test.read()?.load.kind).toBe('generation');
  });

  it('does not erase a later generation when an unavailable response arrives late', async () => {
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>().mockResolvedValue(await record());
    const test = fixture(host);

    test.read()?.refresh();

    await test.drain();

    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    host.mockReturnValueOnce(gate.promise);

    test.clock.now += 5001;

    test.read()?.refresh();

    await vi.waitFor(() => {
      expect(host).toHaveBeenCalledTimes(2);
    });
    const key = test.read()?.key;

    expect(key).toBeDefined();

    test.kv.mockResolvedValueOnce(await record(3));

    await readGeneration(test.edge, key!, SETTINGS);

    gate.resolve(undefined);

    await test.drain();

    expect(test.read()?.load).toMatchObject({
      kind: 'generation',
      pack: { header: { revision: 3 } },
    });
  });

  it('does not let an older B replace C adopted while its read was pending', async () => {
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>().mockResolvedValue(await record());
    const test = fixture(host);

    test.read()?.refresh();

    await test.drain();

    host.mockReturnValueOnce(gate.promise);

    test.clock.now += 5001;

    test.read()?.refresh();

    await vi.waitFor(() => {
      expect(host).toHaveBeenCalledTimes(2);
    });

    const key = test.read()?.key;

    expect(key).toBeDefined();

    test.kv.mockResolvedValueOnce(await record(3));

    await readGeneration(test.edge, key!, SETTINGS);

    gate.resolve(await record(2));

    await test.drain();

    expect(test.read()?.load).toMatchObject({
      kind: 'generation',
      pack: { header: { seq: 3, revision: 3 } },
    });
  });

  it('does not adopt a record invalidated while its digest is being verified', async () => {
    const bytes = await record(2, { tags: [{ kind: 'next-explicit', value: TAG }] });
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(packOf(bytes).html));
    const gate = Promise.withResolvers<ArrayBuffer>();
    const digesting = Promise.withResolvers<undefined>();
    const host = vi.fn(() => Promise.resolve(bytes));
    const test = fixture(host);
    const { entryId } = await deriveEntry(SCOPE, {
      kind: 'app-page',
      route: ROUTE,
      pathname: '/two',
    });

    test.edge.runtime.memory.memberEntries.set(memberEntryKey(SCOPE, ROUTE, '/two'), entryId);

    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => {
      digesting.resolve(undefined);
      return gate.promise;
    });

    test.read()?.refresh();

    await digesting.promise;

    takeInvalidation(test.edge.runtime.memory, SCOPE, { value: TAG, bound: '3' });
    gate.resolve(digest);

    await test.drain();

    expect(test.read()?.load.kind).toBe('none');
    expect(host).toHaveBeenCalledTimes(1);
    expect(test.kv).not.toHaveBeenCalled();
  });

  it('does not resurrect a held record after its tag was invalidated', async () => {
    const bytes = await record(1, { tags: [{ kind: 'next-explicit', value: TAG }] });
    const test = fixture(() => Promise.resolve(bytes));

    test.read()?.refresh();

    await test.drain();

    expect(test.read()?.load.kind).toBe('generation');

    takeInvalidation(test.edge.runtime.memory, SCOPE, { value: TAG, bound: '2' });

    expect(test.read()?.load.kind).toBe('none');

    test.clock.now += 5001;

    test.read()?.refresh();

    await test.drain();

    expect(test.read()?.load.kind).toBe('none');
    expect(test.kv).not.toHaveBeenCalled();
  });

  it('shares the two-record budget with ordinary stale generation refreshes', async () => {
    const normal = packOf(await record(1, { pathname: '/normal' }));
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const host = vi.fn(() => gate.promise);
    const test = fixture(host);
    for (const pathname of ['/two', '/three']) {
      const { entryId } = await deriveEntry(SCOPE, { kind: 'app-page', route: ROUTE, pathname });

      test.edge.runtime.memory.memberEntries.set(memberEntryKey(SCOPE, ROUTE, pathname), entryId);
    }

    readCurrentBehind(test.edge, normal, SETTINGS, 1000);

    test.read('/two')?.refresh();

    await vi.waitFor(() => {
      expect(host).toHaveBeenCalledTimes(2);
    });

    test.read('/three')?.refresh();

    await Promise.resolve();
    await Promise.resolve();

    expect(host).toHaveBeenCalledTimes(2);

    gate.resolve(undefined);

    await test.drain();
  });

  it('bounds unanswered reads and rejects adoption after the deadline', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const gates = [
      Promise.withResolvers<ArrayBuffer | undefined>(),
      Promise.withResolvers<ArrayBuffer | undefined>(),
    ];
    let calls = 0;
    const host = vi.fn(() => {
      const gate = gates[calls];
      calls += 1;
      return gate?.promise ?? Promise.resolve(undefined);
    });
    const test = fixture(host);
    const lateBytes = await record();
    for (const pathname of ['/two', '/three', '/four']) {
      const { entryId } = await deriveEntry(SCOPE, { kind: 'app-page', route: ROUTE, pathname });

      test.edge.runtime.memory.memberEntries.set(memberEntryKey(SCOPE, ROUTE, pathname), entryId);
    }
    vi.useFakeTimers();

    test.read('/two')?.refresh();

    test.read('/three')?.refresh();

    await vi.advanceTimersByTimeAsync(0);

    expect(host).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1001);

    await test.drain();

    test.clock.now += 5001;

    test.read('/four')?.refresh();

    await vi.advanceTimersByTimeAsync(0);

    expect(host).toHaveBeenCalledTimes(2);

    gates[0]?.resolve(lateBytes);
    gates[1]?.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(test.read()?.load.kind).toBe('none');
  });

  it('reads a fresh completion again once a minute where the scope signals reach the isolate', async () => {
    const policy = policyFromBuild({ initialRevalidate: 3600, initialExpiration: 86_400 });
    const host = vi
      .fn<NonNullable<EdgeHost['currentRecord']>>()
      .mockResolvedValue(await record(1, { policy }));
    const test = fixture(host, SIGNALS);

    test.read()?.refresh();

    await test.drain();

    expect(test.read()?.load.kind).toBe('generation');

    host.mockResolvedValue(undefined);
    for (const elapsed of [5001, 30_000, 59_999]) {
      test.clock.now = T0 + elapsed;

      test.read()?.refresh();

      await test.drain();
    }

    expect(host).toHaveBeenCalledTimes(1);

    test.clock.now = T0 + 60_000;

    test.read()?.refresh();

    await test.drain();

    expect(host).toHaveBeenCalledTimes(2);
    expect(host).toHaveBeenLastCalledWith(SCOPE, expect.any(String), 1);
    expect(test.read()?.load.kind).toBe('generation');
  });

  it('reads a fresh completion again a second after a read the authority failed, not a minute on', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const policy = policyFromBuild({ initialRevalidate: 3600, initialExpiration: 86_400 });
    const host = vi
      .fn<NonNullable<EdgeHost['currentRecord']>>()
      .mockResolvedValue(await record(1, { policy }));
    const test = fixture(host, SIGNALS);

    await test.visit(0);

    host.mockRejectedValueOnce(new Error('unavailable'));

    await test.visit(60_000);

    expect(host).toHaveBeenCalledTimes(2);
    expect(test.read()?.load.kind).toBe('generation');

    host.mockResolvedValue(undefined);

    await test.visit(60_999);

    expect(host).toHaveBeenCalledTimes(2);

    await test.visit(61_000);

    expect(host).toHaveBeenCalledTimes(3);

    for (const elapsed of [62_000, 90_000, 120_999]) await test.visit(elapsed);

    expect(host).toHaveBeenCalledTimes(3);

    await test.visit(121_000);

    expect(host).toHaveBeenCalledTimes(4);
  });

  it('keeps a completion found fresh unread for a hold longer than a minute', async () => {
    const policy = policyFromBuild({ initialRevalidate: 3600, initialExpiration: 86_400 });
    const host = vi
      .fn<NonNullable<EdgeHost['currentRecord']>>()
      .mockResolvedValue(await record(1, { policy }));
    const test = fixture(host, SIGNALS, { ...SETTINGS, holdMs: 120_000 });

    await test.visit(0);

    expect(test.read()?.load.kind).toBe('generation');

    host.mockResolvedValue(undefined);

    await test.visit(61_000);

    expect(host).toHaveBeenCalledTimes(1);

    await test.visit(120_000);

    expect(host).toHaveBeenCalledTimes(2);
  });

  it('reads a stale completion again a second on', async () => {
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>().mockResolvedValue(await record());
    const test = fixture(host, SIGNALS);

    test.read()?.refresh();

    await test.drain();

    host.mockResolvedValue(undefined);
    for (const elapsed of [61_000, 61_999]) {
      test.clock.now = T0 + elapsed;

      test.read()?.refresh();

      await test.drain();
    }

    expect(host).toHaveBeenCalledTimes(2);

    test.clock.now = T0 + 62_000;

    test.read()?.refresh();

    await test.drain();

    expect(host).toHaveBeenCalledTimes(3);
    expect(test.read()?.load.kind).toBe('generation');
  });

  it('reads a completion not yet found less often the longer it goes unfound', async () => {
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => Promise.resolve(undefined));
    const test = fixture(host, SIGNALS);
    const reads: number[] = [];
    for (let elapsed = 0; elapsed <= 600_000; elapsed += 1000) {
      const before = host.mock.calls.length;

      test.clock.now = T0 + elapsed;

      test.read()?.refresh();

      await test.drain();

      if (host.mock.calls.length > before) reads.push(elapsed);
    }
    const gaps = reads.slice(1).map((at, index) => at - reads[index]!);

    expect(reads.slice(0, 12)).toStrictEqual([
      0, 1000, 2000, 3000, 4000, 6000, 8000, 11_000, 15_000, 20_000, 27_000, 36_000,
    ]);
    expect(gaps).toStrictEqual(gaps.toSorted((a, b) => a - b));
    expect(gaps.slice(15)).toStrictEqual(Array.from({ length: gaps.length - 15 }, () => 30_000));
    expect(reads).toHaveLength(32);
  });

  it('reads less often a completion whose only record the authority answers with is refused', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const bytes = await record(1, { htmlSha256: '0'.repeat(64) });
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => Promise.resolve(bytes));
    const test = fixture(host, SIGNALS);
    for (let elapsed = 0; elapsed <= 600_000; elapsed += 1000) await test.visit(elapsed);

    expect(test.read()?.load.kind).toBe('none');
    expect(host).toHaveBeenCalledTimes(32);
  });

  it('reads a completion lost again a second on, not where its first absence had got to', async () => {
    const policy = policyFromBuild({ initialRevalidate: 3600, initialExpiration: 86_400 });
    const bytes = await record(1, { policy, tags: [{ kind: 'next-explicit', value: TAG }] });
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => Promise.resolve(undefined));
    const test = fixture(host, SIGNALS);
    let elapsed = 0;
    for (; elapsed <= 90_000; elapsed += 1000) await test.visit(elapsed);
    host.mockResolvedValue(bytes);
    const before = host.mock.calls.length;
    for (let tries = 0; tries < 60 && host.mock.calls.length === before; tries++) {
      elapsed += 1000;

      await test.visit(elapsed);
    }

    expect(test.read()?.load.kind).toBe('generation');

    takeInvalidation(test.edge.runtime.memory, SCOPE, { value: TAG, bound: '2' });
    host.mockResolvedValue(undefined);
    elapsed += 1000;

    await test.visit(elapsed);

    expect(host).toHaveBeenCalledTimes(before + 2);
  });

  it('ends the absence of a completion another read brought in once a request finds it held', async () => {
    const policy = policyFromBuild({ initialRevalidate: 3600, initialExpiration: 86_400 });
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => Promise.resolve(undefined));
    const test = fixture(host, SIGNALS);
    let elapsed = 0;
    for (; elapsed <= 90_000; elapsed += 1000) await test.visit(elapsed);
    const key = test.read()?.key;

    expect(key).toBeDefined();

    test.kv.mockResolvedValueOnce(
      await record(1, { policy, tags: [{ kind: 'next-explicit', value: TAG }] }),
    );

    await readGeneration(test.edge, key!, SETTINGS);
    const before = host.mock.calls.length;

    await test.visit(elapsed);

    expect(test.read()?.load.kind).toBe('generation');
    expect(host).toHaveBeenCalledTimes(before);

    takeInvalidation(test.edge.runtime.memory, SCOPE, { value: TAG, bound: '2' });
    elapsed += 1000;

    await test.visit(elapsed);

    expect(host).toHaveBeenCalledTimes(before + 1);
  });

  it('keeps reads a second apart while the authority fails, backing off from its first answer of none', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() =>
      Promise.reject(new Error('unavailable')),
    );
    const test = fixture(host, SIGNALS);
    for (let elapsed = 0; elapsed <= 30_000; elapsed += 1000) await test.visit(elapsed);

    expect(host).toHaveBeenCalledTimes(31);

    host.mockResolvedValue(undefined);
    for (let elapsed = 31_000; elapsed <= 35_000; elapsed += 1000) await test.visit(elapsed);

    expect(host).toHaveBeenCalledTimes(36);
  });

  it('keeps reads two seconds apart while every answer comes past its deadline', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const { entryId } = await deriveEntry(SCOPE, {
      kind: 'app-page',
      route: ROUTE,
      pathname: '/two',
    });
    vi.useFakeTimers();
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, 1500);
      });
    });
    const test = fixture(host, SIGNALS);

    test.edge.runtime.memory.memberEntries.set(memberEntryKey(SCOPE, ROUTE, '/two'), entryId);

    for (let elapsed = 0; elapsed <= 30_000; elapsed += 2000) {
      test.clock.now = T0 + elapsed;

      test.read()?.refresh();

      await vi.advanceTimersByTimeAsync(2000);

      await test.drain();
    }

    expect(host).toHaveBeenCalledTimes(16);
  });

  it('begins the absence again when a read passes its deadline', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const { entryId } = await deriveEntry(SCOPE, {
      kind: 'app-page',
      route: ROUTE,
      pathname: '/two',
    });
    vi.useFakeTimers();
    let late = false;
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => {
      if (!late) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, 1500);
      });
    });
    const test = fixture(host, SIGNALS);

    test.edge.runtime.memory.memberEntries.set(memberEntryKey(SCOPE, ROUTE, '/two'), entryId);

    const visit = async (at: number): Promise<void> => {
      test.clock.now = T0 + at;

      test.read()?.refresh();

      await vi.advanceTimersByTimeAsync(2000);

      await test.drain();
    };
    let elapsed = 0;
    for (; elapsed <= 60_000; elapsed += 2000) await visit(elapsed);
    late = true;
    const before = host.mock.calls.length;
    for (; host.mock.calls.length === before && elapsed < 120_000; elapsed += 2000) {
      await visit(elapsed);
    }
    late = false;
    const timedOut = host.mock.calls.length;
    await visit(elapsed);

    expect(timedOut).toBe(before + 1);
    expect(host).toHaveBeenCalledTimes(timedOut + 1);
  });

  it('keeps reading a second apart a completion the authority holds invalidated', async () => {
    const policy = policyFromBuild({ initialRevalidate: 3600, initialExpiration: 86_400 });
    const bytes = await record(1, { policy, tags: [{ kind: 'next-explicit', value: TAG }] });
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => Promise.resolve(bytes));
    const test = fixture(host, SIGNALS);

    takeInvalidation(test.edge.runtime.memory, SCOPE, { value: TAG, bound: '2' });

    for (let elapsed = 0; elapsed <= 30_000; elapsed += 1000) await test.visit(elapsed);

    expect(test.read()?.load.kind).toBe('none');
    expect(host).toHaveBeenCalledTimes(31);
  });

  it('does not restore an absence a request ended while the read was out', async () => {
    const policy = policyFromBuild({ initialRevalidate: 3600, initialExpiration: 86_400 });
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => Promise.resolve(undefined));
    const test = fixture(host, SIGNALS);
    for (let elapsed = 0; elapsed <= 40_000; elapsed += 1000) await test.visit(elapsed);
    const key = test.read()?.key;

    expect(key).toBeDefined();

    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    host.mockReturnValueOnce(gate.promise);
    const started = host.mock.calls.length;

    test.clock.now = T0 + 70_000;

    test.read()?.refresh();

    await vi.waitFor(() => {
      expect(host).toHaveBeenCalledTimes(started + 1);
    });

    test.kv.mockResolvedValueOnce(await record(1, { policy }));

    await readGeneration(test.edge, key!, SETTINGS);

    test.clock.now = T0 + 70_500;

    test.read()?.refresh();

    test.edge.runtime.memory.generations.delete(kvGenerationKey(SCOPE, key!.entryId));

    gate.resolve(undefined);

    await test.drain();

    const before = host.mock.calls.length;

    await test.visit(72_000);

    expect(host).toHaveBeenCalledTimes(before + 1);
  });

  it('keeps the cadence of two thousand completions read in turn', async () => {
    const host = vi.fn<NonNullable<EdgeHost['currentRecord']>>(() => Promise.resolve(undefined));
    const test = fixture(host, SIGNALS);
    const pathnames = Array.from({ length: 2000 }, (_, index) => `/member-${String(index)}`);
    const round = async (): Promise<void> => {
      for (const pathname of pathnames) {
        test.read(pathname)?.refresh();

        await test.drain();
      }
    };
    await round();

    expect(host).toHaveBeenCalledTimes(2000);

    test.clock.now += 500;

    await round();

    expect(host).toHaveBeenCalledTimes(2000);
  });

  it('ignores ordinary shells, validation and disabled generations', () => {
    const host = vi.fn(() => Promise.resolve(undefined));
    const test = fixture(host);

    expect(test.read('/two', { ...ENTRY, partialFallback: undefined })).toBeUndefined();
    expect(
      partialFallbackInHand({ ...test.edge, validated: true }, MANIFEST, ENTRY, '/two'),
    ).toBeUndefined();
    expect(
      partialFallbackInHand(
        {
          ...test.edge,
          policy: { ...test.edge.policy, runtimeCache: { ...SETTINGS, generations: 'off' } },
        },
        MANIFEST,
        ENTRY,
        '/two',
      ),
    ).toBeUndefined();
    expect(host).not.toHaveBeenCalled();
  });
});
