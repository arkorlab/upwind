import { withDeadline } from '@stayingupwind/core/util';

import { logWarn } from '../observability/logger.ts';
import { releaseLateImage } from './image-stream.ts';

/** Longest a request waits on the Cache API before optimizing instead. */
const CACHE_READ_BUDGET_MS = 100;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The cache opened and asked for `key`; nothing asked of one opened after the wait for it ended. */
async function matchOnceOpen(
  cacheName: string,
  key: Request,
  abandoned: () => boolean,
): Promise<Response | undefined> {
  const cache = await caches.open(cacheName);
  return abandoned() ? undefined : cache.match(key);
}

/**
 * An image the cache holds under `key`, looked up within `CACHE_READ_BUDGET_MS`, opening the cache
 * included (Codex): a cache that is slow to open holds the request no longer than one slow to
 * answer, and the source is fetched once the time is up. A lookup that outlives the wait asks
 * nothing more of a cache opened late, and a hit that arrives late has its body let go.
 */
export async function lookupCache(cacheName: string, key: Request): Promise<Response | undefined> {
  let lookup: Promise<Response | undefined> | undefined;
  let abandoned = false;
  try {
    lookup = matchOnceOpen(cacheName, key, () => abandoned);
    return await withDeadline(lookup, CACHE_READ_BUDGET_MS, 'image cache');
  } catch (error) {
    abandoned = true;
    // The deadline ends this wait, not the cache read. No response owns a hit that arrives later.
    void releaseLateImage(lookup).catch(() => {
      // A failed lookup has no body to release; its failure was logged below.
    });
    logWarn('image cache read failed', { detail: errorDetail(error) });
    return undefined;
  }
}

/** Keep an optimized image under `key`: a failure is logged, never thrown, the answer served either way. */
export async function storeCache(
  cacheName: string,
  key: Request,
  response: Response,
): Promise<void> {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, response);
  } catch (error) {
    logWarn('image cache write failed', { detail: errorDetail(error) });
  }
}
