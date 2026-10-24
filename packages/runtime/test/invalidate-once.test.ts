import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestedEntryId } from '../../cache/src/function/entry-identity.ts';
import { asRegeneration, withRequestContext } from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { INVALIDATIONS_RECORDED_WITHIN_MS } from '../src/serve.ts';
import { requestKeeping } from './request-context.ts';

// Nothing here renders; the bridge's own module needs workerd.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

/**
 * An invalidation as Next.js hands it over: to every cache handler it has, in one turn — the
 * `default` and `remote` `use cache` handlers and the fetch cache (`revalidateTags`, in
 * `server/revalidation-utils.ts`). The host is asked once for it, and a host that cannot record it
 * fails nothing.
 */

const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-test',
};
const HTTP_UNAVAILABLE = 503;

function result(value: unknown): Response {
  return Response.json({ ok: true, result: value });
}

function invalidated(tags: readonly string[], at: number): Response {
  return result({
    revision: 2,
    affectedEntryIds: [],
    invalidations: tags.map((value, index) => {
      return {
        invalidationId: `invalidation-${String(index)}`,
        tagId: `tag-${String(index)}`,
        value,
        staleAt: at,
        hardExpireAt: at,
        meaning: 'immediate',
      };
    }),
  });
}

/**
 * The entry `get('key')` asks the host for, under the id the host holds an answer to
 * (`requestedEntryId`): one under any other id is refused as another's, and reads as a miss, which
 * an invalidation's hiding the value would be indistinguishable from (greptile).
 */
const FEED_ENTRY_ID = requestedEntryId(ENV.NEXT_DEPLOYMENT_ID, {
  kind: 'data:use-cache',
  handler: 'default',
  key: 'key',
});

/** A value a `use cache` function made a second ago under the tag `feed`. */
function feedEntry(timestamp: number): Response {
  return result({
    entryId: FEED_ENTRY_ID,
    generationId: 'generation',
    dependencyRevision: 0,
    entry: {
      kind: 'data:use-cache',
      handler: 'default',
      tags: ['feed'],
      stale: 60,
      timestamp,
      expire: 600,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
    value: { kind: 'inline', base64: btoa('kept') },
  });
}

function harness(answer: (tags: readonly string[]) => Promise<Response>) {
  const asked: (readonly string[])[] = [];
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => Date.now(),
    fetchImpl: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/invalidations')) {
        const { tags } = (await request.json()) as { tags: { value: string }[] };
        const values = tags.map((tag) => tag.value);
        asked.push(values);
        return answer(values);
      }
      if (url.pathname.endsWith('/tags/get')) {
        return result({ tags: [] });
      }
      return feedEntry(Date.now() - 1000);
    },
  });
  if (runtime === undefined) {
    throw new Error('no runtime');
  }
  vi.spyOn(runtime, 'log').mockImplementation(vi.fn());
  configureCacheHandlers(runtime);
  return { runtime, asked };
}

/** Every handler Next.js has, handed one invalidation in one turn, as `revalidateTags` hands it. */
function everyHandler(tags: string[], durations?: { expire?: number }): Promise<unknown> {
  return Promise.all([
    useCacheHandler('default').updateTags(tags, durations),
    useCacheHandler('remote').updateTags(tags, durations),
    new PlatformFetchCache().revalidateTag(tags, durations),
  ]);
}

