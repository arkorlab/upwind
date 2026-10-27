/**
 * What `upwind build` and `upwind deploy` tell the adapter through the environment of the build
 * they run.
 *
 * Both build with the runtime cache's Function host in every Function, as a host that serves the
 * cache does; the adapter takes that host as an option (`cacheHostModule`), and a project names the
 * adapter in its own `next.config` — which outranks any adapter the environment names, so neither
 * command can name a configured one of its own. Each names the host instead, and the adapter's
 * default export reads it here: set, every Function the build makes carries the module at this
 * path, and a deploy's build also leaves its prefetch segments out of them for the edge to answer
 * (`UPWIND_UNSHIPPED_OUTPUTS_ENV`). Either leaves the large bodies of its completed pages to the
 * host's bundle storage where a Function could not be uploaded with them
 * (`UPWIND_UNSHIPPED_PRERENDER_BODIES_ENV`). Unset — a plain `next build` — and the default export
 * is configured with nothing, as it always was.
 */
export const UPWIND_CACHE_HOST_MODULE_ENV = 'UPWIND_CACHE_HOST_MODULE';

/** Which outputs the build leaves out of its Functions, beside a cache host named above. */
export const UPWIND_UNSHIPPED_OUTPUTS_ENV = 'UPWIND_UNSHIPPED_OUTPUTS';

/**
 * Which completed page bodies a build beside a cache host named above leaves to that host's bundle
 * storage, for its reader to answer (`unshippedPrerenderBodies`): unset or `auto`, those of 1 to 32
 * MiB, and only in a build whose app Function would be over the size limit with them; `large`, those
 * bodies in every build; `none`, no body at all.
 */
export const UPWIND_UNSHIPPED_PRERENDER_BODIES_ENV = 'UPWIND_UNSHIPPED_PRERENDER_BODIES';
