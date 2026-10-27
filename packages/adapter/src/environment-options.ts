import {
  UPWIND_CACHE_HOST_MODULE_ENV,
  UPWIND_UNSHIPPED_OUTPUTS_ENV,
  UPWIND_UNSHIPPED_PRERENDER_BODIES_ENV,
} from '@stayingupwind/core/paas';

import type { UnshippedPrerenderBodies } from './page-bodies.ts';

const KIB = 1024;
const MIB = KIB * KIB;
/** The most the host's reader returns whole (`createBundleBlobReader`), in MiB. */
const READER_MAX_MIB = 32;

/**
 * The completed page bodies a build beside a named cache host may leave to the host's bundle
 * storage: from 1 MiB, below which a body costs a Function little, to what the host's reader returns
 * whole when a Function has to answer one itself.
 */
const UNSHIPPED_BODY_RANGE = { minBytes: MIB, maxBytes: READER_MAX_MIB * MIB } as const;

/**
 * The options the environment can give: the cache's host, and what a build leaves out of its
 * Functions beside it.
 */
interface EnvironmentOptions {
  readonly cacheHostModule?: string;
  readonly unshippedOutputs?: 'prefetch-segments';
  readonly unshippedPrerenderBodies?: UnshippedPrerenderBodies;
}

/**
 * Which page bodies a build beside a named cache host leaves out of its Functions, as
 * `UPWIND_UNSHIPPED_PRERENDER_BODIES_ENV` says: unset or `auto`, the range above and only in a build
 * that could not be uploaded with them (`when: 'over-limit'`), which leaves every build within the
 * size limit exactly as it was and lets the rest be uploaded at all; `large`, the range in every
 * build; `none`, no body. Anything else fails the build rather than be taken for one of them.
 */
function unshippedPrerenderBodies(): UnshippedPrerenderBodies | undefined {
  const asked = process.env[UPWIND_UNSHIPPED_PRERENDER_BODIES_ENV];
  if (asked === undefined || asked === '' || asked === 'auto') {
    return { ...UNSHIPPED_BODY_RANGE, when: 'over-limit' };
  }
  if (asked === 'large') {
    return { ...UNSHIPPED_BODY_RANGE };
  }
  if (asked === 'none') {
    return undefined;
  }
  throw new Error(
    `@stayingupwind/adapter: ${UPWIND_UNSHIPPED_PRERENDER_BODIES_ENV} must be auto, large or none, not ${JSON.stringify(asked)}`,
  );
}

/**
 * What the default export is configured with: nothing, unless `upwind build` or `upwind deploy`
 * runs the build and names the runtime cache's host (`UPWIND_CACHE_HOST_MODULE_ENV`) — the one
 * option a project that names this adapter in its `next.config` cannot be given any other way.
 * Beside that host, the large bodies of completed pages go to its reader where a Function would be
 * over the size limit with them, as a host that builds its own deployments does: upwind's own hosts
 * export the reader the option asks for (`createBundleBlobReader`), and one that does not is named
 * with `UPWIND_UNSHIPPED_PRERENDER_BODIES_ENV` set to `none`.
 */
export function environmentOptions(): EnvironmentOptions {
  const cacheHostModule = process.env[UPWIND_CACHE_HOST_MODULE_ENV];
  if (cacheHostModule === undefined || cacheHostModule === '') {
    return {};
  }
  const unshipped = process.env[UPWIND_UNSHIPPED_OUTPUTS_ENV];
  const bodies = unshippedPrerenderBodies();
  return {
    cacheHostModule,
    ...(unshipped === 'prefetch-segments' && { unshippedOutputs: unshipped }),
    ...(bodies !== undefined && { unshippedPrerenderBodies: bodies }),
  };
}
