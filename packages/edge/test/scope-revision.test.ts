import {
  parseScopeRevision,
  PLATFORM_REQUEST_HEADERS,
  SCOPE_REVISION_HEADER,
  scopeRevisionValue,
} from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Gateway } from '../../cache/src/function/gateway.ts';
import { withClock } from '../../runtime/src/cache/clock.ts';
import type { CacheHost, FetchLike } from '../../runtime/src/cache/host.ts';
import { catchUpWithScope } from '../../runtime/src/cache/pulls.ts';
import { type CacheRuntime, createCacheRuntime } from '../../runtime/src/cache/runtime.ts';
import { takeInvalidation } from '../src/cache/condemned.ts';
import { withScopeRevision } from '../src/cache/scope-signal.ts';
import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';

// The cache host the runtime is built with, as an application's Function is: this repository's own,
// handed the gateway URLs and token of `ENV`.
vi.mock(import('arkor:cache-host'), () => import('../../cache/src/function/host.ts'));

/**
 * Where a request's scope stands, as the edge says it (`SCOPE_REVISION_HEADER`) or the host knows it
 * nearby (`CacheHost.scopeRevision`): an isolate whose view of the tags is behind a recent
 * invalidation brings it up before the request is judged, joining a pull that is out, for a second
 * at the most. One that is not behind, or behind an invalidation long past, asks nothing.
 */

const SCOPE = 'dpl_scopeRevisionTest00';
const T0 = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** How many pages that do not move it on a test's authority answers before it answers no more. */
const STUCK_PAGES = 3;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};

describe('an Action response before the authority view catches up', () => {
  it('makes another Function isolate miss data the Action expired', async () => {
    const authority = authorityAhead();
    const reader = runtimeFor(authority.fetchImpl);
    const edge = {
      memory: createEdgeMemory(() => T0),
    } as EdgeRuntime;
    edge.memory.scopes.set(SCOPE, { revision: 0, invalidatedAt: null, checkedAt: T0 });
    const before = reader.tags.validityOf(['products'], T0 - 2 * SECOND, T0);
    takeInvalidation(edge.memory, SCOPE, { value: 'products', bound: '7' });
    const request = withScopeRevision(edge, SCOPE, new Request('https://app.test/revalidate'));
    const behind: Promise<unknown>[] = [];

    await withClock(T0, () => {
      return catchUpWithScope(reader, request, (work) => {
        behind.push(work);
      });
    });
    await Promise.all(behind);

    expect(before).toBe('fresh');
    expect(reader.tags.validityOf(['products'], T0 - 2 * SECOND, T0)).toBe('expired');
    expect(reader.tags.validityOf(['unrelated'], T0 - 2 * SECOND, T0)).toBe('fresh');
    expect(authority.pulls()).toBe(1);
    expect(edge.memory.scopes.get(SCOPE)?.revision).toBe(0);

    await withClock(T0, () => {
      return catchUpWithScope(reader, request, (work) => {
        behind.push(work);
      });
    });
    await Promise.all(behind);

    expect(authority.pulls()).toBe(1);
  });
});

interface Authority {
  readonly fetchImpl: FetchLike;
  /** How many times the delta was asked for. */
  readonly pulls: () => number;
  /** Let the delta answer, where it was held. */
  readonly release: () => void;
}

/** A complete delta whose revision and mark can be accepted once its host answers. */
function deltaAtSeven(): Awaited<ReturnType<Gateway['tagsDelta']>> {
  return {
    revision: 7,
    floor: 0,
    truncated: false,
    tags: [
      {
        tagId: 'tag-products',
        kind: 'next-explicit',
        value: 'products',
        revision: 7,
        staleAt: T0 - SECOND,
        hardExpireAt: T0 - SECOND,
        meaning: 'immediate',
      },
    ],
  };
}

/** An authority whose delta stands at revision 7, its answers held until released where asked. */
function authorityAhead(options: { readonly held?: boolean } = {}): Authority {
  const gate = Promise.withResolvers<true>();
  if (options.held !== true) {
    gate.resolve(true);
  }
  let pulls = 0;
  return {
    pulls: () => pulls,
    release: () => {
      gate.resolve(true);
    },
    fetchImpl: async (request) => {
      if (new URL(request.url).pathname.endsWith('/tags/delta')) {
        pulls += 1;
        await gate.promise;
        return Response.json({
          ok: true,
          result: deltaAtSeven(),
        });
      }
      return new Response('not a tag route', { status: 500 });
    },
  };
}

