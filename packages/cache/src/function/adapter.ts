// eslint-disable-next-line no-restricted-imports, import-x/no-nodejs-modules -- the adapter runs inside `next build`, under Node.
import { fileURLToPath } from 'node:url';

import { createAdapter } from '@stayingupwind/adapter';

/**
 * The deployment adapter with the runtime cache bundled into every Function it builds but the
 * middleware's, which reads and writes nothing of the cache (`./host.ts`), for a standalone cache
 * and edge: what `NEXT_ADAPTER_PATH` names for a build that deploys to them, a local stack's among
 * them. A build through `@stayingupwind/adapter`'s own default export is the same bundle with no
 * cache in it; a host building with this one installs that package beside the cache, which asks
 * for it as an optional peer.
 *
 * The prefetch segments stay out of the Function: the edge answers them from the bucket, and the
 * Function reads one it is asked for from the prefetch Worker (`ARKOR_PREFETCH`).
 */
// `NEXT_ADAPTER_PATH` names a module whose default export is the adapter.
// eslint-disable-next-line import-x/no-default-export
export default createAdapter({
  cacheHostModule: fileURLToPath(import.meta.resolve('./host.ts')),
  unshippedOutputs: 'prefetch-segments',
});
