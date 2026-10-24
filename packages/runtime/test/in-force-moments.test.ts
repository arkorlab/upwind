import { deriveEntry } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withClock } from '../src/cache/clock.ts';
import { withRequestContext } from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { requestKeeping } from './request-context.ts';

/**
 * What a Server Action's request tells the authority, through the Function's host: the
 * moment its invalidation was put in force in the isolate (`inForceAt`), which the authority
 * records it at, and the moments of what the request wrote — past that moment where the request
 * began a value after its invalidation, its own where it began it before (`own-marks.ts`, in
 * `upwind/packages/runtime`). What the authority keeps and condemns by that moment is
 * `apps/cache`'s to say (`data-fencing.test.ts`).
 */

const NOW = 1_800_000_000_000;
const SCOPE = 'scope-test';
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const HTTP_NOT_FOUND = 404;

function result(value: unknown): Response {
  return Response.json({ ok: true, result: value });
}

interface Invalidation {
  readonly tags: readonly { readonly value: string }[];
  readonly inForceAt?: unknown;
}

interface Write {
  readonly key: string;
  readonly entry: { readonly kind: string; readonly handler?: string; readonly timestamp: number };
}

/** The authority, as far as this request reaches it: it records, it keeps, and it holds nothing. */
function harness() {
  const invalidations: Invalidation[] = [];
  const writes: Write[] = [];
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => NOW,
    fetchImpl: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith('/invalidations')) {
        const asked = (await request.json()) as Invalidation;
        invalidations.push(asked);
        const at = typeof asked.inForceAt === 'number' ? asked.inForceAt : NOW;
        return result({
          revision: 2,
          affectedEntryIds: [],
          invalidations: asked.tags.map(({ value }, index) => {
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
      if (request.method === 'PUT' && pathname.endsWith('/data')) {
        const write = (await request.json()) as Write;
        writes.push(write);
        const { entryId } = await deriveEntry(SCOPE, {
          kind: write.entry.kind === 'data:fetch' ? 'data:fetch' : 'data:use-cache',
          key: write.key,
          ...(write.entry.handler !== undefined && { handler: write.entry.handler }),
        });
        return result({ entryId, generationId: 'written', revision: 3 });
      }
      if (pathname.endsWith('/tags/get')) {
        return result({ tags: [] });
      }
      return new Response(null, { status: HTTP_NOT_FOUND });
    },
  });
  if (runtime === undefined) {
    throw new Error('no runtime');
  }
  vi.spyOn(runtime, 'log').mockImplementation(vi.fn());
  configureCacheHandlers(runtime);
  return { runtime, invalidations, writes };
}

/** Every handler Next.js has, handed `updateTag('feed')` in one turn, as `revalidateTags` hands it. */
function updateTag(): Promise<unknown> {
  return Promise.all([
    useCacheHandler('default').updateTags(['feed']),
    useCacheHandler('remote').updateTags(['feed']),
    new PlatformFetchCache().revalidateTag(['feed']),
  ]);
}

const fetchCache = new PlatformFetchCache();

function readFetched(key: string): Promise<unknown> {
  return fetchCache.get(key, { kind: 'FETCH', tags: ['feed'] });
}

function writeFetched(key: string): Promise<void> {
  return fetchCache.set(
    key,
    { kind: 'FETCH', data: { body: key }, tags: ['feed'], revalidate: 60 },
    { fetchCache: true, tags: ['feed'] },
  );
}

/** A `use cache` value, stamped as Next.js stamps one: at the clock's moment, which no I/O moved. */
function writeCached(key: string): Promise<void> {
  const value = new Blob([key]).stream();
  const entry = { value, tags: ['feed'], stale: 0, timestamp: NOW, expire: 3600, revalidate: 60 };
  return useCacheHandler('default').set(key, Promise.resolve(entry));
}

describe('a Server Action’s invalidation, and what its request wrote, told to the authority', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  it('carries the moment it was put in force, and stamps what the request began after it past it', async () => {
    const h = harness();
    const kept: Promise<unknown>[] = [];
    const request = requestKeeping(h.runtime, kept);

    await withClock(NOW, () => {
      return withRequestContext(request, async () => {
        // The action reads before it changes anything, then Next.js applies what it invalidated.
        await readFetched('read-by-the-action');
        await updateTag();
        // The page Next.js renders after it.
        await readFetched('read-by-the-page');
        await useCacheHandler('default').get('computed-by-the-page', []);
        await writeFetched('read-by-the-action');
        await writeFetched('read-by-the-page');
        await writeCached('computed-by-the-page');
      });
    });
    await Promise.all(kept);

    expect(h.invalidations).toStrictEqual([
      expect.objectContaining({ tags: [{ value: 'feed' }], inForceAt: NOW }),
    ]);
    expect(
      Object.fromEntries(h.writes.map((write) => [write.key, write.entry.timestamp])),
    ).toStrictEqual({
      'read-by-the-action': NOW,
      'read-by-the-page': NOW + 1,
      'computed-by-the-page': NOW + 1,
    });
  });

  it('stamps nothing past the invalidation for a request that made none', async () => {
    const h = harness();
    const kept: Promise<unknown>[] = [];

    await withClock(NOW, () => withRequestContext(requestKeeping(h.runtime, []), updateTag));
    await withClock(NOW, () => {
      return withRequestContext(requestKeeping(h.runtime, kept), async () => {
        await readFetched('read-elsewhere');
        await writeFetched('read-elsewhere');
      });
    });
    await Promise.all(kept);

    expect(h.writes.map((write) => write.entry.timestamp)).toStrictEqual([NOW]);
  });
});
