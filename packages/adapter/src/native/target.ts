/** The execution environment selected while the deployment is built. */
export type RuntimeTarget = 'cloudflare' | 'node';

export const BUILD_TARGET_ENV = 'UPWIND_BUILD_TARGET';

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
