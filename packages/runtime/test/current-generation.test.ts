import { policyFromCacheControl, type RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { withClock } from '../src/cache/clock.ts';
import { currentGeneration, type CurrentLookup } from '../src/cache/current.ts';
import type { FetchLike } from '../src/cache/host.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

/**
 * How the Worker judges an entry's current generation: on what its record says, and on what the
 * isolate itself knows of the generation's tags. A page this Worker revalidated was answered as it
 * was for as long as the record read before the invalidation was kept — the record said nothing
 * of it yet, and the tag state that did was never asked.
 *
 * And how it reads the record: once for every request that wants it while the read runs, kept for
 * the next request whenever the host answers, and never kept once a regeneration has overtaken it.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_currentGenerationTest';
const T0 = 1_800_000_000_000;
const SECOND = 1000;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const PAGE: RouteEntryDescriptor = {
  kind: 'app-page',
  route: '/legacy/static',
  pathname: '/legacy/static',
};
const PAGE_TAG = '_N_T_/legacy/static';
const FEED: RouteEntryDescriptor = { kind: 'app-route', route: '/api/feed', pathname: '/api/feed' };
const LIFETIME = policyFromCacheControl({ revalidate: 900, expire: 31_536_000 });

/** What the Worker is handed to keep a read going: nothing here outlives the test that made it. */
function ignore(): void {
  /* The reads a test makes are awaited by the test itself. */
}

async function recorded(fetchImpl?: (authority: FakeAuthority) => FetchLike) {
  const authority = fakeAuthority(SCOPE);
  await authority.record(
    PAGE,
    {
      cacheTimestamp: T0,
      policy: LIFETIME,
      status: 200,
      headers: {},
      tags: [{ kind: 'next-implicit', value: PAGE_TAG }],
    },
    new TextEncoder().encode('<html>page</html>'),
    'build',
  );
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => T0,
    fetchImpl: fetchImpl?.(authority) ?? authority.fetchImpl,
  });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return { authority, runtime };
}

async function validityAt(runtime: CacheRuntime, now: number) {
  const lookup = await currentGeneration(runtime, PAGE, now, ignore);
  return lookup.kind === 'generation' ? lookup.current.validity : lookup.kind;
}

describe('the current generation, as the Worker judges it', () => {
  it('is past serving at once once this isolate invalidated one of its tags outright', async () => {
    const { runtime } = await recorded();

    await expect(validityAt(runtime, T0 + SECOND)).resolves.toBe('fresh');

    runtime.tags.applyLocal([PAGE_TAG], {
      staleAt: T0 + 2 * SECOND,
      hardExpireAt: T0 + 2 * SECOND,
    });

    await expect(validityAt(runtime, T0 + 3 * SECOND)).resolves.toBe('expired');
  });

  it('is stale while an invalidation this isolate made leaves it a window', async () => {
    const { runtime } = await recorded();
    await validityAt(runtime, T0 + SECOND);

    runtime.tags.applyLocal([PAGE_TAG], {
      staleAt: T0 + 2 * SECOND,
      hardExpireAt: T0 + 60 * SECOND,
    });

    await expect(validityAt(runtime, T0 + 3 * SECOND)).resolves.toBe('stale');
  });

  it('is not touched by an invalidation of a tag it does not carry', async () => {
    const { runtime } = await recorded();

    runtime.tags.applyLocal(['_N_T_/other'], { staleAt: T0, hardExpireAt: T0 });

    await expect(validityAt(runtime, T0 + SECOND)).resolves.toBe('fresh');
  });
});

/** An authority whose record reads are made at once, and whose answers wait until released. */
/** A promise that rejects as `signal` aborts, with what it was aborted for. */
async function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason as Error);
    };
    // A signal aborted already fires no event for a listener added after.
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function slowRecords(inner: FetchLike): {
  fetchImpl: FetchLike;
  release: () => void;
  calledOff: () => number;
} {
  const gate = Promise.withResolvers<true>();
  const state = { calledOff: 0 };
  return {
    fetchImpl: async (request) => {
      const answer = await inner(request);
      if (new URL(request.url).pathname.endsWith('/record')) {
        // Held until released, or until the read is called off.
        try {
          await Promise.race([gate.promise, abortedBy(request.signal)]);
        } catch (error) {
          state.calledOff += 1;
          throw error;
        }
      }
      return answer;
    },
    release: () => {
      gate.resolve(true);
    },
    calledOff: () => state.calledOff,
  };
}

