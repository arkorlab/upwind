import { readFileSync } from 'node:fs';

import { TOOL_ENV_PREFIXES } from './config.ts';

/**
 * The variables the suite's harness handed the deploy hook beyond its own environment: a suite's
 * `env` (`createNext({ env })`), which Next.js's deploy mode gives a Vercel deployment as its
 * environment (`this.env`, `next-deploy.ts`) and which an application reads at request time.
 *
 * The harness starts the hook from its own process, with that process's environment and the suite's
 * on top (`{ ...process.env, NEXT_TEST_DIR, ...this.env }`). The environment that process was started
 * with is readable while it runs (`/proc/<pid>/environ`), and what the hook was given beyond it — a
 * variable it did not have, or one with another value — is the suite's. Nothing of the machine is
 * taken: whatever the terminal held, the harness held too.
 *
 * Read by the deploy hook before it sets anything of its own, with the harness's pid
 * (`read-suite-env.ts`); none where there is no `/proc` to read, which leaves a deployment the
 * application's `.env` files alone, as before.
 */

/**
 * Not the suite's, though the hook has them and the harness did not: what the shell running the hook
 * sets for itself, what the harness adds for every hook (`NEXT_TEST_DIR`), and the deployment id,
 * which the host gives a deployment and a suite's own would contradict.
 */
const NOT_THE_SUITES: ReadonlySet<string> = new Set([
  '_',
  'NEXT_DEPLOYMENT_ID',
  'NEXT_TEST_DIR',
  'OLDPWD',
  'PWD',
  'SHLVL',
]);
/** Jest's own, set in a worker as it runs. */
const NOT_THE_SUITES_PREFIXES: readonly string[] = ['JEST_', ...TOOL_ENV_PREFIXES];

/** An environment as `/proc/<pid>/environ` holds one: `NAME=value` entries, each ended by a NUL. */
function environOf(bytes: Buffer): Map<string, string> {
  const entries = bytes.toString('utf8').split('\0');
  return new Map(
    entries.flatMap((entry): [string, string][] => {
      const equals = entry.indexOf('=');
      return equals <= 0 ? [] : [[entry.slice(0, equals), entry.slice(equals + 1)]];
    }),
  );
}

/** What `given` holds beyond `harness`: the suite's variables. */
function suiteVariables(
  given: NodeJS.ProcessEnv,
  harness: ReadonlyMap<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(given).flatMap(([name, value]): [string, string][] => {
      if (
        value === undefined ||
        harness.get(name) === value ||
        NOT_THE_SUITES.has(name) ||
        NOT_THE_SUITES_PREFIXES.some((prefix) => name.startsWith(prefix))
      ) {
        return [];
      }
      return [[name, value]];
    }),
  );
}

/** The suite's variables, read against the harness that started the hook (`read-suite-env.ts`). */
export function suiteVariablesOf(
  pid: string | undefined,
  given: NodeJS.ProcessEnv,
): Record<string, string> {
  if (pid === undefined) {
    return {};
  }
  let harness: Map<string, string>;
  try {
    harness = environOf(readFileSync(`/proc/${pid}/environ`));
  } catch {
    return {};
  }
  return suiteVariables(given, harness);
}

/**
 * The suite's variables as the deploy hook read them before it set anything of its own
 * (`ADAPTER_TEST_SUITE_ENV`); none where it read none.
 */
export function suiteEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const read = env['ADAPTER_TEST_SUITE_ENV'];
  if (read === undefined || read === '') {
    return {};
  }
  const parsed = JSON.parse(read) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([name, value]): [string, string][] =>
      typeof value === 'string' ? [[name, value]] : [],
    ),
  );
}
