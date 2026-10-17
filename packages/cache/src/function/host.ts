import { cacheHostFor } from './cache-host.ts';

/**
 * Beside the cache, and independent of it: one blob of the deployment's own bundle that the build
 * left out of the Function, read from the prefetch Worker whether or not the deployment has a cache.
 * Published here because the runtime reads both from the one module its build resolved.
 */
export { createBundleBlobReader } from './bundle-blobs.ts';

/**
 * The runtime cache as a standalone cache serves it, as the runtime of a deployment's Function is
 * given it (`cacheHostFor`), with the artifacts' copies kept under names of its own, and the data
 * center's copy of where the scope's tags stand (`ScopeBeacon`).
 */
export const createCacheHost = cacheHostFor(
  {
    copyCache: 'upwind-cache-host-artifacts-v1',
    copyKeyOrigin: 'https://artifacts.upwind.invalid',
  },
  // Nothing in front of a standalone cache's Functions says where a scope stands, so each keeps its
  // data center's copy of it, asked of the authority every moment it has traffic: an invalidation
  // reaches the deployment's other isolates within that moment, on any account.
  { scopeBeacon: true },
);
