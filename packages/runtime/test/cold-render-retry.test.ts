import { createHash } from 'node:crypto';

import { MAX_TAG_LENGTH, policyFromBuild } from '@stayingupwind/core/cache';
import { CACHE_ROUTE_HEADER } from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withClock } from '../src/cache/clock.ts';
import type {
  AttemptOutcome,
  CommitRequest,
  CurrentSummary,
  FailRequest,
} from '../src/cache/host.ts';
import { abandon } from '../src/cache/lease.ts';
import { regenerate, type RegenerationOutcome } from '../src/cache/regenerate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { nodeHandlerOf } from '../src/entries.ts';
import { handleForeground } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';
import { NOW, manifestOf, runtimeOf } from './pages-isr-fixtures.ts';

vi.mock(import('../src/entries.ts'), () => ({ nodeHandlerOf: vi.fn() }));
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const PATHNAME = '/recover';
const BACKOFF_MS = 2000;
const LEASE_MS = 60_000;
const CURRENT: CurrentSummary = {
  generationId: 'current-generation',
  seq: 1,
  cacheTimestamp: NOW - 1,
  policy: policyFromBuild({ initialRevalidate: 2 }),
  condemned: null,
};

function handler(): Promise<never> {
  return Promise.reject(new Error('The Node bridge is mocked.'));
}

function storeOf(): Store {
  const manifest = manifestOf({
    entrypoints: [{ id: 'route', kind: 'app-route', pathname: PATHNAME }],
    prerenders: [],
  });
  return {
    manifest,
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    shellsByRoute: new Map(),
    staticFiles: new Map(),
    pathnames: [PATHNAME],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    renderedPages: new Set(),
    readBlob: () => new Uint8Array(),
    tryReadBlob: vi.fn<Store['tryReadBlob']>(),
  };
}

function renderOf(value: string): Promise<Response> {
  return Promise.resolve(
    new Response(value, {
      status: value === 'error' ? 500 : 200,
      headers: { 'content-type': 'text/plain', 'cache-control': 's-maxage=60' },
    }),
  );
}

/** The existing authority's failed-attempt backoff and exclusive lease, held in memory. */
function authority(historicalRequest = false) {
  const commits: CommitRequest[] = [];
  const failures: FailRequest[] = [];
  const artifacts = new Map<string, Uint8Array>();
  const base = runtimeOf(commits);
  let retryAt = NOW;
  let active = false;
  let attempt = 0;
  const state = { value: 'error', occupy: false };
  const startAttempt = vi.fn((): Promise<AttemptOutcome> => {
    if (active || state.occupy || retryAt > NOW) {
      return Promise.resolve({
        kind: 'busy',
        entryId: 'entry',
        attemptId: `attempt-${attempt}`,
        leaseExpiresAt: Math.max(retryAt, NOW + LEASE_MS),
        current: null,
      });
    }
    active = true;
    attempt += 1;
    return Promise.resolve({
      kind: 'leased',
      entryId: 'entry',
      attemptId: `attempt-${attempt}`,
      fencingToken: attempt,
      leaseExpiresAt: NOW + LEASE_MS,
      current: null,
    });
  });
  const runtime: CacheRuntime = {
    ...base,
    host: {
      ...base.host,
      startAttempt,
      fail: (_id, request) => {
        failures.push(request);
        active = false;
        // The historical client sent no override. Keep that request as the causal control.
        retryAt = NOW + (historicalRequest ? BACKOFF_MS : (request.retryAfterMs ?? BACKOFF_MS));
        return Promise.resolve();
      },
      uploadArtifact: ({ bytes }) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        artifacts.set(sha256, bytes);
        return Promise.resolve({ sha256, byteLength: bytes.byteLength });
      },
      commit: (_id, request) => {
        active = false;
        commits.push(request);
        return Promise.resolve({ kind: 'published', generationId: 'ready-generation' });
      },
    },
  };
  const pending: Promise<unknown>[] = [];
  const request = new Request(`https://app.test${PATHNAME}`, {
    headers: { [CACHE_ROUTE_HEADER]: PATHNAME },
  });
  const input: RoutedInput = {
    app: { entries: {} },
    edge: { entries: {} },
    request,
    initURL: request.url,
    cache: runtime,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    run: (work) => work(),
  };
  return { runtime, state, failures, commits, artifacts, pending, input, startAttempt };
}

async function settledKind(outcome: RegenerationOutcome): Promise<string> {
  return outcome.kind === 'accepted' ? (await outcome.published).kind : outcome.kind;
}

