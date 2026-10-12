import { cacheControl } from '../entrypoints/control.ts';
import { cacheSignals } from '../entrypoints/signals.ts';
import { createCacheWorker, createGatewayApp } from '../gateway/app.ts';
import { STANDALONE_AUTHORITY } from './host.ts';

/**
 * The runtime cache as a Worker of its own, for a host that runs it as it stands: the gateway a
 * deployment's Functions reach over their `ARKOR_CACHE` binding, the scope's object as
 * `CacheScope` keeps no history beside it, and the entrypoint whatever deploys a site seeds and
 * retires its scopes through (`CacheControl`).
 */
// eslint-disable-next-line unicorn/no-top-level-side-effects -- A Worker's entry is loaded for its default export, which is the call that builds it.
export default createCacheWorker(createGatewayApp(STANDALONE_AUTHORITY));

export const CacheControl = cacheControl(STANDALONE_AUTHORITY);

/**
 * Where a scope stands, for an edge in front of the site's Functions that binds to it: a standalone
 * cache tells no copy when a scope moves, so such an edge asks again every moment.
 */
export const CacheSignals = cacheSignals(STANDALONE_AUTHORITY);

export { CacheScope } from '../scope/cache-scope.ts';
