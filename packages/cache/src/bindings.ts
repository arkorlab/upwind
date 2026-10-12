import type { CacheVars } from './env.ts';
import type { CacheScope } from './scope/cache-scope.ts';

/**
 * What the cache reads of its environment on its own, whatever host runs it: the store its delivery
 * and tag records are in, the bucket its blobs are in, the namespace its scopes' objects are in, and
 * the settings `env.ts` reads — a scope's ceilings and lifetimes, the keys its tokens are signed
 * with, and the switch that lets a test name the clock. Whatever else a host binds is the host's.
 *
 * A host passes its own environment as it stands, and any environment that binds these under these
 * names is one.
 */
export interface CacheBindings extends CacheVars {
  readonly CACHE_STATE: KVNamespace;
  readonly ARTIFACTS: R2Bucket;
  readonly CACHE_SCOPE: DurableObjectNamespace<CacheScope>;
}
