import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { compareCodeUnits } from '@stayingupwind/core/util';

import { BUNDLE_PATH } from '../deploy/preflight.ts';

/**
 * What of the project changed after its build was written: the files under it newer than the
 * bundle, which a preview serves as they were before. Every file counts — the sources, the
 * configuration, an `.env` file Next.js inlines, the manifest and lockfile an upgrade rewrites — but
 * what a build, an install or a tool writes for itself.
 */

/**
 * The project's own directories a build, an install or a tool writes, skipped where they are: the
 * build's among them, which the bundle is in.
 */
const WRITTEN_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.upwind',
  '.vercel',
  '.wrangler',
  'out',
  path.dirname(BUNDLE_PATH),
]);
/** What is skipped wherever it is: the dependencies. */
const DEPENDENCIES = 'node_modules';
/** Files a build or a tool rewrites as it runs, wherever they are. */
const WRITTEN_FILES = new Set(['.DS_Store', 'next-env.d.ts']);
const WRITTEN_SUFFIX = '.tsbuildinfo';
/** How many entries are looked at, at most: a larger project is walked only that far. */
const MAX_ENTRIES = 50_000;
/** How many of the changed files are named. */
const NAMED = 3;

export interface Changed {
  /** How many files are newer than the build, as far as the walk went. */
  readonly count: number;
  /** The first of them, relative to the project, in the order the walk found them. */
  readonly named: readonly string[];
}

/** What one directory holds that counts, by name: its directories to walk, and its files. */
interface Listing {
  readonly entries: number;
  readonly directories: readonly string[];
  readonly files: readonly string[];
}

function skipped(entry: Dirent, top: boolean): boolean {
  // A link is not followed: what it points at is another directory's, or the dependencies'.
  if (entry.isSymbolicLink()) {
    return true;
  }
  if (entry.isDirectory()) {
    return entry.name === DEPENDENCIES || (top && WRITTEN_DIRECTORIES.has(entry.name));
  }
  return WRITTEN_FILES.has(entry.name) || entry.name.endsWith(WRITTEN_SUFFIX);
}

/** A directory's entries, relative to the project; none where it cannot be read. */
async function listing(projectDir: string, relative: string): Promise<Listing> {
  let read: Dirent[];
  try {
    read = await readdir(path.join(projectDir, relative), { withFileTypes: true });
  } catch {
    return { entries: 0, directories: [], files: [] };
  }
  const sorted = read.toSorted((a, b) => compareCodeUnits(a.name, b.name));
  const counted = sorted.filter((entry) => !skipped(entry, relative === ''));
  const named = (entry: Dirent): string =>
    relative === '' ? entry.name : `${relative}/${entry.name}`;
  return {
    entries: read.length,
    directories: counted.filter((entry) => entry.isDirectory()).map((entry) => named(entry)),
    files: counted.filter((entry) => entry.isFile()).map((entry) => named(entry)),
  };
}

/** Which of the files were modified after `builtAtMs`; none that cannot be read. */
async function newer(projectDir: string, files: readonly string[], builtAtMs: number) {
  const modified = await Promise.all(
    files.map(async (file) => {
      try {
        return (await stat(path.join(projectDir, file))).mtimeMs > builtAtMs;
      } catch {
        return false;
      }
    }),
  );
  return files.filter((_, index) => modified[index] === true);
}

/** The files under the project modified after `builtAtMs`, the build's own time. */
export async function changedSinceBuild(projectDir: string, builtAtMs: number): Promise<Changed> {
  const changed: string[] = [];
  let entries = 0;
  // Breadth first, each directory's entries by name: the files nearest the project's root are the
  // ones named, and in the same order on every system.
  const queue = [''];
  for (
    let next = queue.shift();
    next !== undefined && entries < MAX_ENTRIES;
    next = queue.shift()
  ) {
    const listed = await listing(projectDir, next);
    entries += listed.entries;
    queue.push(...listed.directories);
    changed.push(...(await newer(projectDir, listed.files, builtAtMs)));
  }
  return { count: changed.length, named: changed.slice(0, NAMED) };
}
