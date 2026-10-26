import { policyFromCacheControl, type RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { CACHE_OUTCOME_HEADER } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import type { CurrentGeneration } from '../src/cache/current.ts';
import type { FetchLike } from '../src/cache/host.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { offeredFromGeneration } from '../src/delivery.ts';
import { type GenerationSource, serveFromGeneration } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

/**
 * What a stale generation's visitor is answered with while this isolate regenerates it, as a host
 * with no edge in front of it decides it (`delivery.ts`): the render that regeneration is publishing
 * stands in the generation's slot, and is offered by that generation, as the generation's own answer
 * is. The edge serves the standing record as everyone's whatever regenerates it (`serveCurrentPage`).
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

/** What the answer was offered by, as the seam is asked: the generation and the representation. */
const OFFERED_BY = 'x-test-offered-by';

vi.mock(import('../src/delivery.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    offeredFromGeneration: vi.fn(
      (
        _input: RoutedInput,
        current: CurrentGeneration,
        representation: string,
        answer: Response,
      ) => {
        const offered = new Response(answer.body, answer);
        offered.headers.set(OFFERED_BY, `${current.pack.header.generationId} ${representation}`);
        return offered;
      },
    ),
  };
});

const SCOPE = 'dpl_standingOfferTest00000';
const HOST = 'https://app.test';
const SECOND = 1000;
const T0 = 1_800_000_000_000;
const ISR = 's-maxage=60, stale-while-revalidate=31535940';
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
/** Nothing here runs a handler: the bridge that would is replaced, and says what it answers. */
const handler: NodeHandler = () => Promise.reject(new Error('the bridge is replaced'));
const encoder = new TextEncoder();

const FEED: RouteEntryDescriptor = { kind: 'app-route', route: '/api/feed', pathname: '/api/feed' };
const FEED_SOURCE: GenerationSource = {
  route: FEED.route,
  pathname: FEED.pathname,
  url: FEED.pathname,
  representation: 'route-body',
  onMiss: 'build',
};

function runtimeFor(fetchImpl: FetchLike): CacheRuntime {
  const runtime = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

/** A deployment whose one route is the feed's route handler, with its class's shell. */
function feedStore(): Store {
  return {
    manifest: {
      buildId: 'build',
      entrypoints: [{ pathname: FEED.route, kind: 'app-route' }],
      config: { basePath: '', i18n: null },
    },
    prerendersByPathname: new Map(),
    shellsByRoute: new Map([
      [
        FEED.route,
        {
          pages: new Map(),
          patterns: [
            {
              pattern: /^\//u,
              prerender: {
                id: FEED.route,
                pathname: FEED.route,
                route: FEED.route,
                parentOutputId: FEED.route,
                groupId: 1,
              },
            },
          ],
        },
      ],
    ]),
  } as unknown as Store;
}

/** The feed's generation made at `T0`, a minute's lifetime, kept by the authority. */
async function keptFeed(authority: FakeAuthority): Promise<void> {
  await authority.record(
    FEED,
    {
      cacheTimestamp: T0,
      policy: policyFromCacheControl({ revalidate: 60, expire: 3600 }),
      status: 200,
      headers: { 'content-type': 'application/json' },
      tags: [],
    },
    encoder.encode('{"feed":"kept"}'),
    'build',
  );
}

/**
 * `inner`, every commit held back before the authority hears of it until released: a publish under
 * way, whose generation the authority does not hold yet.
 */
function commitsHeldBack(inner: FetchLike): {
  fetchImpl: FetchLike;
  arrived: Promise<unknown>;
  release: () => void;
} {
  const gate = Promise.withResolvers<true>();
  const arrived = Promise.withResolvers<true>();
  return {
    fetchImpl: async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/commit')) {
        arrived.resolve(true);
        await gate.promise;
      }
      return inner(request);
    },
    arrived: arrived.promise,
    release: () => {
      gate.resolve(true);
    },
  };
}

/** The feed asked for at `now`, and the work the answer handed the runtime. */
async function served(
  runtime: CacheRuntime,
  now: number,
): Promise<{ response: Response | undefined; pending: Promise<unknown>[] }> {
  const pending: Promise<unknown>[] = [];
  const request = new Request(`${HOST}${FEED.pathname}`);
  const input: RoutedInput = {
    app: { entries: {} },
    edge: { entries: {} },
    request,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    cache: runtime,
    initURL: request.url,
    run: (work) => work(),
  };
  const response = await withClock(now, () =>
    serveFromGeneration(input, feedStore(), FEED_SOURCE, handler),
  );
  return { response, pending };
}

/** Every piece of work handed to the runtime settled, and whatever that work handed on in turn. */
async function settle(pending: readonly Promise<unknown>[]): Promise<void> {
  for (let settled = 0; settled < pending.length;) {
    const batch = pending.slice(settled);
    settled = pending.length;
    await Promise.all(batch);
  }
}

describe('a stale generation’s visitor, answered from the render regenerating it', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
    vi.mocked(offeredFromGeneration).mockClear();
  });

  it('is offered by the generation the render stands in for, as its own answer is', async () => {
    const authority = fakeAuthority(SCOPE);
    await keptFeed(authority);
    const commit = commitsHeldBack(authority.fetchImpl);
    const runtime = runtimeFor(commit.fetchImpl);
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      Response.json({ feed: 'regenerated' }, { headers: { 'cache-control': ISR } }),
    );
    const now = T0 + 61 * SECOND;

    const first = await served(runtime, now);
    const stale = await first.response?.text();
    await commit.arrived;
    const second = await served(runtime, now);
    const answered = await second.response?.text();
    commit.release();
    await settle([...first.pending, ...second.pending]);

    expect(stale).toBe('{"feed":"kept"}');
    expect(first.response?.headers.get(OFFERED_BY)).toBe('generation-1 route-body');
    expect(answered).toBe('{"feed":"regenerated"}');
    expect(second.response?.headers.get(CACHE_OUTCOME_HEADER)).toBe('publishing');
    expect(second.response?.headers.get(OFFERED_BY)).toBe('generation-1 route-body');
  });
});
