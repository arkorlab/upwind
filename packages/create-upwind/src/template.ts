import { cp, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** What is already in the way, if anything: the names, so the message can say them. */
export async function conflictsIn(target: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(target);
    return entries.filter((entry) => !IGNORED_ENTRIES.has(entry));
  } catch {
    // Nothing there to conflict with; `cp` makes the directory.
    return [];
  }
}

export async function copyTemplate(target: string): Promise<void> {
  await cp(TEMPLATE, target, { recursive: true });
  await rename(path.join(target, 'gitignore'), path.join(target, '.gitignore'));
}
