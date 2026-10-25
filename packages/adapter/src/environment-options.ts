import {
  UPWIND_CACHE_HOST_MODULE_ENV,
  UPWIND_UNSHIPPED_OUTPUTS_ENV,
} from '@stayingupwind/core/paas';

/** The options the environment can give: the cache's host, and what it leaves out of a Function. */
interface EnvironmentOptions {
  readonly cacheHostModule?: string;
  readonly unshippedOutputs?: 'prefetch-segments';
}

/**
 * What the default export is configured with: nothing, unless `upwind build` or `upwind deploy`
 * runs the build and names the runtime cache's host (`UPWIND_CACHE_HOST_MODULE_ENV`) — the one
 * option a project that names this adapter in its `next.config` cannot be given any other way.
 */
export function environmentOptions(): EnvironmentOptions {
  const cacheHostModule = process.env[UPWIND_CACHE_HOST_MODULE_ENV];
  if (cacheHostModule === undefined || cacheHostModule === '') {
    return {};
  }
  const unshipped = process.env[UPWIND_UNSHIPPED_OUTPUTS_ENV];
  return {
    cacheHostModule,
    ...(unshipped === 'prefetch-segments' && { unshippedOutputs: unshipped }),
  };
}
