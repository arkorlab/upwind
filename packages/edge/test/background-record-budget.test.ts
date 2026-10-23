import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimBackgroundRecord } from '../src/cache/background-record-budget.ts';
import { readCurrentBehind } from '../src/cache/generation-current.ts';
import { partialFallbackInHand } from '../src/cache/partial-fallback.ts';
import type { EdgeHost } from '../src/edge-host.ts';
import { createEdgeMemory, memberEntryKey } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const SCOPE = 'dpl_background';
const ROUTE = '/[slug]';
const NOW = 1_800_000_000_000;
const READ_MS = 1000;
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

/** Every request makes a runtime wrapper; all wrappers of an isolate retain its memory. */
function fixture() {
  const clock = { now: NOW };
  const memory = createEdgeMemory(() => clock.now);
  const tasks: Promise<unknown>[] = [];
  const current = vi.fn<NonNullable<EdgeHost['currentRecord']>>().mockResolvedValue(undefined);
  const request = (): EdgeContext => {
    const ctx = createExecutionContext();
    vi.spyOn(ctx, 'waitUntil').mockImplementation((task) => {
      tasks.push(task);
    });
    return {
      env,
      ctx,
      runtime: standaloneRuntime(env, { now: () => clock.now, memory }),
      host: { ...standaloneHost(env), currentRecord: current },
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
  return {
    clock,
    memory,
    current,
    request,
    drain: async () => {
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
    },
  };
}

async function memoize(test: ReturnType<typeof fixture>, pathname: string): Promise<void> {
  const { entryId } = await deriveEntry(SCOPE, { kind: 'app-page', route: ROUTE, pathname });

  test.memory.memberEntries.set(memberEntryKey(SCOPE, ROUTE, pathname), entryId);
}

async function staleRecord() {
  const html = encodeUtf8('an ordinary generation');
  const { entryId } = await deriveEntry(SCOPE, {
    kind: 'app-page',
    route: ROUTE,
    pathname: '/ordinary',
  });
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: 'gen_ordinary',
      seq: 1,
      revision: 1,
      source: 'runtime',
      kind: 'app-page',
      route: ROUTE,
      pathname: '/ordinary',
      cacheTimestamp: NOW - 2000,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 1, initialExpiration: 300 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    html,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('the record must decode');
  return decoded.pack;
}

function partial(edge: EdgeContext, pathname: string): void {
  partialFallbackInHand(edge, MANIFEST, ENTRY, pathname)?.refresh();
}

describe('background record reads across request runtime wrappers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shares pending keys and both slots with the isolate, with separate isolate room', () => {
    const test = fixture();
    const first = claimBackgroundRecord(test.request().runtime, 'one');
    const second = claimBackgroundRecord(test.request().runtime, 'two');
    const isolated = claimBackgroundRecord(fixture().request().runtime, 'one');

    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');
    expect(isolated).toBeTypeOf('function');
    expect(claimBackgroundRecord(test.request().runtime, 'one')).toBeUndefined();
    expect(claimBackgroundRecord(test.request().runtime, 'three')).toBeUndefined();

    first?.();
    const next = claimBackgroundRecord(test.request().runtime, 'three');

    expect(next).toBeTypeOf('function');

    second?.();
    isolated?.();
    next?.();
  });

  it('keeps a partial completion cadence after one request ends', async () => {
    const test = fixture();
    await memoize(test, '/completed');

    partial(test.request(), '/completed');

    expect(test.current).not.toHaveBeenCalled();

    await test.drain();

    partial(test.request(), '/completed');

    await test.drain();

    expect(test.current).toHaveBeenCalledTimes(1);

    test.clock.now += READ_MS + 1;

    partial(test.request(), '/completed');

    await test.drain();

    expect(test.current).toHaveBeenCalledTimes(2);
  });

  it('retains the ordinary stale-record cadence across request wrappers', async () => {
    const pack = await staleRecord();
    const test = fixture();
    readCurrentBehind(test.request(), pack, SETTINGS, READ_MS);

    await test.drain();

    readCurrentBehind(test.request(), pack, SETTINGS, READ_MS);

    await test.drain();

    expect(test.current).toHaveBeenCalledTimes(1);

    test.clock.now += READ_MS + 1;

    readCurrentBehind(test.request(), pack, SETTINGS, READ_MS);

    await test.drain();

    expect(test.current).toHaveBeenCalledTimes(2);
  });

  it('holds the shared ordinary/partial slots after a deadline until each RPC settles', async () => {
    const pack = await staleRecord();
    const test = fixture();
    await memoize(test, '/first');
    await memoize(test, '/second');
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<ArrayBuffer | undefined>());
    let dispatched = 0;

    test.current.mockImplementation(() => {
      const answer = gates[dispatched];
      dispatched += 1;
      return answer?.promise ?? Promise.resolve(undefined);
    });

    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockReturnValue();
    try {
      readCurrentBehind(test.request(), pack, SETTINGS, READ_MS);
      partial(test.request(), '/first');
      await vi.advanceTimersByTimeAsync(0);
      partial(test.request(), '/second');
      await vi.advanceTimersByTimeAsync(0);

      expect(test.current).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      await test.drain();

      test.clock.now += SETTINGS.holdMs + 1;

      partial(test.request(), '/second');
      await vi.advanceTimersByTimeAsync(0);

      expect(test.current).toHaveBeenCalledTimes(2);

      gates[0]?.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      partial(test.request(), '/second');
      await vi.advanceTimersByTimeAsync(0);

      expect(test.current).toHaveBeenCalledTimes(3);
    } finally {
      for (const gate of gates) gate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);

      await test.drain();
    }
  });
});