describe('an invalidation every cache handler is handed', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  it('asks the host once, and tells the edge on the request’s response', async () => {
    const h = harness((tags) => Promise.resolve(invalidated(tags, Date.now())));
    const request = requestKeeping(h.runtime, []);

    await withRequestContext(request, () => everyHandler(['feed']));
    // The handlers answer once it is in force here; the request's response waits for the host.
    await request.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);

    expect(h.asked).toStrictEqual([['feed']]);
    expect([...request.invalidated.tags]).toStrictEqual(['feed']);
    expect(request.invalidated.revision).toBe(2);
  });

  /**
   * Joined within the turn Next.js asks every handler in, whatever order each names the tags in. One
   * asked a turn later is an invalidation of a later moment, which the call before — recorded
   * already, maybe — does not stand for, though it is out still: the request goes on while it is.
   */
  it('hands the handlers of one turn one call, and a later turn one of its own', async () => {
    const answered = Promise.withResolvers<undefined>();
    const h = harness(async (tags) => {
      await answered.promise;
      return invalidated(tags, Date.now());
    });

    await withRequestContext(requestKeeping(h.runtime, []), async () => {
      await Promise.all([
        useCacheHandler('default').updateTags(['feed', 'posts']),
        // In the same turn, with the tags named in another order.
        useCacheHandler('remote').updateTags(['posts', 'feed']),
      ]);
      await vi.waitFor(() => {
        expect(h.asked).toHaveLength(1);
      });
      // A turn later, with the call before still out.
      await useCacheHandler('remote').updateTags(['posts', 'feed']);
      await vi.waitFor(() => {
        expect(h.asked).toHaveLength(2);
      });
      answered.resolve(undefined);
    });

    expect(h.asked).toHaveLength(2);
  });

  it('asks again for the same tags in a later turn, which is a later moment', async () => {
    const h = harness((tags) => Promise.resolve(invalidated(tags, Date.now())));

    await withRequestContext(requestKeeping(h.runtime, []), async () => {
      await everyHandler(['feed']);
      await everyHandler(['feed']);
    });

    expect(h.asked).toHaveLength(2);
  });

  it('asks once for each window an invalidation names', async () => {
    const h = harness((tags) => Promise.resolve(invalidated(tags, Date.now())));

    await withRequestContext(requestKeeping(h.runtime, []), async () => {
      await Promise.all([everyHandler(['feed']), everyHandler(['feed'], { expire: 60 })]);
    });

    expect(h.asked).toHaveLength(2);
  });

  /** Each request's response tells the edge what that request invalidated; only its own call can. */
  it('never hands one request what another’s call came to', async () => {
    const h = harness((tags) => Promise.resolve(invalidated(tags, Date.now())));
    const first = requestKeeping(h.runtime, []);
    const second = requestKeeping(h.runtime, []);

    await Promise.all([
      withRequestContext(first, () => everyHandler(['feed'])),
      withRequestContext(second, () => everyHandler(['feed'])),
    ]);
    await Promise.all([
      first.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS),
      second.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS),
    ]);

    expect(h.asked).toHaveLength(2);
    expect([...first.invalidated.tags]).toStrictEqual(['feed']);
    expect([...second.invalidated.tags]).toStrictEqual(['feed']);
  });

  /**
   * The request has made the change the invalidation is for: failing it would invite the person who
   * made it to make it again.
   */
  it('logs one the host could not record, fails nothing, and holds it in force here', async () => {
    const h = harness(() => Promise.resolve(new Response('down', { status: HTTP_UNAVAILABLE })));
    const handler = useCacheHandler('default');

    // Read before it, the value is there to hide.
    await expect(handler.get('key', [])).resolves.toBeDefined();

    const request = requestKeeping(h.runtime, []);

    await expect(withRequestContext(request, () => everyHandler(['feed']))).resolves.toBeDefined();

    await request.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);

    expect(h.asked).toHaveLength(1);
    expect(h.runtime.log).toHaveBeenCalledWith(
      'tag invalidation failed',
      expect.objectContaining({ tags: 'feed' }),
    );
    // What the tag carried, made before it, is not served in this isolate.
    await expect(handler.get('key', [])).resolves.toBeUndefined();
  });

  /**
   * Next.js runs a route handler's revalidations behind its response (`pendingWaitUntil`, in
   * `app-route/module.ts`), and whoever made the request moves on once its headers come. The
   * response is not answered before the host has recorded the call (`InvalidatedTags`): a request
   * made once it was answered finds the invalidation recorded, in whatever isolate it lands.
   */
  it('holds the request’s response until the host has recorded it', async () => {
    const answered = Promise.withResolvers<Response>();
    const h = harness(() => answered.promise);
    const request = requestKeeping(h.runtime, []);

    const invalidating = withRequestContext(request, () => everyHandler(['feed']));
    await vi.waitFor(() => {
      expect(h.asked).toHaveLength(1);
    });
    const whileOut = request.invalidated.pending;
    answered.resolve(invalidated(['feed'], Date.now()));
    await invalidating;

    expect(whileOut).toBe(true);

    await vi.waitFor(() => {
      expect(request.invalidated.pending).toBe(false);
    });
  });

  /**
   * Kept going past the response, as a write is: one the host has not answered by the time the
   * response is answered is still recorded.
   */
  it('hands its call to the request’s waitUntil, once, a regeneration’s as well', async () => {
    const h = harness((tags) => Promise.resolve(invalidated(tags, Date.now())));
    const kept: Promise<unknown>[] = [];
    const regenerating: Promise<unknown>[] = [];

    await withRequestContext(requestKeeping(h.runtime, kept), () => everyHandler(['feed']));
    await withRequestContext(requestKeeping(h.runtime, regenerating), () =>
      asRegeneration(() => everyHandler(['posts'])),
    );

    expect(kept).toHaveLength(1);
    expect(regenerating).toHaveLength(1);
  });

  /** A regeneration's response served what was there before: it is not held for the call. */
  it('holds no response for a regeneration’s', async () => {
    const answered = Promise.withResolvers<Response>();
    const h = harness(() => answered.promise);
    const request = requestKeeping(h.runtime, []);

    const invalidating = withRequestContext(request, () =>
      asRegeneration(() => everyHandler(['feed'])),
    );
    await vi.waitFor(() => {
      expect(h.asked).toHaveLength(1);
    });
    const whileOut = request.invalidated.pending;
    answered.resolve(invalidated(['feed'], Date.now()));
    await invalidating;

    expect(whileOut).toBe(false);
  });

  it('is in force here before the host has answered', async () => {
    const answered = Promise.withResolvers<Response>();
    const h = harness(() => answered.promise);
    const handler = useCacheHandler('default');

    // Read before it, the value is there to hide.
    await expect(handler.get('key', [])).resolves.toBeDefined();

    const invalidating = withRequestContext(requestKeeping(h.runtime, []), () =>
      everyHandler(['feed']),
    );
    await vi.waitFor(() => {
      expect(h.asked).toHaveLength(1);
    });

    await expect(handler.get('key', [])).resolves.toBeUndefined();

    answered.resolve(invalidated(['feed'], Date.now()));
    await invalidating;
  });

  /**
   * The host stamps the invalidation by its own clock, which may read later than this one: what
   * tells a view that held it from one that did not is the revision the host recorded it at, kept
   * with the mark it leaves here once the host has answered.
   */
  it('keeps the revision the host recorded it at with the mark it leaves here', async () => {
    const stamped = Date.now() + 60_000;
    const h = harness((tags) => Promise.resolve(invalidated(tags, stamped)));
    const madeBefore = Date.now();

    const request = requestKeeping(h.runtime, []);
    await withRequestContext(request, () => everyHandler(['feed']));
    await request.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);

    // The answer's revision is 2: a view brought up to it held the invalidation, one at 1 did not.
    expect(h.runtime.tags.validityOf(['feed'], madeBefore, stamped + 1, 2)).toBe('fresh');
    expect(h.runtime.tags.validityOf(['feed'], madeBefore, stamped + 1, 1)).toBe('expired');
  });
});
