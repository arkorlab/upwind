/**
 * `arkor:cache-host` as the runtime declares it (`packages/runtime/src/globals.d.ts`), whose own
 * declaration is outside this package's program: for the suite that builds the runtime's cache
 * beside the edge (`scope-revision.test.ts`).
 */
declare module 'arkor:cache-host' {
  import type { BundleBlobsExport } from '../../runtime/src/bundle-blobs.ts';
  import type { CacheHostInit, CacheHostLookup } from '../../runtime/src/cache/host.ts';

  export function createCacheHost(init: CacheHostInit): CacheHostLookup;

  export const createBundleBlobReader: BundleBlobsExport;
}
