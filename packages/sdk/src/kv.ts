import type { KVNamespace } from '@cloudflare/workers-types';

import { KV } from './kinds.ts';
import { sole } from './sole.ts';

export { kv } from './named.ts';

/**
 * The project's key-value namespace.
 *
 * ```ts
 * import store from '@stayingupwind/sdk/kv';
 *
 * await store.put('greeting', 'hello');
 * ```
 *
 * The same rule as `db`, on the same grounds: whichever KV namespace this deployment published, as
 * long as it published exactly one. `kv` is here too, for a project with more than one.
 */
const store = sole(KV) as KVNamespace;

export default store;
