import { cacheHostFor } from './cache-host.ts';

/**
 * Beside the cache, and independent of it: one blob of the deployment's own bundle that the build
 * left out of the Function, read from the prefetch Worker whether or not the deployment has a cache.
 * Published here because the runtime reads both from the one module its build resolved.
 */
export { createBundleBlobReader } from './bundle-blobs.ts';

/**
 * The runtime cache as a host serves it from behind an edge of its own, as the runtime of a
 * deployment's Function is given it (`cacheHostFor`). That edge tells each request's Function where
 * the scope stands (`SCOPE_REVISION_HEADER`), so no Function keeps its data center's copy of it, as a
 * standalone cache's do (`host.ts`): one that asked the authority itself would learn of an
 * invalidation whatever the edge in front of it said. The artifacts' copies keep the standalone
 * cache's names.
 */
export const createCacheHost = cacheHostFor({
  copyCache: 'upwind-cache-host-artifacts-v1',
  copyKeyOrigin: 'https://artifacts.upwind.invalid',
});
