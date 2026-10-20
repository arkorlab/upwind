import { sha256Hex } from '@stayingupwind/core/artifact';
import { deriveEntry, encodeGenerationPack, policyFromBuild } from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { partialFallbackInHand } from '../src/cache/partial-fallback.ts';
import type { EdgeHost } from '../src/edge-host.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const SCOPE = 'dpl_partial_cadence';
const ROUTE = '/[slug]';
const PATHNAME = '/completed';
const T0 = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60_000;
const SETTINGS = { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'on' as const, holdMs: 5000 };
const ENTRY: RouteEntry = {
  pathname: ROUTE,
  status: 200,
  shell: {
    sha256: 'a'.repeat(64),
    byteLength: 1,
    contentType: 'text/html',
    encoding: 'identity',
  },
  headers: {},
  prerenderId: ROUTE,
  partialFallback: { route: ROUTE },
};
const MANIFEST = buildProjectManifest({
  projectId: 'site',
  runId: 'run_site',
  generatedAt: '2026-10-18T00:00:00.000Z',
  originHost: 'site.example',
  deployment: { assetSetHash: 'a'.repeat(64), observedAt: '2026-10-18T00:00:00.000Z' },
  routes: [ENTRY],
  app: { deploymentId: SCOPE, scriptName: 'site-app' },
  cache: { scopeId: SCOPE, keySchemaVersion: 1 },
});

/** The cadence reads the signal capability; this fixture must never ask it for a signal. */
const SIGNALS: NonNullable<EdgeHost['scopeSignals']> = {
  scopeSignals: () => Promise.reject(new Error('no signal request belongs in this fixture')),
  cacheTagOf: (scopeId) => scopeId,
};

function fixture() {
  const clock = { now: T0 };
  const memory = createEdgeMemory(() => clock.now);
  const tasks: Promise<unknown>[] = [];
  const current = vi.fn<NonNullable<EdgeHost['currentRecord']>>().mockResolvedValue(undefined);
  const ctx = createExecutionContext();
  vi.spyOn(ctx, 'waitUntil').mockImplementation((task) => {
    tasks.push(task);
  });
  const request = (): EdgeContext => ({
    env,
    ctx,
    runtime: standaloneRuntime(env, { now: () => clock.now, memory }),
    host: {
      ...standaloneHost(env),
      currentRecord: current,
      scopeSignals: SIGNALS,
    },
    forwarding: {
      previewDomain: 'example.test',
      previewHost: 'site.example',
      clientIp: undefined,
    },
    app: undefined,
    originalUrl: undefined,
    policy: { ...DEFAULT_DELIVERY_POLICY, runtimeCache: SETTINGS },
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: false,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: 'a'.repeat(64),
    colo: 'NRT',
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: 0 },
  });
  const read = () => partialFallbackInHand(request(), MANIFEST, ENTRY, PATHNAME);
  const drain = async (): Promise<void> => {
    while (tasks.length > 0) await Promise.all(tasks.splice(0));
  };
  return {
    clock,
    current,
    read,
    drain,
    visit: async (elapsed: number): Promise<void> => {
      clock.now = T0 + elapsed;
      read()?.refresh();
      await drain();
    },
  };
}

