import type { Prerender } from '@stayingupwind/core/bundle';
import { policyFromCacheControl, type RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import { currentGeneration } from '../src/cache/current.ts';
import type { FetchLike } from '../src/cache/host.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { type GenerationSource, serveFromGeneration } from '../src/generations.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

/**
 * What the Worker asks of the cache before it answers a request itself, against an authority in
 * memory: nothing for a route the cache can hold nothing of, and what it has worked out once — an
 * entry's id — or read once — an artifact, named by its content — not again.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

// The bridge needs the Workers runtime, and nothing here renders.
vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_lookupCostsUnderTest0';
const HOST = 'https://app.test';
const T0 = 1_800_000_000_000;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const PAGE: RouteEntryDescriptor = { kind: 'app-page', route: '/team', pathname: '/team' };
const encoder = new TextEncoder();
const SECOND = 1000;
/** Nothing here renders: an answer from the cache, or none, is all a test asks for. */
const handler: NodeHandler = () => Promise.reject(new Error('nothing renders here'));

function runtimeFor(fetchImpl: FetchLike, now: () => number = () => T0): CacheRuntime {
  const runtime = createCacheRuntime({ env: ENV, now, fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

/** A deployment of one App Router page, with what the build prerendered of it. */
function storeOf(route: string, prerenders: readonly Prerender[]): Store {
  return {
    manifest: {
      buildId: 'build',
      entrypoints: [{ pathname: route, kind: 'app-page' }],
      config: { basePath: '', i18n: null },
    },
    prerendersByPathname: new Map(prerenders.map((prerender) => [prerender.pathname, prerender])),
    shellsByRoute: new Map(),
  } as unknown as Store;
}

function routed(runtime: CacheRuntime, path: string): RoutedInput {
  const request = new Request(`${HOST}${path}`, { headers: { rsc: '1' } });
  return {
    app: { entries: {} },
    edge: { entries: {} },
    request,
    waitUntil: () => {
      // Nothing a test here reads is left to the runtime.
    },
    cache: runtime,
    initURL: request.url,
    run: (work) => work(),
  };
}

function payloadOf(route: string, prefetch?: boolean): GenerationSource {
  return { route, pathname: route, url: route, representation: 'rsc', prefetch, onMiss: 'build' };
}

describe('a route the build prerendered nothing of', () => {
  /**
   * Every navigation's payload for such a route asked for its record, and waited on the read —
   * up to its deadline while the host was slow — for an answer that could only say there was none.
   */
  it('is answered without asking the cache for a record', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority.fetchImpl);

    const answered = await withClock(T0, () => {
      return serveFromGeneration(
        routed(runtime, '/live'),
        storeOf('/live', []),
        payloadOf('/live'),
        handler,
      );
    });

    expect(answered).toBeUndefined();
    expect(authority.calls).toStrictEqual([]);
  });
});

/** An authority holding a generation of `PAGE` a regeneration made, fresh for 15 minutes. */
async function regenerated(): Promise<FakeAuthority> {
  const authority = fakeAuthority(SCOPE);
  await authority.record(
    PAGE,
    {
      cacheTimestamp: T0,
      policy: policyFromCacheControl({ revalidate: 900, expire: 31_536_000 }),
      status: 200,
      headers: {},
      tags: [],
      stored: new Map([['rsc', encoder.encode('0:["the payload"]')]]),
    },
    encoder.encode('<html>team</html>'),
    'runtime',
  );
  return authority;
}

describe('an entry a request names again', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Its id was derived afresh for every request: two SHA-256 digests ahead of its record's read. */
  it('is looked up under the id derived for it the first time', async () => {
    const authority = await regenerated();
    const runtime = runtimeFor(authority.fetchImpl);
    const reads: Promise<unknown>[] = [];
    const keep = (promise: Promise<unknown>): void => {
      reads.push(promise);
    };
    await currentGeneration(runtime, PAGE, T0, keep);
    await Promise.all(reads);
    const digest = vi.spyOn(crypto.subtle, 'digest');

    const again = await currentGeneration(runtime, PAGE, T0, keep);

    expect(again.kind).toBe('generation');
    expect(digest).not.toHaveBeenCalled();
  });
});

function called(authority: FakeAuthority, suffix: string): number {
  return authority.calls.filter((call) => call.startsWith('GET') && call.endsWith(suffix)).length;
}

describe("a generation's artifact", () => {
  /**
   * Kept for a hold, as the record it was read through is, it was read again with the record on
   * every request after — though an artifact is named by its content, and never says otherwise.
   */
  it('is read once, however many holds its generation answers across', async () => {
    const authority = await regenerated();
    let now = T0;
    const runtime = runtimeFor(authority.fetchImpl, () => now);
    const shell: Prerender = {
      id: PAGE.pathname,
      pathname: PAGE.pathname,
      route: PAGE.route,
      parentOutputId: PAGE.pathname,
      groupId: 1,
      body: { sha256: 'shell', byteLength: 17, contentType: 'text/html' },
    };
    const store = storeOf(PAGE.route, [shell]);
    const prefetch = async (): Promise<string | undefined> => {
      const response = await withClock(now, () => {
        return serveFromGeneration(
          routed(runtime, PAGE.pathname),
          store,
          payloadOf(PAGE.route, true),
          handler,
        );
      });
      return response?.text();
    };

    const first = await prefetch();
    // Well past the hold, well within the generation's own lifetime.
    now = T0 + 60 * SECOND;
    const later = await prefetch();

    expect([first, later]).toStrictEqual(['0:["the payload"]', '0:["the payload"]']);
    expect(called(authority, '/record')).toBe(2);
    expect(authority.calls.filter((call) => call.startsWith('GET /artifacts/'))).toHaveLength(1);
  });
});
