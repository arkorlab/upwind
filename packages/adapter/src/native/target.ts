import { UPWIND_CACHE_HOST_MODULE_ENV } from '@stayingupwind/core/paas';

/** The execution environment selected while the deployment is built. */
export type RuntimeTarget = 'cloudflare' | 'node';

export const BUILD_TARGET_ENV = 'UPWIND_BUILD_TARGET';
const BUILD_CACHE_HOST_ENV = 'UPWIND_BUILD_CACHE_HOST_MODULE';

function checkedTarget(value: unknown, source: string): RuntimeTarget | undefined {
  if (value === undefined) return undefined;
  if (value !== 'cloudflare' && value !== 'node') {
    throw new Error(`@stayingupwind/adapter: ${source} must be cloudflare or node`);
  }
  return value;
}

/** A CLI selection cannot quietly lose to an adapter configured for another environment. */
export function runtimeTargetOf(explicit?: RuntimeTarget): RuntimeTarget {
  const selected = process.env[BUILD_TARGET_ENV];
  const option = checkedTarget(explicit, 'target');
  const target = checkedTarget(selected === '' ? undefined : selected, BUILD_TARGET_ENV);
  if (option !== undefined && target !== undefined && option !== target) {
    throw new Error(
      `@stayingupwind/adapter: target ${explicit} conflicts with ${BUILD_TARGET_ENV}=${target}`,
    );
  }
  return option ?? target ?? 'cloudflare';
}

/** A config-selected native target must reach prerender workers before their preload runs. */
export function publishNativeBuildTarget(): void {
  // The environment may have changed since the adapter was constructed. Keep explicit target
  // conflicts visible rather than replacing the CLI's selection while publishing this one.
  runtimeTargetOf('node');
  // A generic `upwind build` can provision the default Workers host before next.config chooses
  // a native adapter. Remove only that exact CLI-owned value so the renderer's default adapter
  // import cannot mistake it for an explicit native cache override.
  const automatic = process.env[BUILD_CACHE_HOST_ENV];
  if (
    automatic !== undefined &&
    automatic !== '' &&
    process.env[UPWIND_CACHE_HOST_MODULE_ENV] === automatic
  ) {
    Reflect.deleteProperty(process.env, UPWIND_CACHE_HOST_MODULE_ENV);
  }
  Reflect.deleteProperty(process.env, BUILD_CACHE_HOST_ENV);
  process.env[BUILD_TARGET_ENV] = 'node';
}
