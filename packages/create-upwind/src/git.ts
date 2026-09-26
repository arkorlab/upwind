import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * A first commit, where there is a repository to be made.
 *
 * Never fatal. A machine with no git, a git with no identity configured, a directory already inside
 * somebody's repository: none of those is a reason to have failed to scaffold an application, and
 * all of them are things a developer can see for themselves. A repository this started and could not
 * finish is removed again, so what is left is either a clean first commit or no `.git` at all.
 */

const FIRST_COMMIT = 'Initial commit from create-upwind';

/** Run git, quietly; `undefined` when git itself is not there. */
async function git(args: readonly string[], cwd: string): Promise<number | undefined> {
  const child = spawn('git', args, { cwd, stdio: 'ignore' });
  try {
    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    return code ?? 1;
  } catch {
    return undefined;
  }
}

/** Is this directory already part of a repository? Then its history is not this program's to start. */
async function insideRepository(cwd: string): Promise<boolean> {
  return (await git(['rev-parse', '--is-inside-work-tree'], cwd)) === 0;
}

/** True when a repository was made and committed to. */
export async function initRepository(target: string): Promise<boolean> {
  if (await insideRepository(target)) {
    return false;
  }
  if ((await git(['init', '-b', 'main'], target)) !== 0) {
    return false;
  }
  const added = await git(['add', '-A'], target);
  const committed = added === 0 ? await git(['commit', '-m', FIRST_COMMIT], target) : undefined;
  if (committed === 0) {
    return true;
  }
  // Half a repository is worse than none: an `init` nobody asked to be left behind. And a cleanup
  // that cannot be done is still not a reason to have failed to write an application — this function
  // answers "no repository" either way.
  try {
    await rm(path.join(target, '.git'), { recursive: true, force: true });
  } catch {
    // Nothing to do about it here, and nothing that depends on it.
  }
  return false;
}
