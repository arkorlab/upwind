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
 *
 * **Two limits, both of reading a difference.** A suite's variable with the very value the harness
 * started with is no difference, and is not given: nothing tells it from the harness's own. And a
 * variable the harness sets in its own process after it starts is one, and is taken for the suite's
 * unless it is named below — the startup environment is all `/proc` keeps, and the process's current
 * one is not readable from outside it. Next.js's harness sets `TEST_FILE_PATH` and `NEXT_TEST_*`, and
 * nothing that holds a credential; a host's runner that loaded one into the harness's process as it
 * ran would have it uploaded, as a secret, into the test project.
 */

/**
 * Not the suite's, though the hook has them and the harness did not start with them: what the shell
 * running the hook sets for itself; what Next.js's harness sets in its own process as it runs — the
 * test file's path (`TEST_FILE_PATH`, `e2e-utils`) and its `NEXT_TEST_*` settings, `NEXT_TEST_DIR`
 * among them, which it adds for every hook; and the deployment id, which the host gives a deployment
 * and a suite's own would contradict.
 */
const NOT_THE_SUITES: ReadonlySet<string> = new Set([
  '_',
  'NEXT_DEPLOYMENT_ID',
  'OLDPWD',
  'PWD',
  'SHLVL',
  'TEST_FILE_PATH',
]);
/** Jest's own, set in a worker as it runs; Next.js's test settings; and this tool's own. */
const NOT_THE_SUITES_PREFIXES: readonly string[] = ['JEST_', 'NEXT_TEST_', ...TOOL_ENV_PREFIXES];

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
  warn: (message: string) => void,
): Record<string, string> {
  // A process id, and nothing that reads as a path once it is put into one.
  if (pid === undefined || !/^[1-9]\d*$/u.test(pid)) {
    warn(`not a process id to read a harness's environment by: ${pid ?? 'none'}`);
    return {};
  }
  let harness: Map<string, string>;
  try {
    harness = environOf(readFileSync(`/proc/${pid}/environ`));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    warn(
      code === 'ENOENT'
        ? `no /proc/${pid}/environ to read the harness's environment from`
        : `could not read the harness's environment: ${code ?? String(error)}`,
    );
    return {};
  }
  // A process that has gone, or that cleared its environment, gives nothing to read against: every
  // variable the hook was handed would read as the suite's, the machine's with them.
  if (harness.size === 0) {
    warn("the harness's environment reads as empty; no variable is taken for the suite's");
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