describe('a failed render with no published generation', () => {
  beforeEach(() => {
    vi.mocked(nodeHandlerOf).mockResolvedValue(handler);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { historical: true, outcome: 'busy', commits: 0, stored: undefined },
    { historical: false, outcome: 'accepted', commits: 1, stored: 'ready' },
  ])(
    'keeps a recovered render only when the cold failure is immediately retryable: historical=$historical',
    async (scenario) => {
      const model = authority(scenario.historical);
      const store = storeOf();
      vi.mocked(invokeNodeHandler).mockImplementation(() => renderOf(model.state.value));
      const failed = await withClock(NOW, () => handleForeground(model.input, store));

      expect({
        outcome: failed.outcome,
        status: failed.response?.status,
        failures: model.failures.length,
        commits: model.commits.length,
      }).toStrictEqual({ outcome: 'failed', status: 500, failures: 1, commits: 0 });

      await failed.response?.text();
      model.state.value = 'ready';
      const recovered = await withClock(NOW, () => handleForeground(model.input, store));
      await Promise.all(model.pending);

      expect(recovered.outcome).toBe(scenario.outcome);
      expect(recovered.response?.status).toBe(200);
      await expect(recovered.response?.text()).resolves.toBe('ready');
      expect(model.commits).toHaveLength(scenario.commits);
      expect(model.startAttempt).toHaveBeenCalledTimes(2);

      // A visitor-only response leaves no saved generation to survive another data failure.
      const body = model.commits[0]?.generation.outputs[0]?.artifacts[0];
      const bytes = body === undefined ? undefined : model.artifacts.get(body.sha256);

      expect(bytes === undefined ? undefined : new TextDecoder().decode(bytes)).toBe(
        scenario.stored,
      );
    },
  );

  it.each([
    { replaces: null, current: null, outcome: 'failed' as const, retryAfterMs: 0 },
    {
      replaces: null,
      current: CURRENT,
      outcome: 'failed' as const,
      retryAfterMs: undefined,
    },
    { replaces: null, current: undefined, outcome: 'failed' as const, retryAfterMs: undefined },
    {
      replaces: 'current-generation',
      current: null,
      outcome: 'failed' as const,
      retryAfterMs: undefined,
    },
    { replaces: undefined, current: null, outcome: 'failed' as const, retryAfterMs: undefined },
    { replaces: null, current: null, outcome: 'skipped' as const, retryAfterMs: undefined },
  ])('leaves every other failure policy with its host: %j', async (scenario) => {
    const model = authority();

    await abandon(
      {
        runtime: model.runtime,
        waitUntil: (promise) => {
          model.pending.push(promise);
        },
        target: { descriptor: { pathname: PATHNAME }, replaces: scenario.replaces },
      },
      { attemptId: 'attempt', fencingToken: 7, current: scenario.current },
      scenario.outcome,
      { error: new Error('render failed'), stage: 'render' },
    );

    expect(model.failures[0]?.retryAfterMs).toBe(scenario.retryAfterMs);
    expect(model.failures[0]?.fencingToken).toBe(7);
    expect(model.failures[0]?.outcome).toBe(scenario.outcome);
    expect(Object.hasOwn(model.failures[0]!, 'retryAfterMs')).toBe(scenario.retryAfterMs === 0);
  });

  it('keeps an existing live lease exclusive after a cold failure', async () => {
    const model = authority();
    model.state.occupy = true;
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      new Response('visitor', { headers: { 'cache-control': 's-maxage=60' } }),
    );

    const result = await withClock(NOW, () => handleForeground(model.input, storeOf()));

    expect(result.outcome).toBe('busy');
    await expect(result.response?.text()).resolves.toBe('visitor');
    expect(model.commits).toHaveLength(0);
    expect(model.failures).toHaveLength(0);
    expect(model.startAttempt).toHaveBeenCalledTimes(1);
  });

  it('preserves host backoff unless the caller identifies the failed render stage', async () => {
    const model = authority();
    await abandon(
      {
        runtime: model.runtime,
        waitUntil: model.input.waitUntil,
        target: { descriptor: { pathname: PATHNAME }, replaces: null },
      },
      { attemptId: 'attempt', fencingToken: 1, current: null },
      'failed',
      { error: new Error('failure outside rendering') },
    );

    expect(model.failures).toHaveLength(1);
    expect(Object.hasOwn(model.failures[0]!, 'retryAfterMs')).toBe(false);
  });

  it.each([
    {
      name: 'pre-render tag sync',
      expectedKind: 'failed',
      renderCalls: 0,
      arrange: (model: ReturnType<typeof authority>) => {
        vi.spyOn(model.runtime.tags, 'sync').mockRejectedValue(new Error('tag sync failed'));
      },
    },
    {
      name: 'artifact upload',
      expectedKind: 'accepted',
      renderCalls: 1,
      arrange: (model: ReturnType<typeof authority>) => {
        vi.spyOn(model.runtime.host, 'uploadArtifact').mockRejectedValue(
          new Error('upload failed'),
        );
      },
    },
    {
      name: 'generation commit',
      expectedKind: 'accepted',
      renderCalls: 1,
      arrange: (model: ReturnType<typeof authority>) => {
        vi.spyOn(model.runtime.host, 'commit').mockRejectedValue(new Error('commit failed'));
      },
    },
    {
      name: 'publication tag bounds',
      expectedKind: 'accepted',
      renderCalls: 1,
      arrange: () => {
        vi.mocked(invokeNodeHandler).mockResolvedValue(
          new Response('ready', {
            headers: {
              'cache-control': 's-maxage=60',
              'x-next-cache-tags': 't'.repeat(MAX_TAG_LENGTH + 1),
            },
          }),
        );
      },
    },
  ])('preserves host backoff for a $name failure on a cold entry', async (scenario) => {
    const model = authority();
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      new Response('ready', { headers: { 'cache-control': 's-maxage=60' } }),
    );
    scenario.arrange(model);

    const outcome = await withClock(NOW, () => {
      return regenerate({
        runtime: model.runtime,
        request: model.input.request,
        handler,
        target: {
          descriptor: { kind: 'app-route', route: PATHNAME, pathname: PATHNAME },
          reason: 'expired',
          replaces: null,
        },
        previewToken: undefined,
        waitUntil: model.input.waitUntil,
        run: model.input.run,
      });
    });
    const settled = await settledKind(outcome);
    await Promise.allSettled(model.pending);

    expect(outcome.kind).toBe(scenario.expectedKind);
    expect(settled).toBe('failed');
    expect(model.failures).toHaveLength(1);
    expect(Object.hasOwn(model.failures[0]!, 'retryAfterMs')).toBe(false);
    expect(model.commits).toHaveLength(0);
    expect(invokeNodeHandler).toHaveBeenCalledTimes(scenario.renderCalls);
  });
});
