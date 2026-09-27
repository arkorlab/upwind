import type { R2Bucket } from '@cloudflare/workers-types';

import { BLOB } from './kinds.ts';
import { sole } from './sole.ts';

export { blob } from './named.ts';

/**
 * The project's bucket.
 *
 * ```ts
 * import bucket from '@stayingupwind/sdk/blob';
 *
 * await bucket.put('greeting.txt', 'hello');
 * ```
 *
 * The same rule as `db`, on the same grounds: whichever R2 bucket this deployment published, as long
 * as it published exactly one. `blob` is here too, for a project with more than one.
 *
 * Called `blob` rather than `r2` throughout this package: what an application is doing is keeping
 * blobs, and which product is underneath it is the deployment's business.
 */
const bucket = sole(BLOB) as R2Bucket;

export default bucket;
