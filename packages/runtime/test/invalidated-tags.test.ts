import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  invalidatedTagsMatcher,
  invalidatedTagsValue,
} from '../../core/src/paas/protocol.ts';
import { InvalidatedTags, requestContextFor, withRequestContext } from '../src/cache/context.ts';
import { configureCacheHandlers, useCacheHandler } from '../src/cache/handlers.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { INVALIDATIONS_RECORDED_WITHIN_MS, withInvalidatedTags } from '../src/serve.ts';

// Nothing here renders; the bridge's own module needs workerd.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

/**
 * What a request invalidated at once, said on its response for the edge (`INVALIDATED_TAGS_HEADER`):
 * the edge condemns what it holds that carries those tags, so the request after a Server Action's
 * `updateTag` reads what the invalidation wrote (README, "ISR and the runtime cache").
 */

const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-test',
};

/** A runtime whose authority records every invalidation it is asked for, and has no tag on record. */
function invalidating() {
  return createCacheRuntime({
    env: ENV,
    now: () => Date.now(),
    fetchImpl: (request) => {
      const answer = request.url.endsWith('/invalidations')
        ? { revision: 2, affectedEntryIds: [], invalidations: [] }
        : { tags: [] };
      return Promise.resolve(Response.json({ ok: true, result: answer }));
    },
  });
}

/** Whether `promise` has settled by the time the microtasks queued now have run. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  const state = { settled: false };
  const watch = async (): Promise<void> => {
    try {
      await promise;
    } finally {
      state.settled = true;
    }
  };
  void watch().catch(() => {
    // Settled all the same.
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return state.settled;
}

/**
 * The invalidations a request asked the host for, which its response is not answered before
 * (`handleRequest`): whoever made it moves on once the headers come.
 */
describe('the invalidations a request asked for', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('are waited for, with those asked for while the others were waited for', async () => {
    const invalidated = new InvalidatedTags();
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<undefined>();
    invalidated.hold(first.promise);
    const recorded = invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);
    invalidated.hold(second.promise);
    first.resolve(undefined);

    await expect(settledYet(recorded)).resolves.toBe(false);

    second.resolve(undefined);

    await expect(recorded).resolves.toBeUndefined();
    expect(invalidated.pending).toBe(false);
  });

  it('are waited for no longer than the bound', async () => {
    // The bound's timer alone: what the checks below queue runs as it would.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const invalidated = new InvalidatedTags();
    invalidated.hold(Promise.withResolvers<never>().promise);
    const recorded = invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);

    await vi.advanceTimersByTimeAsync(INVALIDATIONS_RECORDED_WITHIN_MS - 1);

    await expect(settledYet(recorded)).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(recorded).resolves.toBeUndefined();
    expect(invalidated.pending).toBe(true);
  });

  it('hold nothing where the request asked for none', async () => {
    const invalidated = new InvalidatedTags();

    await expect(settledYet(invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS))).resolves.toBe(
      true,
    );
  });
});

describe('what a request invalidated at once', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  it('is kept for its response: updateTag and a revalidation with no window, not one with a window', async () => {
    const runtime = invalidating();
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const context = requestContextFor({
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime,
      request: new Request('https://fixture.test/', { method: 'POST' }),
      startedAt: Date.now(),
      waitUntil: () => {
        // Nothing here outlives the request.
      },
      clock: undefined,
    });

    await withRequestContext(context, async () => {
      await handler.updateTags(['posts']);
      await handler.updateTags(['soft'], { expire: 60 });
      await handler.updateTags(['hard'], { expire: 0 });
    });
    // The handlers answer once it is in force here; the request's response waits for the host.
    await context.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);

    expect([...context.invalidated.tags]).toStrictEqual(['posts', 'hard']);
    // The revision the authority recorded them at, as its answer to the invalidation gave it.
    expect(context.invalidated.revision).toBe(2);
  });

  it('is said on the response, in place of anything the application said under those names', () => {
    const forged = {
      headers: { [INVALIDATED_TAGS_HEADER]: 'everything', [INVALIDATED_REVISION_HEADER]: '999' },
    };
    const invalidated = new InvalidatedTags();
    invalidated.add(['a,b', 'c*'], 12);

    const told = withInvalidatedTags(new Response('ok', forged), invalidated);
    const quiet = withInvalidatedTags(new Response('ok', forged), new InvalidatedTags());

    expect(told.headers.get(INVALIDATED_TAGS_HEADER)).toBe('a%2Cb,c%2A');
    expect(told.headers.get(INVALIDATED_REVISION_HEADER)).toBe('12');
    expect(quiet.headers.has(INVALIDATED_TAGS_HEADER)).toBe(false);
    expect(quiet.headers.has(INVALIDATED_REVISION_HEADER)).toBe(false);
  });

  it('names no revision once one of its invalidations came without one', () => {
    const invalidated = new InvalidatedTags();
    invalidated.add(['a'], 3);
    invalidated.add(['b'], undefined);

    const told = withInvalidatedTags(new Response('ok'), invalidated);

    expect(told.headers.get(INVALIDATED_TAGS_HEADER)).toBe('a,b');
    expect(told.headers.has(INVALIDATED_REVISION_HEADER)).toBe(false);
  });

  it('reads back as a test of the tags a record carries and when it was written', () => {
    const touched = invalidatedTagsMatcher(invalidatedTagsValue(['a,b', 'c*']), '12');
    const unbounded = invalidatedTagsMatcher(invalidatedTagsValue(['a,b']));
    const every = invalidatedTagsMatcher(invalidatedTagsValue(['\u{D800}']), '7');

    expect(touched(['a,b'], 11)).toBe(true);
    expect(touched(['a,b'], 12)).toBe(false);
    expect(touched(['c*', 'other'], 3)).toBe(true);
    expect(touched(['a', 'b'], 3)).toBe(false);
    expect(unbounded(['a,b'], 999)).toBe(true);
    expect(every(['anything'], 6)).toBe(true);
    expect(every(['anything'], 7)).toBe(false);
    expect(every([], 1)).toBe(false);
  });
});
