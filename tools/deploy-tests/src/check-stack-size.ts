import { spawn } from 'node:child_process';

import { suiteVariablesOf } from './suite-env.ts';

/**
 * What `check.ts` holds of a suite's variables beside its hooks: how a stack size is read, and how two
 * environments are compared.
 */

/** The stack size Next.js sets in a process that loads its native bindings and has none. */
export const NEXT_JS_STACK = '8388608';

/** Whether two environments hold the same names with the same values, in whatever order. */
export function sameEnvironment(
  environment: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  const sorted = (of: Record<string, string>): string =>
    JSON.stringify(Object.entries(of).toSorted(([a], [b]) => a.localeCompare(b)));
  return sorted(environment) === sorted(expected);
}

/** What a harness of `pid` reads a suite's `RUST_MIN_STACK` of `given` as: the suite's, or nothing. */
function stackSizeTaken(
  pid: string | undefined,
  env: NodeJS.ProcessEnv,
  given: string,
): string | undefined {
  const read = suiteVariablesOf(pid, { ...env, RUST_MIN_STACK: given }, () => {
    // Nothing to say: the stand-in harness is there to be read.
  });
  return read['RUST_MIN_STACK'];
}

/**
 * The stack size Next.js sets in a harness that started without one is not the suite's (`main` starts
 * the stand-in harness without one, whatever this machine exports). Another value is, and so is
 * Next.js's own value over a harness that started with another, which Next.js never replaced.
 */
export function stackSizeScenario(
  env: NodeJS.ProcessEnv,
  holds: (said: string, held: boolean) => void,
): void {
  const pid = env['ADAPTER_TEST_HARNESS_PID'];
  holds(
    "the stack size Next.js gives the harness is not taken for the suite's",
    stackSizeTaken(pid, env, NEXT_JS_STACK) === undefined,
  );
  holds(
    "a stack size a suite sets itself is the suite's",
    stackSizeTaken(pid, env, '16777216') === '16777216',
  );
  const started = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], {
    env: { ...env, RUST_MIN_STACK: '4194304' },
    stdio: 'ignore',
  });
  started.on('error', () => {
    // A harness that did not start has no pid, and the assertion below fails on that.
  });
  try {
    holds(
      "and so is Next.js's value, over a harness that started with another",
      started.pid !== undefined &&
        stackSizeTaken(String(started.pid), env, NEXT_JS_STACK) === NEXT_JS_STACK,
    );
  } finally {
    started.kill();
  }
}