function runtimeFor(fetchImpl: FetchLike): CacheRuntime {
  const runtime = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

/** `runtime` with its host saying where the scope stands as `scopeRevision` answers. */
function hostSaying(
  runtime: CacheRuntime,
  scopeRevision: CacheHost['scopeRevision'],
): CacheRuntime {
  const host = new Proxy(runtime.host, {
    get(target, property) {
      if (property === 'scopeRevision') {
        return scopeRevision;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { ...runtime, host };
}

/** A request that says its scope stands at `revision`, invalidated `ago` before `T0`. */
function requestAt(revision: number, ago: number | null): Request {
  const invalidatedAt = ago === null ? null : T0 - ago;
  return new Request('https://app.test/page', {
    headers: { [SCOPE_REVISION_HEADER]: scopeRevisionValue({ revision, invalidatedAt }) },
  });
}

async function caughtUp(
  runtime: CacheRuntime,
  request: Request,
  behind: Promise<unknown>[] = [],
): Promise<void> {
  await withClock(T0, async () => {
    await catchUpWithScope(runtime, request, (promise) => {
      behind.push(promise);
    });
  });
}

describe('the scope revision a request carries', () => {
  it('reads back as it was written, and not at all where it does not read', () => {
    expect(
      parseScopeRevision(scopeRevisionValue({ revision: 7, invalidatedAt: T0 })),
    ).toStrictEqual({ revision: 7, invalidatedAt: T0 });
    expect(
      parseScopeRevision(scopeRevisionValue({ revision: 0, invalidatedAt: null })),
    ).toStrictEqual({ revision: 0, invalidatedAt: null });
    expect(
      ['', '7', '7;', 'x;1', '7;x', '-1;1', '7;1;2', '1.5;1'].filter(
        (value) => parseScopeRevision(value) !== undefined,
      ),
    ).toStrictEqual([]);
    expect(parseScopeRevision(null)).toBeUndefined();
  });

  it('is written in whole numbers, so a moment kept to a fraction of one still reads', () => {
    expect(
      parseScopeRevision(scopeRevisionValue({ revision: 7, invalidatedAt: T0 + 0.25 })),
    ).toStrictEqual({ revision: 7, invalidatedAt: T0 });
  });

  it('is one of the headers the application never sees', () => {
    expect(PLATFORM_REQUEST_HEADERS).toContain(SCOPE_REVISION_HEADER);
  });
});

describe('an isolate whose view of the tags is behind its scope', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('brings the view up before the request goes on', async () => {
    const authority = authorityAhead();
    const runtime = runtimeFor(authority.fetchImpl);

    await caughtUp(runtime, requestAt(7, SECOND));

    expect(authority.pulls()).toBe(1);
    expect(runtime.tags.revision).toBe(7);
    expect(runtime.tags.validityOf(['products'], T0 - 2 * SECOND, T0)).toBe('expired');
  });

  it('asks nothing where the view is not behind, the invalidation is long past, or there is none', async () => {
    const authority = authorityAhead();
    const runtime = runtimeFor(authority.fetchImpl);
    await caughtUp(runtime, requestAt(7, SECOND));

    await caughtUp(runtime, requestAt(7, SECOND));
    await caughtUp(runtime, requestAt(5, SECOND));
    await caughtUp(runtimeFor(authority.fetchImpl), requestAt(9, 11 * MINUTE));
    await caughtUp(runtimeFor(authority.fetchImpl), requestAt(9, null));
    await caughtUp(runtimeFor(authority.fetchImpl), new Request('https://app.test/page'));

    expect(authority.pulls()).toBe(1);
  });

  it('pulls once for the requests that find it behind together', async () => {
    const authority = authorityAhead({ held: true });
    const runtime = runtimeFor(authority.fetchImpl);

    const both = Promise.all([
      caughtUp(runtime, requestAt(7, SECOND)),
      caughtUp(runtime, requestAt(7, SECOND)),
    ]);
    await vi.waitFor(() => {
      expect(authority.pulls()).toBe(1);
    });
    authority.release();
    await both;

    expect(authority.pulls()).toBe(1);
    expect(runtime.tags.revision).toBe(7);
  });

  it('goes on after a second without a custom host pull, and keeps it going behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const authority = authorityAhead();
    const runtime = runtimeFor(authority.fetchImpl);
    const delta = Promise.withResolvers<Awaited<ReturnType<CacheHost['tagsDelta']>>>();
    // A custom host's own operation has no Gateway transport deadline. The caller still leaves
    // after its second and retains that operation behind it, as it did before Gateway reads ended.
    const pull = vi.spyOn(runtime.host, 'tagsDelta').mockImplementation(() => delta.promise);
    const behind: Promise<unknown>[] = [];
    const state = { done: false };
    const going = (async () => {
      await caughtUp(runtime, requestAt(7, SECOND), behind);
      state.done = true;
    })();
    try {
      await vi.advanceTimersByTimeAsync(SECOND - 1);
      const beforeTheSecond = state.done;
      await vi.advanceTimersByTimeAsync(1);
      await going;
      const beforeRelease = runtime.tags.revision;
      delta.resolve(deltaAtSeven());
      await Promise.all(behind);

      expect(beforeTheSecond).toBe(false);
      expect(beforeRelease).toBe(0);
      expect(behind).toHaveLength(1);
      expect(pull).toHaveBeenCalledTimes(1);
      expect(runtime.tags.revision).toBe(7);
    } finally {
      delta.resolve(deltaAtSeven());
      pull.mockRestore();
      await going;
      await Promise.all(behind);
    }
  });

  it('discards a late Gateway delta after its second and lets the next request pull again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const authority = authorityAhead({ held: true });
    const sent: Promise<Response>[] = [];
    const send = vi.fn<FetchLike>((request) => {
      const response = authority.fetchImpl(request);
      sent.push(response);
      return response;
    });
    const runtime = runtimeFor(send);
    const behind: Promise<unknown>[] = [];
    const state = { done: false };
    const going = (async () => {
      await caughtUp(runtime, requestAt(7, SECOND), behind);
      state.done = true;
    })();
    try {
      await vi.advanceTimersByTimeAsync(SECOND - 1);
      const beforeTheSecond = state.done;
      await vi.advanceTimersByTimeAsync(1);
      await going;
      const atDeadline = {
        done: state.done,
        revision: runtime.tags.revision,
        aborted: send.mock.calls[0]?.[0].signal.aborted,
      };
      authority.release();
      const replies = await Promise.all(sent);
      await Promise.all(behind);
      const afterLate = runtime.tags.revision;
      await caughtUp(runtime, requestAt(7, SECOND));

      expect(beforeTheSecond).toBe(false);
      expect(atDeadline).toStrictEqual({ done: true, revision: 0, aborted: true });
      expect(behind).toHaveLength(1);
      expect(afterLate).toBe(0);
      expect(replies[0]?.bodyUsed).toBe(true);
      expect({ revision: runtime.tags.revision, pulls: authority.pulls() }).toStrictEqual({
        revision: 7,
        pulls: 2,
      });
    } finally {
      authority.release();
      await going;
      await Promise.all(sent);
      await Promise.all(behind);
    }
  });

  it('asks its host where the scope stands where the request says nothing', async () => {
    const authority = authorityAhead();
    const scopeRevision = vi.fn(() => Promise.resolve({ revision: 7, invalidatedAt: T0 - SECOND }));
    const told = hostSaying(runtimeFor(authority.fetchImpl), scopeRevision);
    const said = hostSaying(runtimeFor(authority.fetchImpl), scopeRevision);

    await caughtUp(told, new Request('https://app.test/page'));
    // The request says where it stands, and the host is not asked: not behind, nothing is pulled.
    await caughtUp(said, requestAt(0, SECOND));

    expect(scopeRevision).toHaveBeenCalledTimes(1);
    expect(told.tags.revision).toBe(7);
    expect(said.tags.revision).toBe(0);
  });
});

describe("an isolate pulling its scope's delta", () => {
  /**
   * A page that is not the last is read on from its revision, so one whose revision does not move
   * past where it was asked from would be asked for, and answered, the same way for ever. Such an
   * authority is given up on after a few pages here, so a pull that went on asking stops all the same.
   */
  it('asks no more of a delta whose truncated page does not move past where it was asked from', async () => {
    let pulls = 0;
    const runtime = runtimeFor((request) => {
      if (!new URL(request.url).pathname.endsWith('/tags/delta')) {
        return Promise.resolve(new Response('not a tag route', { status: 500 }));
      }
      pulls += 1;
      if (pulls > STUCK_PAGES) {
        return Promise.resolve(new Response('given up on', { status: 500 }));
      }
      const page = { revision: 0, floor: 0, truncated: true, tags: [] };
      return Promise.resolve(Response.json({ ok: true, result: page }));
    });

    await expect(runtime.tags.sync(runtime.host, T0, { force: true })).resolves.toBe(false);
    expect(pulls).toBe(1);
  });

  /**
   * A page with more to follow stands no later than the latest invalidation it reports. One past it
   * would bring the view to a revision whose invalidations it never heard of, which a regeneration
   * would claim it had judged its reads against: it is refused, and the view stays where it stood.
   */
  it('stays where it stood when a truncated page stands past the latest invalidation it reports', async () => {
    const latest = { revision: 7, invalidatedAt: T0 - SECOND };
    const runtime = runtimeFor((request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/tags/delta')) {
        return Promise.resolve(new Response('not a tag route', { status: 500 }));
      }
      // Taken at its word, the first page would bring the view to 9, and the next end it there.
      const truncated = url.searchParams.get('since') === '0';
      const page = { revision: 9, floor: 0, truncated, tags: [], latest };
      return Promise.resolve(Response.json({ ok: true, result: page }));
    });

    await expect(runtime.tags.sync(runtime.host, T0, { force: true })).resolves.toBe(false);
    expect(runtime.tags.revision).toBe(0);
  });
});
