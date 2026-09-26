import { cp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type PackageManager, runCommand } from './package-manager.ts';

/**
 * The application this copies, and what has to be renamed on the way out.
 *
 * `../templates/default/` reads the same from the sources a workspace links and from the module a
 * registry installs: both sit one directory below the package root, and `templates` travels with the
 * package (`files`).
 *
 * The template carries `gitignore` without its dot because **npm removes a `.gitignore` from every
 * tarball it packs**. A template that kept the dot would arrive with no ignore file at all, and the
 * first commit of every scaffolded project would carry `node_modules`. `create-next-app` renames the
 * same file for the same reason.
 */
const TEMPLATE = fileURLToPath(new URL('../templates/default/', import.meta.url));

/** Entries that do not make a directory non-empty: a checkout and a Finder artefact. */
const IGNORED_ENTRIES: ReadonlySet<string> = new Set(['.DS_Store', '.git']);

/** Is this the error of a directory that is not there? Anything else is a directory that is. */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** What is already in the way, if anything: the names, so the message can say them. */
export async function conflictsIn(target: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(target);
    return entries.filter((entry) => !IGNORED_ENTRIES.has(entry));
  } catch (error) {
    if (isMissing(error)) {
      // Nothing there to conflict with; `cp` makes the directory.
      return [];
    }
    // A directory that cannot be read is not an empty one. Taking it for empty would write an
    // application into a place this could not even look at first.
    throw error;
  }
}

export async function copyTemplate(target: string): Promise<void> {
  await cp(TEMPLATE, target, { recursive: true });
  await rename(path.join(target, 'gitignore'), path.join(target, '.gitignore'));
}

/**
 * The README, in the manager the project was made with.
 *
 * The template is written in pnpm because a file has to be written in something. A project installed
 * with npm has an npm lockfile, and a README that tells its reader to run pnpm tells them to install
 * it a second way — or, on a machine without pnpm, to run something that is not there.
 */
export async function retellReadme(target: string, manager: PackageManager): Promise<void> {
  if (manager === 'pnpm') {
    return;
  }
  const readme = path.join(target, 'README.md');
  const written = await readFile(readme, 'utf8');
  // Replacement functions, not strings: what a manager's command is has no `$` in it, and a
  // replacement that is taken for a pattern is a bug nobody would look for here.
  const retold = written
    .replaceAll('pnpm dev', () => runCommand(manager, 'dev'))
    .replaceAll('pnpm build', () => runCommand(manager, 'build'));
  await writeFile(readme, retold);
}
