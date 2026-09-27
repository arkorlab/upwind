import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { TOOL_ENV_PREFIXES } from './config.ts';

/**
 * What a test application's Function is given: the application's own `.env` files, and nothing else.
 *
 * The child is started with an environment of three names, so that what comes back is the
 * application's own values and not a copy of this machine's. Those three are dropped again below,
 * which leaves the `.env*` files — and a deployment's environment is then *replaced* with exactly
 * that, so no value of the fixture before it survives into this one.
 *
 * **A known limit, and the reason for it.** A host's private harness can do better: it starts the
 * deploy hook itself, so it can tell a variable the suite's harness passed through the process
 * environment from one the machine already had, by comparing against a digest of its own environment
 * taken before the run. Here the suite's harness starts the hook directly and there is no such
 * baseline, so a suite whose application reads a variable that arrives *only* that way will fail.
 * Guessing instead would be worse: this tool would be handing a deployed Function whatever the
 * terminal happened to hold.
 */

const execFileAsync = promisify(execFile);
const READER = path.join(import.meta.dirname, 'read-env.ts');
/**
 * Seeded so that `@next/env` can run at all, plus the marker it leaves behind to know it has already
 * read the files. All of them are dropped from what comes back: the last is Next.js's own bookkeeping
 * in the reader's process, and a deployed Function that started with it set would skip its own.
 */
const SEEDED = ['PATH', 'HOME', 'NODE_ENV', '__NEXT_PROCESSED_ENV'] as const;
const KIB = 1024;
const MIB = KIB * KIB;
/** An application's `.env` files are small; a runaway is not something to read to the end of. */
const MAX_OUTPUT_MIB = 4;
const MAX_OUTPUT_BYTES = MAX_OUTPUT_MIB * MIB;

export async function fixtureEnvironment(directory: string): Promise<Record<string, string>> {
  const appDir = path.resolve(directory);
  const { stdout } = await execFileAsync(process.execPath, [READER, appDir], {
    cwd: appDir,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      NODE_ENV: 'production',
    },
    maxBuffer: MAX_OUTPUT_BYTES,
  });
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
