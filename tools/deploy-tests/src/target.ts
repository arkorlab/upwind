/**
 * Where a fixture is served for the suite: on a host, through its public API (`host`, the default);
 * or on this machine, on the runtime a deployment of it would run on — Cloudflare's, as a local stack
 * of the edge, the runtime cache and the Functions on workerd (`cloudflare`), or Node.js's, as the
 * native server `upwind start` runs (`node`).
 *
 * The two local targets need no credential and no project: each fixture has a server of its own on a
 * port of its own, so fixtures may be served side by side.
 */

export type Target = 'host' | 'cloudflare' | 'node';

export const TARGET_ENV = 'ADAPTER_TEST_TARGET';

const TARGETS: readonly Target[] = ['host', 'cloudflare', 'node'];

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

/** The target the environment names; `host` where it names none. */
export function targetOf(env: NodeJS.ProcessEnv = process.env): Target {
  const value = env[TARGET_ENV]?.trim();
  if (value === undefined || value === '') {
    return 'host';
  }
  if (!isTarget(value)) {
    throw new Error(`${TARGET_ENV} must be one of ${TARGETS.join(', ')}`);
  }
  return value;
}

/** Whether the target serves a fixture on this machine rather than on a host. */
export function isLocal(target: Target): target is 'cloudflare' | 'node' {
  return target !== 'host';
}
