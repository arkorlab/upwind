import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { EnvEntry } from './client.ts';
import { TOOL_ENV_PREFIXES } from './config.ts';
import { suiteEnvironment } from './suite-env.ts';

/**
 * What a test application's Function is given: the application's own `.env` files, and nothing else.
 *
 * The child is started with an environment of three names, so that what comes back is the
 * application's own values and not a copy of this machine's. Those three are dropped again below,
 * which leaves the `.env*` files — and a deployment's environment is then *replaced* with exactly
 * that, so no value of the fixture before it survives into this one.
 *
 * The suite's own variables, which its harness hands the hook through the process environment, are
 * read apart from this, against the harness's own environment (`suite-env.ts`), and laid over these
 * (`deploymentEnvironment`): nothing of the machine is taken either way.
 */

const execFileAsync = promisify(execFile);
const READER = path.join(import.meta.dirname, 'read-env.ts');
/**
 * The two names that are dropped from what the reader gives back: the one it is given, and the one it
 * produces.
 *
 * Given: `NODE_ENV`, because which `.env` files count is a question about a production build. Nothing
 * else, and that is the point — dotenv expands `$NAME` in a value against the environment it reads in,
 * so a `PATH` or a `HOME` handed in here is a machine's path waiting to be written into a deployed
 * Function by any fixture whose `.env` mentions one. The reader is started as an absolute path, so it
 * needs no `PATH` of its own.
 *
 * Produced: `__NEXT_PROCESSED_ENV`, Next.js's own bookkeeping — the marker it sets to know it has read
 * the files — and a Function that started with it set would skip its own.
 */
const SEEDED = ['NODE_ENV', '__NEXT_PROCESSED_ENV'] as const;
const KIB = 1024;
const MIB = KIB * KIB;
/** An application's `.env` files are small; a runaway is not something to read to the end of. */
const MAX_OUTPUT_MIB = 4;
const MAX_OUTPUT_BYTES = MAX_OUTPUT_MIB * MIB;

export async function fixtureEnvironment(directory: string): Promise<Record<string, string>> {
  const appDir = path.resolve(directory);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [READER, appDir], {
      cwd: appDir,
      env: { NODE_ENV: 'production' },
      maxBuffer: MAX_OUTPUT_BYTES,
    }));
  } catch (error) {
    // One sentence naming the likely cause — an application whose dependencies are not there — with
    // the child's own output kept as the `cause`, which `main.ts` prints under it. A bare
    // `MODULE_NOT_FOUND` stack from a process nobody knows about says none of that by itself.
    throw new Error(`could not read the environment of ${appDir} — is its \`next\` installed?`, {
      cause: error,
    });
  }
  const read = JSON.parse(stdout) as Record<string, string | undefined>;
  return Object.fromEntries(
    Object.entries(read).flatMap(([name, value]) =>
      value === undefined || keptOut(name) ? [] : [[name, value]],
    ),
  );
}

function keptOut(name: string): boolean {
  return (
    SEEDED.includes(name as (typeof SEEDED)[number]) ||
    // This tool's own configuration is not a fixture's to receive: the token that deployed a Function
    // has no business inside it, and once was sent there by a harness whose exclusions missed it.
    TOOL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function countOf(variables: Record<string, string>): string {
  return String(Object.keys(variables).length);
}

/**
 * The names of the suite's variables, for the log, and never their values: a run's log may be public.
 * They are what the hook read off a difference (`suite-env.ts`), so they are what a refused environment
 * is to be read against.
 */
function namesOf(variables: Record<string, string>): string {
  const names = Object.keys(variables);
  return names.length === 0 ? '' : ` (${names.join(', ')})`;
}

/**
 * The shortest value the API takes as a secret. A shorter one put as a secret is refused, and with it
 * the whole environment, which fails the deployment.
 */
const SHORTEST_SECRET = 4;

/** A variable as it goes up: a secret, where the value is long enough to be one. */
function entryOf([name, value]: [string, string]): EnvEntry {
  return { name, value, secret: value.length >= SHORTEST_SECRET };
}

/** The names that go up as they are, for the log: none, or a clause that names them. */
function plainOf(entries: readonly EnvEntry[]): string {
  const plain = entries.filter((entry) => !entry.secret).map((entry) => entry.name);
  return plain.length === 0
    ? ''
    : `; too short to be secrets, put as they are: ${plain.join(', ')}`;
}

/**
 * What a deployment's environment is replaced with: the application's own `.env` files, and the
 * suite's variables over them (`suite-env.ts`), as a variable a process is started with is over a
 * `.env` file's. With what it is made of, said for the log.
 *
 * A variable goes up as a secret wherever the API takes one: it answers a secret's value as `null`, so
 * a fixture's own values cannot be read back out of the project by anything holding a `read` token. A
 * value too short to be one (`SHORTEST_SECRET`) goes up as it is, and the log names it. Refusing it
 * instead would fail the suite on how its value is stored rather than on what the adapter did, and
 * what a suite hands over is Next.js's own test data, its `.env` files and its `createNext({ env })`:
 * a flag like the `NEXT_PRIVATE_LOCAL_DEV=1` its deploy mode gives every fixture kept as a directory,
 * not a credential. The API holds that much itself, in refusing to keep a value that short as one.
 * What else the harness's process is given as it runs is taken for the suite's too (`suite-env.ts`),
 * and goes up as it is where it is short: nothing sensitive belongs in that process.
 */
export async function deploymentEnvironment(
  directory: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly entries: EnvEntry[]; readonly said: string }> {
  const own = await fixtureEnvironment(directory);
  // Held to what the files are: a suite's `__NEXT_PROCESSED_ENV` would have the Function skip its own.
  const suite = Object.fromEntries(
    Object.entries(suiteEnvironment(env)).filter(([name]) => !keptOut(name)),
  );
  const merged = { ...own, ...suite };
  const entries = Object.entries(merged).map((entry) => entryOf(entry));
  return {
    entries,
    said: `${countOf(merged)}: ${countOf(own)} of the fixture's own, ${countOf(suite)} of the suite's${namesOf(suite)}${plainOf(entries)}`,
  };
}
