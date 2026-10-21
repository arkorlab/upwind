/**
 * What `upwind deploy` tells the adapter through the environment of the build it runs.
 *
 * A deploy builds with the runtime cache's Function host in every Function, as a host that serves
 * the cache does; the adapter takes that host as an option (`cacheHostModule`), and a project
 * names the adapter in its own `next.config` — which outranks any adapter the environment names,
 * so the deploy cannot name a configured one of its own. It names the host instead, and the
 * adapter's default export reads it here: set, every Function the build makes carries the module
 * at this path, and the build leaves its prefetch segments out of them for the edge to answer
 * (`UPWIND_UNSHIPPED_OUTPUTS_ENV`). Unset — a plain `next build`, an `upwind build` — and the
 * default export is configured with nothing, as it always was.
 */
export const UPWIND_CACHE_HOST_MODULE_ENV = 'UPWIND_CACHE_HOST_MODULE';

/** Which outputs the build leaves out of its Functions, beside a cache host named above. */
export const UPWIND_UNSHIPPED_OUTPUTS_ENV = 'UPWIND_UNSHIPPED_OUTPUTS';
