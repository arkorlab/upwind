import { cacheHostFor } from '../../cache/src/function/cache-host.ts';

/**
 * The runtime cache as these suites drive it: the function-side host `cacheHostFor` builds, with
 * the artifacts' copies kept under the standalone host's names and no scope beacon, so that what a
 * suite counts of the authority is what the runtime itself asked (`../../cache/src/function/host.ts`
 * adds the beacon). Each suite hands it to the runtime as `arkor:cache-host` resolves in a build.
 */
export const createCacheHost = cacheHostFor({
  copyCache: 'upwind-cache-host-artifacts-v1',
  copyKeyOrigin: 'https://artifacts.upwind.invalid',
});

export { createBundleBlobReader } from '../../cache/src/function/bundle-blobs.ts';
