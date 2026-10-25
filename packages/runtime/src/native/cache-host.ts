import type { CacheHostBinding, CacheHostInit, CacheHostLookup } from '../cache/host.ts';

/** The host owns this binding and keeps it alive until every accepted request has drained. */
export function createCacheHost(init: CacheHostInit): CacheHostLookup {
  return init.env?.['UPWIND_NODE_CACHE'] as CacheHostBinding | undefined;
}

// Native artifacts carry every blob on their own filesystem.
export const createBundleBlobReader = undefined;
