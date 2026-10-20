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
  const request = (): EdgeContext => {
    return {
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
    };
  };
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
    const cadence = fixture();
    cadence.current.mockResolvedValueOnce(await freshRecord());

    await cadence.visit(0);

    expect(cadence.read()?.load.kind).toBe('generation');

    for (const elapsed of [5000, 30_000, MINUTE - 1]) await cadence.visit(elapsed);

    expect(cadence.current).toHaveBeenCalledTimes(1);

    await cadence.visit(MINUTE);

    expect(cadence.current).toHaveBeenCalledTimes(2);
    expect(cadence.current).toHaveBeenLastCalledWith(SCOPE, expect.any(String), 1);
    expect(cadence.read()?.load.kind).toBe('generation');
  });

  it('retries a failed fresh check after one second and restores the fresh cadence after an answer', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const cadence = fixture();
    cadence.current.mockResolvedValueOnce(await freshRecord());

    await cadence.visit(0);

    cadence.current.mockRejectedValueOnce(new Error('authority unavailable'));

    await cadence.visit(MINUTE);
    await cadence.visit(MINUTE + SECOND - 1);

    expect(cadence.current).toHaveBeenCalledTimes(2);
    expect(cadence.read()?.load.kind).toBe('generation');

    await cadence.visit(MINUTE + SECOND);

    expect(cadence.current).toHaveBeenCalledTimes(3);

    await cadence.visit(2 * MINUTE + SECOND - 1);

    expect(cadence.current).toHaveBeenCalledTimes(3);

    await cadence.visit(2 * MINUTE + SECOND);

    expect(cadence.current).toHaveBeenCalledTimes(4);
  });

  it('grows repeated absent intervals and caps the observed gaps at thirty seconds', async () => {
    const cadence = fixture();
    const reads: number[] = [];
    cadence.current.mockImplementation(() => {
      reads.push(cadence.clock.now - T0);
      return Promise.resolve(undefined);
    });

    for (let elapsed = 0; elapsed <= 600_000; elapsed += SECOND) await cadence.visit(elapsed);

    const gaps = reads.slice(1).map((at, index) => at - (reads[index] ?? 0));

    expect(reads.slice(0, 12)).toStrictEqual([
      0, 1000, 2000, 3000, 4000, 6000, 8000, 11_000, 15_000, 20_000, 27_000, 36_000,
    ]);
    expect(gaps).toStrictEqual(gaps.toSorted((before, after) => before - after));
    expect(gaps.slice(15)).toStrictEqual(Array.from({ length: gaps.length - 15 }, () => 30_000));
    expect(reads).toHaveLength(32);
  });

  it('finds a completion published after repeated misses within the capped interval', async () => {
    const cadence = fixture();

    for (let elapsed = 0; elapsed <= 120_000; elapsed += SECOND) await cadence.visit(elapsed);

    const before = cadence.current.mock.calls.length;
    cadence.current.mockResolvedValueOnce(await freshRecord());

    await cadence.visit(144_999);

    expect(cadence.current).toHaveBeenCalledTimes(before);
    expect(cadence.read()?.load.kind).toBe('none');

    await cadence.visit(145_000);

    expect(cadence.current).toHaveBeenCalledTimes(before + 1);
    expect(cadence.current).toHaveBeenLastCalledWith(SCOPE, expect.any(String), 0);
    expect(cadence.read()?.load).toMatchObject({
      kind: 'generation',
      pack: { header: { pathname: PATHNAME, revision: 1 } },
    });
  });

  it('retries a timed-out fresh check after its old RPC settles without waiting another minute', async () => {
    const cadence = fixture();
    cadence.current.mockResolvedValueOnce(await freshRecord());

    await cadence.visit(0);

    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    cadence.current.mockReturnValueOnce(gate.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'warn').mockReturnValue();
    try {
      cadence.clock.now = T0 + MINUTE;
      cadence.read()?.refresh();
      await vi.advanceTimersByTimeAsync(0);
      cadence.clock.now = T0 + MINUTE + SECOND - 1;
      await vi.advanceTimersByTimeAsync(SECOND - 1);

      expect(cadence.current).toHaveBeenCalledTimes(2);

      cadence.clock.now += 2;
      await vi.advanceTimersByTimeAsync(2);
      await cadence.drain();

      expect(cadence.read()?.load.kind).toBe('generation');

      gate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await cadence.visit(MINUTE + SECOND + 1);

      expect(cadence.current).toHaveBeenCalledTimes(3);
    } finally {
      gate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await cadence.drain();
    }
  });
});