/** A genuine, digest-verified completion that remains fresh throughout the cadence cases. */
async function freshRecord(): Promise<ArrayBuffer> {
  const html = encodeUtf8('completed behind the build shell');
  const { entryId } = await deriveEntry(SCOPE, {
    kind: 'app-page',
    route: ROUTE,
    pathname: PATHNAME,
  });
  const digest = await sha256Hex(html);
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: 'gen_completed',
      seq: 1,
      revision: 1,
      source: 'runtime',
      kind: 'app-page',
      route: ROUTE,
      pathname: PATHNAME,
      cacheTimestamp: T0,
      producedAt: T0,
      policy: policyFromBuild({ initialRevalidate: 3600, initialExpiration: 86_400 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: digest,
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    html,
    undefined,
  );
  return new Uint8Array(bytes).buffer;
}

describe('partial completion refresh cadence through the real reader', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits until the exact minute boundary before rereading a fresh signalled completion', async () => {
    const test = fixture();
    test.current.mockResolvedValueOnce(await freshRecord());

    await test.visit(0);

    expect(test.read()?.load.kind).toBe('generation');

    for (const elapsed of [5000, 30_000, MINUTE - 1]) await test.visit(elapsed);

    expect(test.current).toHaveBeenCalledTimes(1);

    await test.visit(MINUTE);

    expect(test.current).toHaveBeenCalledTimes(2);
    expect(test.current).toHaveBeenLastCalledWith(SCOPE, expect.any(String), 1);
    expect(test.read()?.load.kind).toBe('generation');
  });

  it('retries a failed fresh check after one second and restores the fresh cadence after an answer', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const test = fixture();
    test.current.mockResolvedValueOnce(await freshRecord());

    await test.visit(0);

    test.current.mockRejectedValueOnce(new Error('authority unavailable'));

    await test.visit(MINUTE);
    await test.visit(MINUTE + SECOND - 1);

    expect(test.current).toHaveBeenCalledTimes(2);
    expect(test.read()?.load.kind).toBe('generation');

    await test.visit(MINUTE + SECOND);

    expect(test.current).toHaveBeenCalledTimes(3);

    await test.visit(2 * MINUTE + SECOND - 1);

    expect(test.current).toHaveBeenCalledTimes(3);

    await test.visit(2 * MINUTE + SECOND);

    expect(test.current).toHaveBeenCalledTimes(4);
  });

  it('grows repeated absent intervals and caps the observed gaps at thirty seconds', async () => {
    const test = fixture();
    const reads: number[] = [];
    test.current.mockImplementation(() => {
      reads.push(test.clock.now - T0);
      return Promise.resolve(undefined);
    });

    for (let elapsed = 0; elapsed <= 600_000; elapsed += SECOND) await test.visit(elapsed);

    const gaps = reads.slice(1).map((at, index) => at - (reads[index] ?? 0));

    expect(reads.slice(0, 12)).toStrictEqual([
      0, 1000, 2000, 3000, 4000, 6000, 8000, 11_000, 15_000, 20_000, 27_000, 36_000,
    ]);
    expect(gaps).toStrictEqual(gaps.toSorted((before, after) => before - after));
    expect(gaps.slice(15)).toStrictEqual(Array.from({ length: gaps.length - 15 }, () => 30_000));
    expect(reads).toHaveLength(32);
  });

  it('finds a completion published after repeated misses within the capped interval', async () => {
    const test = fixture();

    for (let elapsed = 0; elapsed <= 120_000; elapsed += SECOND) await test.visit(elapsed);

    const before = test.current.mock.calls.length;
    test.current.mockResolvedValueOnce(await freshRecord());

    await test.visit(144_999);

    expect(test.current).toHaveBeenCalledTimes(before);
    expect(test.read()?.load.kind).toBe('none');

    await test.visit(145_000);

    expect(test.current).toHaveBeenCalledTimes(before + 1);
    expect(test.current).toHaveBeenLastCalledWith(SCOPE, expect.any(String), 0);
    expect(test.read()?.load).toMatchObject({
      kind: 'generation',
      pack: { header: { pathname: PATHNAME, revision: 1 } },
    });
  });

  it('retries a timed-out fresh check after its old RPC settles without waiting another minute', async () => {
    const test = fixture();
    test.current.mockResolvedValueOnce(await freshRecord());

    await test.visit(0);

    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    test.current.mockReturnValueOnce(gate.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'warn').mockReturnValue();
    try {
      test.clock.now = T0 + MINUTE;
      test.read()?.refresh();
      await vi.advanceTimersByTimeAsync(0);
      test.clock.now = T0 + MINUTE + SECOND - 1;
      await vi.advanceTimersByTimeAsync(SECOND - 1);

      expect(test.current).toHaveBeenCalledTimes(2);

      test.clock.now += 2;
      await vi.advanceTimersByTimeAsync(2);
      await test.drain();

      expect(test.read()?.load.kind).toBe('generation');

      gate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await test.visit(MINUTE + SECOND + 1);

      expect(test.current).toHaveBeenCalledTimes(3);
    } finally {
      gate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await test.drain();
    }
  });
});