function entryIdOf(lookup: CurrentLookup): string {
  return lookup.kind === 'generation' ? lookup.current.entryId : lookup.entryId;
}

function recordReads(authority: FakeAuthority): number {
  return authority.calls.filter((call) => call.endsWith('/record')).length;
}

describe("the Worker's read of a record", () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  /**
   * Each request used to read for itself and throw away what came after its deadline: while the
   * host was slow to answer, every request waited the whole deadline, asked again, and left the
   * next one nothing.
   */
  it('asks once for the requests that want it together, and keeps what came late', async () => {
    let slow: ReturnType<typeof slowRecords> | undefined;
    const { authority, runtime } = await recorded((fake) => {
      slow = slowRecords(fake.fetchImpl);
      return slow.fetchImpl;
    });
    vi.spyOn(runtime, 'log').mockImplementation(() => {
      /* The reads the deadline gives up on are expected here. */
    });
    const background: Promise<unknown>[] = [];
    const keep = (promise: Promise<unknown>): void => {
      background.push(promise);
    };

    // Both are let go at their own deadline, with the read still unanswered.
    const waited = await Promise.all([
      currentGeneration(runtime, PAGE, T0 + SECOND, keep),
      currentGeneration(runtime, PAGE, T0 + SECOND, keep),
    ]);
    slow?.release();
    await Promise.all(background);
    const next = await currentGeneration(runtime, PAGE, T0 + SECOND, keep);

    expect(waited.map((lookup) => lookup.kind)).toStrictEqual(['unavailable', 'unavailable']);
    expect(next.kind).toBe('generation');
    expect(recordReads(authority)).toBe(1);
  });

  /**
   * A read leaves the reads in flight only once it settles, and one the host never answers never
   * does: every entry a visitor named while the host hung was kept for the life of the isolate.
   */
  it('lets go of a read the host never answered once its hold is over', async () => {
    let slow: ReturnType<typeof slowRecords> | undefined;
    const { runtime } = await recorded((fake) => {
      slow = slowRecords(fake.fetchImpl);
      return slow.fetchImpl;
    });
    vi.spyOn(runtime, 'log').mockImplementation(() => {
      /* The reads the deadline gives up on are expected here. */
    });

    const hung = await currentGeneration(runtime, PAGE, T0 + SECOND, ignore);
    const held = runtime.recordReads.has(entryIdOf(hung));
    const after = await currentGeneration(runtime, FEED, T0 + SECOND + runtime.holdMs, ignore);
    const reads = [...runtime.recordReads.keys()];
    slow?.release();

    expect(held).toBe(true);
    expect(reads).toStrictEqual([entryIdOf(after)]);
  });

  /**
   * The table lets go of the reads a hold has passed, but a read let go of is still out until it
   * settles, is called off, or its request ends. Begun beside the ones the host is not answering,
   * another waits out its deadline as they do: past the budget none is begun, until those are
   * called off — as each is once it has been out for as long as a read can be, on the isolate's own
   * clock, whatever clock the request acts at.
   */
  it('keeps no more reads out than its budget, however many entries are named', async () => {
    // Turns of the event loop for what is not on the clock — the digests, the reads — between short
    // steps of the clock, which moves no further than the deadlines it waits out need.
    const MAX_TURNS = 200_000;
    const TURNS_A_STEP = 20;
    const STEP_MS = 10;
    // Past the 200 ms deadlines the reads are given, and well short of a read's 30 s lifetime.
    const MAX_MOVED_MS = 2 * SECOND;
    let slow: ReturnType<typeof slowRecords> | undefined;
    const { authority, runtime } = await recorded((fake) => {
      slow = slowRecords(fake.fetchImpl);
      return slow.fetchImpl;
    });
    vi.spyOn(runtime, 'log').mockImplementation(() => {
      /* The reads the deadline gives up on, and those not begun, are expected here. */
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const named = async (index: number, now: number): Promise<CurrentLookup> => {
      const descriptor = {
        kind: 'app-page',
        route: '/[id]',
        pathname: `/${String(index)}`,
      } as const;
      return currentGeneration(runtime, descriptor, now, ignore);
    };
    // The clock moved on in steps until the work has its answer.
    const answered = async <T>(work: Promise<T>): Promise<T> => {
      const state = { done: false };
      const settled = (async () => {
        try {
          return await work;
        } finally {
          state.done = true;
        }
      })();
      let moved = 0;
      for (let turn = 1; turn <= MAX_TURNS && !state.done; turn += 1) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (turn % TURNS_A_STEP === 0 && moved < MAX_MOVED_MS) {
          await vi.advanceTimersByTimeAsync(STEP_MS);
          moved += STEP_MS;
        }
      }
      return settled;
    };

    await answered(
      Promise.all(Array.from({ length: 300 }, async (_, index) => named(index, T0 + SECOND))),
    );
    const inFlight = runtime.recordReads.size;
    const asked = recordReads(authority);
    // Past a hold, the reads still out are not joined, and none is begun beside them — even at a
    // request clock far past a read's lifetime.
    await answered(named(300, T0 + SECOND + 60 * SECOND));
    const pastHold = recordReads(authority);
    // Past a read's lifetime on the isolate's clock, they are called off, and their places freed.
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    const calledOff = slow?.calledOff();
    await answered(named(301, T0 + 32 * SECOND));
    const pastLifetime = recordReads(authority);
    slow?.release();
    vi.useRealTimers();

    expect(inFlight).toBe(256);
    expect([asked, pastHold, pastLifetime]).toStrictEqual([256, 256, 257]);
    expect(calledOff).toBe(256);
  });

  /**
   * A read answered after a regeneration published the entry says what the entry was; kept, it
   * would answer the requests after it with the generation the regeneration replaced.
   */
  it('keeps nothing of a read a regeneration overtook', async () => {
    let slow: ReturnType<typeof slowRecords> | undefined;
    const { authority, runtime } = await recorded((fake) => {
      slow = slowRecords(fake.fetchImpl);
      return slow.fetchImpl;
    });
    await authority.record(
      FEED,
      { cacheTimestamp: T0, policy: LIFETIME, status: 200, headers: {}, tags: [] },
      new TextEncoder().encode('kept'),
      'build',
    );
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      new Response('regenerated', { headers: { 'cache-control': 's-maxage=900' } }),
    );
    const reads: Promise<unknown>[] = [];
    const keepRead = (promise: Promise<unknown>): void => {
      reads.push(promise);
    };
    const published: Promise<unknown>[] = [];

    const overtaken = currentGeneration(runtime, FEED, T0 + SECOND, keepRead);
    await vi.waitFor(() => {
      expect(recordReads(authority)).toBe(1);
    });
    const outcome = await withClock(T0 + SECOND, () => {
      return regenerate({
        runtime,
        request: new Request('https://app.test/api/feed'),
        handler: () => Promise.reject(new Error('the bridge is replaced')),
        target: { descriptor: FEED, reason: 'manual' },
        previewToken: undefined,
        waitUntil: (promise) => {
          published.push(promise);
        },
        run: (work) => work(),
      });
    });
    await Promise.all(published);
    slow?.release();
    await overtaken;
    await Promise.all(reads);
    const next = await currentGeneration(runtime, FEED, T0 + 2 * SECOND, keepRead);

    expect(authority.commits).toHaveLength(1);
    expect(outcome.kind).not.toBe('failed');
    expect(next.kind === 'generation' && new TextDecoder().decode(next.current.pack.html)).toBe(
      'regenerated',
    );
  });
});
