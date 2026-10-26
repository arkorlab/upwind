import type { Prerender } from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  policyFromCacheControl,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import { CACHE_OUTCOME_HEADER } from '@stayingupwind/core/paas';
import { afterEach, assert, describe, expect, it, type Mock, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { nowMs, withClock } from '../src/cache/clock.ts';
import { withRequestContext } from '../src/cache/context.ts';
import { configureCacheHandlers, PlatformFetchCache } from '../src/cache/handlers.ts';
import type { FetchLike } from '../src/cache/host.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { type GenerationSource, serveFromGeneration } from '../src/generations.ts';
import { type InvokeInput, invokeNodeHandler } from '../src/node-bridge.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';
import { requestKeeping } from './request-context.ts';

/**
 * What a visitor waits for while the entry they asked for is regenerated, against an authority in
 * memory: the render made for them and nothing after it. The uploads and the commit go on behind
 * the answer; the tag delta is pulled beside the lease; a stale generation is regenerated once its
 * answer has gone out in full, and its visitors are answered from that regeneration's render as
 * soon as it is made. The generation a render publishes is stamped with the moment it was made, not
 * the moment its commit is asked for.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_regenerationWaitsTest0';
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
/** How long a test lets something it expects at once go unanswered before it says so. */
const PATIENCE_MS = 1000;
const POLL_MS = 5;
/** Longer than any beat the lease keeps: a third of what is left of it, or 5 s at the least. */
const LEASE_MS = 60_000;
const STILL_WAITING = 'still waiting';
/** Nothing here runs a handler: the bridge that would is replaced, and says what it answers. */
const handler: NodeHandler = () => Promise.reject(new Error('the bridge is replaced'));
const encoder = new TextEncoder();

/** A Pages Router member the build left to the first request for it: rendered, then kept. */
const POST: GenerationSource = {
  route: '/posts/[slug]',
  pathname: '/posts/a',
  url: '/posts/a',
  representation: 'html',
  onMiss: 'render',
};
const FEED: RouteEntryDescriptor = { kind: 'app-route', route: '/api/feed', pathname: '/api/feed' };
const SHOP: GenerationSource = {
  route: '/shop',
  pathname: '/shop',
  url: '/shop',
  representation: 'html',
  onMiss: 'render',
};

function runtimeFor(fetchImpl: FetchLike): CacheRuntime {
  const runtime = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

/**
 * The shell the build made of a route's class, without a body: what makes its members the cache's
 * to answer, where a route the build prerendered nothing of is rendered for every request.
 */
function routeShell(route: string): { pages: Map<string, Prerender>; patterns: unknown[] } {
  const prerender: Prerender = {
    id: route,
    pathname: route,
    route,
    parentOutputId: route,
    groupId: 1,
  };
  return { pages: new Map(), patterns: [{ pattern: /^\//u, prerender }] };
}

/** A deployment whose one route is this entrypoint, with its class's shell and nothing else. */
function storeOf(pathname: string, kind: string): Store {
  return {
    manifest: {
      buildId: 'build',
      entrypoints: [{ pathname, kind }],
      config: { basePath: '', i18n: null },
    },
    prerendersByPathname: new Map<string, Prerender>(),
    shellsByRoute: new Map([[pathname, routeShell(pathname)]]),
  } as unknown as Store;
}

/** A request for `path`, the work it hands the runtime collected in `pending`. */
function routed(runtime: CacheRuntime, path: string, pending: Promise<unknown>[]): RoutedInput {
  const request = new Request(`${HOST}${path}`);
  return {
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
}

/** Every piece of work handed to the runtime settled, and whatever that work handed on in turn. */
async function settle(pending: readonly Promise<unknown>[]): Promise<void> {
  for (let settled = 0; settled < pending.length;) {
    const batch = pending.slice(settled);
    settled = pending.length;
    await Promise.all(batch);
  }
}

/** What `promise` comes to within `PATIENCE_MS`, or that it is still waiting then. */
async function within<T>(promise: Promise<T>): Promise<T | typeof STILL_WAITING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Promise<typeof STILL_WAITING>((resolve) => {
    timer = setTimeout(() => {
      resolve(STILL_WAITING);
    }, PATIENCE_MS);
  });
  try {
    return await Promise.race([promise, waiting]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `condition` comes to hold within `PATIENCE_MS`. */
async function comesTrue(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + PATIENCE_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  return true;
}

function isCall(request: Request, method: string, suffix: string): boolean {
  return request.method === method && new URL(request.url).pathname.endsWith(suffix);
}

/** `inner`, counting the batches of uploads (`uploadArtifacts`) and the uploads made each alone. */
function countingUploads(inner: FetchLike, sent: { batches: number; each: number }): FetchLike {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (isCall(request, 'POST', '/artifacts')) {
      sent.batches += 1;
    } else if (request.method === 'PUT' && pathname.includes('/artifacts/')) {
      sent.each += 1;
    }
    return inner(request);
  };
}

/**
 * `inner`, as a gateway from before batched uploads answers one (`uploadArtifacts`): as it answers
 * any route it does not have, after which the runtime uploads each output on its own — the uploads
 * these turns are about.
 */
function withoutBatches(inner: FetchLike): FetchLike {
  return async (request) => {
    return isCall(request, 'POST', '/artifacts')
      ? Response.json(
          { ok: false, error: { code: 'not_found', message: 'no such endpoint' } },
          { status: 404 },
        )
      : inner(request);
  };
}

/** The calls the authority is sent as they are made, their answers held back until released. */
function holding(
  inner: FetchLike,
  matches: (request: Request) => boolean,
  answer?: () => Response,
): { fetchImpl: FetchLike; arrived: Promise<unknown>; release: () => void } {
  const gate = Promise.withResolvers<true>();
  const arrived = Promise.withResolvers<true>();
  return {
    fetchImpl: async (request) => {
      const answered = await inner(request);
      if (!matches(request)) {
        return answered;
      }
      arrived.resolve(true);
      await gate.promise;
      return answer?.() ?? answered;
    },
    arrived: arrived.promise,
    release: () => {
      gate.resolve(true);
    },
  };
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
      if (isCall(request, 'POST', '/commit')) {
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

/** The feed as a route handler answers it, read from the entry's generation. */
const FEED_SOURCE: GenerationSource = {
  route: FEED.route,
  pathname: FEED.pathname,
  url: FEED.pathname,
  representation: 'route-body',
  onMiss: 'build',
};

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

/** A render that is the response, as a Pages Router page's is, made afresh for every call. */
function rendering(): Promise<Response> {
  return Promise.resolve(
    new Response('<html>post a</html>', {
      headers: { 'content-type': 'text/html', 'cache-control': ISR },
    }),
  );
}

function calledFor(authority: FakeAuthority, suffix: string): number {
  return authority.calls.filter((call) => call.endsWith(suffix)).length;
}

/** A shop page's prefetch segments: with its document and payload, six outputs to upload. */
function shopSegments(): Map<string, Uint8Array> {
  return new Map([
    ['/_index', encoder.encode('index')],
    ['/_tree', encoder.encode('tree')],
    ['/shop', encoder.encode('shop')],
    ['/shop/cart', encoder.encode('cart')],
  ]);
}

/** Next.js rendering the shop page, as it hands the runtime what it made (`onCacheEntry`). */
function renderingShop(
  segments: Map<string, Uint8Array>,
): (call: InvokeInput) => Promise<Response> {
  return async (call) => {
    const onCacheEntry = call.requestMeta['onCacheEntry'] as (
      entry: unknown,
      meta: unknown,
    ) => Promise<boolean> | boolean;
    await onCacheEntry(
      {
        value: {
          kind: 'APP_PAGE',
          html: { toUnchunkedString: () => '<html>shop</html>' },
          rscData: encoder.encode('0:["shop"]'),
          headers: { 'content-type': 'text/html' },
          status: 200,
          segmentData: segments,
        },
        cacheControl: { revalidate: 60, expire: 3600 },
      },
      { url: call.url },
    );
    return new Response(null);
  };
}

async function serve(
  runtime: CacheRuntime,
  store: Store,
  source: GenerationSource,
  now: number,
): Promise<{ response: Response | undefined; pending: Promise<unknown>[] }> {
  const pending: Promise<unknown>[] = [];
  const response = await withClock(now, () =>
    serveFromGeneration(routed(runtime, source.url, pending), store, source, handler),
  );
  return { response, pending };
}

describe('what a visitor waits for while an entry is regenerated', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
    vi.useRealTimers();
    configureCacheHandlers(undefined);
  });

  it('answers from the render while its commit is still unanswered', async () => {
    const authority = fakeAuthority(SCOPE);
    const commit = holding(authority.fetchImpl, (request) => isCall(request, 'POST', '/commit'));
    const runtime = runtimeFor(commit.fetchImpl);
    const store = storeOf(POST.route, 'pages');
    vi.mocked(invokeNodeHandler).mockImplementation(rendering);

    const pending: Promise<unknown>[] = [];
    const answering = withClock(T0, () =>
      serveFromGeneration(routed(runtime, POST.url, pending), store, POST, handler),
    );
    await commit.arrived;
    const answer = await within(answering);
    commit.release();
    await settle(pending);
    const kept = await serve(runtime, store, POST, T0 + SECOND);

    expect(answer).not.toBe(STILL_WAITING);

    const first = answer as Response;

    // Said of an answer that went out ahead of its commit: the publish was under way, no more.
    expect(first.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
    await expect(first.text()).resolves.toBe('<html>post a</html>');
    expect(authority.commits).toHaveLength(1);
    // The next request is answered from what the commit published, and renders nothing.
    expect(kept.response?.headers.get('x-nextjs-cache')).toBe('HIT');
    await expect(kept.response?.text()).resolves.toBe('<html>post a</html>');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease beating behind the answer until the commit is answered', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const authority = fakeAuthority(SCOPE);
    const commit = holding(authority.fetchImpl, (request) => isCall(request, 'POST', '/commit'));
    const runtime = runtimeFor(commit.fetchImpl);
    vi.mocked(invokeNodeHandler).mockImplementation(rendering);

    const pending: Promise<unknown>[] = [];
    const answering = withClock(T0, () => {
      return serveFromGeneration(
        routed(runtime, POST.url, pending),
        storeOf(POST.route, 'pages'),
        POST,
        handler,
      );
    });
    await commit.arrived;
    vi.advanceTimersByTime(LEASE_MS);
    const whileHeld = calledFor(authority, '/heartbeat');
    commit.release();
    const response = await answering;
    await settle(pending);
    vi.advanceTimersByTime(LEASE_MS);

    expect(response?.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
    expect(whileHeld).toBeGreaterThan(0);
    // Once the commit is answered the lease has done its work, and nothing beats for it again.
    expect(calledFor(authority, '/heartbeat')).toBe(whileHeld);
  });

  it('says in the log that a publish behind the answer was refused', async () => {
    const authority = fakeAuthority(SCOPE);
    const refusing: FetchLike = (request) => {
      return isCall(request, 'POST', '/commit')
        ? Promise.resolve(Response.json({ ok: true, result: { kind: 'lease-expired' } }))
        : authority.fetchImpl(request);
    };
    const runtime = runtimeFor(refusing);
    const log = vi.spyOn(runtime, 'log').mockImplementation(() => {
      /* Read back below. */
    });
    vi.mocked(invokeNodeHandler).mockImplementation(rendering);

    const { response, pending } = await serve(runtime, storeOf(POST.route, 'pages'), POST, T0);
    await settle(pending);

    // The visitor was answered from the render before the host said anything about it.
    expect(response?.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
    await expect(response?.text()).resolves.toBe('<html>post a</html>');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);

    // With how long the attempt had run: a publish behind the answer lives within what the
    // runtime gives work after a response, and one that took most of that says where it went.
    const elapsedMs: unknown = expect.any(Number);

    expect(log).toHaveBeenCalledWith('regeneration not published', {
      pathname: POST.pathname,
      detail: 'lease-expired',
      elapsedMs,
    });
  });

  /**
   * One call each, three at a time, a page's outputs were most of its publish: five of a few
   * kilobytes, two rounds of 0.4 s, before a commit of 0.5 s. A gateway that takes a batch is sent
   * them in one call.
   */
  it('uploads a page’s small outputs in one call', async () => {
    const authority = fakeAuthority(SCOPE);
    const sent = { batches: 0, each: 0 };
    const runtime = runtimeFor(countingUploads(authority.fetchImpl, sent));
    vi.mocked(invokeNodeHandler).mockImplementation(renderingShop(shopSegments()));

    const { response, pending } = await serve(runtime, storeOf(SHOP.route, 'app-page'), SHOP, T0);
    await settle(pending);

    await expect(response?.text()).resolves.toBe('<html>shop</html>');
    expect(sent).toStrictEqual({ batches: 1, each: 0 });
    expect(authority.commits[0]?.generation.outputs).toHaveLength(6);
  });

  /**
   * A gateway without the call answers as for any route it does not have; one that has it and
   * no longer has the attempt answers `not_found` too, which fails the attempt as an upload refused
   * would, rather than have each output sent on its own after it.
   */
  it('fails the attempt where a batch finds it gone, uploading nothing on its own', async () => {
    const authority = fakeAuthority(SCOPE);
    const sent = { batches: 0, each: 0 };
    const gone: FetchLike = async (request) => {
      return isCall(request, 'POST', '/artifacts')
        ? Response.json(
            { ok: false, error: { code: 'not_found', message: 'no such attempt' } },
            { status: 404 },
          )
        : authority.fetchImpl(request);
    };
    const runtime = runtimeFor(countingUploads(gone, sent));
    vi.mocked(invokeNodeHandler).mockImplementation(renderingShop(shopSegments()));

    const { response, pending } = await serve(runtime, storeOf(SHOP.route, 'app-page'), SHOP, T0);
    await settle(pending);

    await expect(response?.text()).resolves.toBe('<html>shop</html>');
    expect(sent).toStrictEqual({ batches: 1, each: 0 });
    expect(authority.commits).toHaveLength(0);
    expect(authority.failures).toHaveLength(1);
  });

  /**
   * A page's segments went up one after another once its other outputs were up, a round trip each
   * between the render and its commit. Each on its own, as a gateway without batches has them.
   */
  it('uploads the segments of a page beside its other outputs, three at a time', async () => {
    const authority = fakeAuthority(SCOPE);
    const segments = shopSegments();
    // Three at once of the document, its payload and each segment: a Function has six calls
    // waiting for their headers at most, a `use cache` write has the fourth of a request's writes,
    // and the reads a render waits on, the heartbeat and the commit the other two.
    const together = 3;
    const most = { asking: 0, together: 0 };
    const held = Promise.withResolvers<true>();
    const uploads: FetchLike = async (request) => {
      if (request.method !== 'PUT' || !new URL(request.url).pathname.includes('/artifacts/')) {
        return authority.fetchImpl(request);
      }
      most.asking += 1;
      most.together = Math.max(most.together, most.asking);
      await within(held.promise);
      most.asking -= 1;
      return authority.fetchImpl(request);
    };
    const runtime = runtimeFor(withoutBatches(uploads));
    vi.mocked(invokeNodeHandler).mockImplementation(renderingShop(segments));

    const { response, pending } = await serve(runtime, storeOf(SHOP.route, 'app-page'), SHOP, T0);
    // Held while they are out: as many as go at once are out, and no more come while they are.
    await vi.waitFor(() => {
      expect(most.asking).toBe(together);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS * 10);
    });

    expect(most.together).toBe(together);

    held.resolve(true);
    await settle(pending);

    await expect(response?.text()).resolves.toBe('<html>shop</html>');
    expect(
      authority.commits[0]?.generation.outputs.map((output) => output.representationKey),
    ).toStrictEqual([
      'html',
      'rsc',
      'segment:/_index',
      'segment:/_tree',
      'segment:/shop',
      'segment:/shop/cart',
    ]);
  });

  /**
   * An output that fails to upload fails the attempt. The outputs still waiting for their turn went
   * out after it all the same, to an attempt no commit would name, holding the turns the request's
   * writes wait for. Asked in a request, as a Function asks it: the request's turns wake the next
   * output as soon as one is given back, before anything that waits on the one that failed. Each on
   * its own, as a gateway without batches has them.
   */
  it('sends none of a page’s outputs past one that failed to upload', async () => {
    const authority = fakeAuthority(SCOPE);
    const sent = { uploads: 0 };
    const held = Promise.withResolvers<true>();
    const uploads: FetchLike = async (request) => {
      if (request.method !== 'PUT' || !new URL(request.url).pathname.includes('/artifacts/')) {
        return authority.fetchImpl(request);
      }
      sent.uploads += 1;
      if (sent.uploads === 1) {
        // The first fails once the turns are full, with the rest of the page's outputs waiting.
        await comesTrue(() => sent.uploads === 3);
        return Response.json({ ok: false, error: 'refused' }, { status: 400 });
      }
      await within(held.promise);
      return authority.fetchImpl(request);
    };
    const runtime = runtimeFor(withoutBatches(uploads));
    vi.mocked(invokeNodeHandler).mockImplementation(renderingShop(shopSegments()));
    const kept: Promise<unknown>[] = [];

    const { response, pending } = await withRequestContext(
      requestKeeping(runtime, kept),
      async () => serve(runtime, storeOf(SHOP.route, 'app-page'), SHOP, T0),
    );

    await expect(response?.text()).resolves.toBe('<html>shop</html>');

    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    held.resolve(true);
    await settle(pending);
    await Promise.all(kept);

    expect(sent.uploads).toBe(3);
    expect(authority.commits).toHaveLength(0);
  });

  /**
   * The fetch cache's writes go out behind the render as well, one for each `fetch` it made, and took
   * the calls the uploads left for the heartbeat and the commit. A request's uploads and those writes
   * take the same three turns — each upload on its own, as a gateway without batches has them.
   */
  it('uploads a regeneration’s outputs in the same three turns as the request’s fetch writes', async () => {
    const authority = fakeAuthority(SCOPE);
    const most = { asking: 0, together: 0 };
    const held = Promise.withResolvers<true>();
    const behind: FetchLike = async (request) => {
      const { pathname } = new URL(request.url);
      const uploading = request.method === 'PUT' && pathname.includes('/artifacts/');
      const writing = request.method === 'PUT' && pathname.endsWith('/data');
      if (!uploading && !writing) {
        return authority.fetchImpl(request);
      }
      most.asking += 1;
      most.together = Math.max(most.together, most.asking);
      await within(held.promise);
      most.asking -= 1;
      return writing
        ? Response.json({ ok: true, result: { entryId: 'e', generationId: 'g', revision: 1 } })
        : authority.fetchImpl(request);
    };
    const runtime = runtimeFor(withoutBatches(behind));
    configureCacheHandlers(runtime);
    vi.mocked(invokeNodeHandler).mockImplementation(renderingShop(shopSegments()));
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);

    // Two `fetch` writes a render in this request made, still out when the regeneration uploads.
    await withRequestContext(context, async () => {
      const fetches = new PlatformFetchCache();
      for (const key of ['feed', 'prices']) {
        await fetches.set(
          key,
          { kind: 'FETCH', data: { body: key }, revalidate: 60 },
          { fetchCache: true },
        );
      }
    });
    await vi.waitFor(() => {
      expect(most.asking).toBe(2);
    });
    const { response, pending } = await withRequestContext(context, async () =>
      serve(runtime, storeOf(SHOP.route, 'app-page'), SHOP, T0),
    );
    await vi.waitFor(() => {
      expect(most.asking).toBe(3);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS * 10);
    });

    expect(most.together).toBe(3);

    held.resolve(true);
    await settle(pending);
    await Promise.all(kept);

    await expect(response?.text()).resolves.toBe('<html>shop</html>');
    expect(authority.commits).toHaveLength(1);
  });

  /**
   * A fresh isolate's first regeneration pulled the scope's whole tag delta, a page at a time, and
   * only then asked for the lease.
   */
  it('asks for the lease beside the tag delta, and renders once both have answered', async () => {
    const authority = fakeAuthority(SCOPE);
    const delta = holding(
      authority.fetchImpl,
      (request) => isCall(request, 'GET', '/tags/delta'),
      () =>
        Response.json({ ok: true, result: { revision: 7, floor: 0, truncated: false, tags: [] } }),
    );
    const runtime = runtimeFor(delta.fetchImpl);
    vi.mocked(invokeNodeHandler).mockImplementation(rendering);

    const pending: Promise<unknown>[] = [];
    const answering = withClock(T0, () => {
      return serveFromGeneration(
        routed(runtime, POST.url, pending),
        storeOf(POST.route, 'pages'),
        POST,
        handler,
      );
    });
    await delta.arrived;
    const leasedWhileDeltaHeld = await comesTrue(
      () => calledFor(authority, 'POST /attempts') === 1,
    );
    const renderedWhileDeltaHeld = vi.mocked(invokeNodeHandler).mock.calls.length;
    delta.release();
    await answering;
    await settle(pending);

    expect(leasedWhileDeltaHeld).toBe(true);
    // The render waits for the view its reads are judged against, and the commit claims it.
    expect(renderedWhileDeltaHeld).toBe(0);
    expect(authority.commits[0]?.observedTagRevision).toBe(7);
  });

  /**
   * A custom host need not bound its tag delta as the gateway does. The outer deadline still gives
   * its lease back after ten seconds, and answers the visitor from a render of their own.
   */
  it('gives the lease back when a custom host has not synced the tags within ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority.fetchImpl);
    const delta = Promise.withResolvers<never>();
    const arrived = Promise.withResolvers<true>();
    const pull = vi.spyOn(runtime.host, 'tagsDelta').mockImplementation(() => {
      arrived.resolve(true);
      return delta.promise;
    });
    vi.mocked(invokeNodeHandler).mockImplementation(rendering);

    const pending: Promise<unknown>[] = [];
    const answering = withClock(T0, () => {
      return serveFromGeneration(
        routed(runtime, POST.url, pending),
        storeOf(POST.route, 'pages'),
        POST,
        handler,
      );
    });
    try {
      await arrived.promise;
      // The lease taken, and the wait for the tags begun under it: the heartbeat and the deadline.
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(0);

        expect(vi.getTimerCount()).toBe(2);
      });
      await vi.advanceTimersByTimeAsync(9000);

      expect(authority.failures).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2000);
      const response = await answering;
      const beats = calledFor(authority, '/heartbeat');
      await vi.advanceTimersByTimeAsync(LEASE_MS);

      const error: unknown = expect.objectContaining({ code: 'tags_not_synced' });

      expect(authority.failures).toStrictEqual([
        expect.objectContaining({ outcome: 'failed', error }),
      ]);
      expect(response?.headers.get(CACHE_OUTCOME_HEADER)).toBe('failed');
      await expect(response?.text()).resolves.toBe('<html>post a</html>');
      expect(authority.commits).toHaveLength(0);
      expect(calledFor(authority, '/heartbeat')).toBe(beats);
      expect(pull).toHaveBeenCalledTimes(1);
    } finally {
      delta.reject(new Error('the fixture released its custom host'));
      pull.mockRestore();
      await settle(pending);
    }
  });

  /**
   * A read begun once the render let go of the entry may keep the generation the render replaces.
   * Published or not, what the host serves may no longer be that one, so the isolate lets go of it
   * again once the publish has come to anything.
   */
  it('lets go of the entry again once a publish behind the answer was refused', async () => {
    const authority = fakeAuthority(SCOPE);
    const commit = holding(
      authority.fetchImpl,
      (request) => isCall(request, 'POST', '/commit'),
      () => Response.json({ ok: true, result: { kind: 'lease-expired' } }),
    );
    const runtime = runtimeFor(commit.fetchImpl);
    vi.spyOn(runtime, 'log').mockImplementation(() => {
      /* A refused publish is logged; not what is asked here. */
    });
    vi.mocked(invokeNodeHandler).mockImplementation(rendering);
    const { entryId } = await deriveEntry(runtime.scopeId, {
      kind: 'pages',
      route: POST.route,
      pathname: POST.pathname,
    });

    const pending: Promise<unknown>[] = [];
    const answering = withClock(T0, () => {
      return serveFromGeneration(
        routed(runtime, POST.url, pending),
        storeOf(POST.route, 'pages'),
        POST,
        handler,
      );
    });
    await commit.arrived;
    // What a request reading the entry while the commit is out keeps: here, that there is none.
    runtime.recordMemo.set(entryId, null);
    commit.release();
    await answering;
    await settle(pending);

    expect(runtime.recordMemo.get(entryId)).toBeUndefined();
  });

  /**
   * Begun at once, a stale generation's regeneration rendered on the isolate beside the visitor's
   * own render; behind a resume the edge dispatched, it already waited for the answer to go out.
   */
  it('regenerates a stale generation once its answer has gone out in full', async () => {
    const authority = fakeAuthority(SCOPE);
    await keptFeed(authority);
    const runtime = runtimeFor(authority.fetchImpl);
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      Response.json({ feed: 'regenerated' }, { headers: { 'cache-control': ISR } }),
    );
    const now = T0 + 61 * SECOND;

    const pending: Promise<unknown>[] = [];
    const store = storeOf(FEED.route, 'app-route');
    const { answered, before } = await withClock(now, async () => {
      const response = await serveFromGeneration(
        routed(runtime, FEED.pathname, pending),
        store,
        FEED_SOURCE,
        handler,
      );
      const asked = [...authority.calls];
      return { answered: await response?.text(), before: asked };
    });
    await settle(pending);

    expect(answered).toBe('{"feed":"kept"}');
    // Before the body went out, the record was read and nothing else was asked.
    expect(before).toStrictEqual([expect.stringMatching(/\/record$/u)]);
    expect(authority.commits).toHaveLength(1);
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  /**
   * As Next.js answers the requests after a revalidation from its render as soon as that is set.
   * Answered from the generation it replaces until the commit was in, a page stayed as it was for
   * the round trips of the uploads and the commit past the moment the next one was made.
   */
  it('answers a stale generation’s visitor from the render regenerating it, while its commit is out', async () => {
    const authority = fakeAuthority(SCOPE);
    await keptFeed(authority);
    const commit = commitsHeldBack(authority.fetchImpl);
    const runtime = runtimeFor(commit.fetchImpl);
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      Response.json({ feed: 'regenerated' }, { headers: { 'cache-control': ISR } }),
    );
    const store = storeOf(FEED.route, 'app-route');
    const now = T0 + 61 * SECOND;

    const first = await serve(runtime, store, FEED_SOURCE, now);
    const stale = await first.response?.text();
    await commit.arrived;
    const second = await serve(runtime, store, FEED_SOURCE, now);
    const answered = await second.response?.text();
    commit.release();
    await settle([...first.pending, ...second.pending]);

    expect(stale).toBe('{"feed":"kept"}');
    expect(answered).toBe('{"feed":"regenerated"}');
    expect(second.response?.headers.get(CACHE_OUTCOME_HEADER)).toBe('publishing');
    expect(authority.commits).toHaveLength(1);
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  /**
   * The render answers only where it may at once, as it answers a regeneration of the isolate's.
   */
  it('answers a stale generation’s visitor from that generation past a hold of the view the render read against', async () => {
    const authority = fakeAuthority(SCOPE);
    await keptFeed(authority);
    const commit = commitsHeldBack(authority.fetchImpl);
    const runtime = runtimeFor(commit.fetchImpl);
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      Response.json({ feed: 'regenerated' }, { headers: { 'cache-control': ISR } }),
    );
    const store = storeOf(FEED.route, 'app-route');
    const now = T0 + 61 * SECOND;

    const first = await serve(runtime, store, FEED_SOURCE, now);
    await first.response?.text();
    await commit.arrived;
    const second = await serve(runtime, store, FEED_SOURCE, now + runtime.holdMs);
    const answered = await second.response?.text();
    commit.release();
    await settle([...first.pending, ...second.pending]);

    expect(answered).toBe('{"feed":"kept"}');
    expect(second.response?.headers.has(CACHE_OUTCOME_HEADER)).toBe(false);
  });

  /**
   * As Next.js stamps an entry once its render is set (`lastModified`). Stamped once the uploads
   * had landed, a generation stayed fresh past its lifetime for as long as they took — and short of
   * its `expire` for a visitor answered from the render meanwhile.
   */
  it('stamps the generation with the moment its render was made, not once its uploads have landed', async () => {
    const authority = fakeAuthority(SCOPE);
    let uploadsAsked: number | undefined;
    const slowUploads: FetchLike = async (request) => {
      // An upload, alone or in a batch.
      if (new URL(request.url).pathname.includes('/artifacts')) {
        uploadsAsked ??= nowMs();
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      return authority.fetchImpl(request);
    };
    // The wall clock, which moves on while the uploads are out, rather than a request's own.
    const runtime = createCacheRuntime({ env: ENV, now: nowMs, fetchImpl: slowUploads });
    assert(runtime !== undefined);
    vi.mocked(invokeNodeHandler).mockImplementation(rendering);

    const pending: Promise<unknown>[] = [];
    await serveFromGeneration(
      routed(runtime, POST.url, pending),
      storeOf(POST.route, 'pages'),
      POST,
      handler,
    );
    await settle(pending);

    const generation = authority.commits[0]?.generation;

    expect(uploadsAsked).toBeDefined();
    expect(generation?.cacheTimestamp).toBeLessThanOrEqual(uploadsAsked ?? 0);
    // The commit still says when it was asked for.
    expect(generation?.producedAt).toBeGreaterThan(generation?.cacheTimestamp ?? Infinity);
  });
});
