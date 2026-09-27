import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Copy, Patch } from '../src/patches/index.ts';

/**
 * Which copy of Next.js a file of a published package is, and which copies a patch left alone.
 *
 * A patch declares the kinds of copy it has to reach (`Copy`, `src/patches/types.ts`), and
 * `check-patches.ts` holds it to them. This is the half of that which reads the package: what a file is,
 * and — for the one kind that is a family rather than a file — which of its members should have been
 * rewritten and were not.
 */

/** Where Next.js keeps the compiled server runtimes, under `dist`, as a build names it. */
const RUNTIME_DIR = 'compiled/next-server';
/**
 * A compiled server runtime, by the entry it is a build of.
 *
 * Next.js builds each entry more than once — `app-page.runtime.prod.js`, `app-page-turbo…`,
 * `app-page-experimental…` — and those are the same modules built with different flags, not different
 * copies of them. Which is why the entry is what this reads out: the builds of one entry either all hold
 * what a patch rewrites or none of them do, so one of them patched and another not is a miss. Only
 * `prod`, because a Function loads no dev runtime.
 */
const RUNTIME = /^(?<entry>[\w-]+?)(?:-turbo)?(?:-experimental)?\.runtime\.prod\.js$/u;

/** The runtime directory as a path under a package root. */
function runtimeDir(root: string): string {
  return path.join(root, 'dist', ...RUNTIME_DIR.split('/'));
}

/**
 * Which copy of Next.js a file is, by the name a build knows it under.
 *
 * The same module is shipped more than once: the compiled server runtimes each bundle their own copy,
 * everything else under `compiled/` is a vendored package's, `esm/` is the ESM copy beside a file, and the
 * rest is the file itself.
 *
 * `build-output` is not among the answers, because a published package holds none of it. That is the one
 * kind a package cannot show, and `tools/next-matrix` is what holds a patch to it.
 */
export function copyOf(file: string): Exclude<Copy, 'build-output'> {
  const inPackage = file.replace(/^.*\/node_modules\/next\/dist\//u, '');
  if (inPackage.startsWith(`${RUNTIME_DIR}/`) && RUNTIME.test(path.posix.basename(inPackage))) {
    return 'server-runtime';
  }
  if (inPackage.startsWith('compiled/')) {
    return 'vendored';
  }
  return inPackage.startsWith('esm/') ? 'esm-module' : 'module';
}

/** The compiled server runtimes a package holds, as file names, by the entry each is a build of. */
async function runtimesOf(root: string): Promise<Map<string, string[]>> {
  const byEntry = new Map<string, string[]>();
  let names: string[];
  try {
    names = await readdir(runtimeDir(root));
  } catch {
    // A package with no runtimes at all is a kind nothing reached, which the caller says first and in its
    // own words. Nothing here can add to that.
    return byEntry;
  }
  const sorted = names.toSorted((a, b) => a.localeCompare(b));
  for (const name of sorted) {
    const entry = RUNTIME.exec(name)?.groups?.['entry'];
    if (entry !== undefined) {
      byEntry.set(entry, [...(byEntry.get(entry) ?? []), name]);
    }
  }
  return byEntry;
}

/** Runtimes a patch left alone that it should not have, by what says so. */
export interface Missed {
  /** The patch's own marker says these hold what it rewrites. */
  readonly claimed: string[];
  /** These are another build of an entry the patch did reach, and so hold the same modules. */
  readonly siblings: string[];
}

/**
 * Which compiled runtimes a patch should have reached and did not.
 *
 * `server-runtime` is the one kind that is a family, and a kind reported as reached because one member of
 * it matched is exactly the failure this asks about: a Function loads the runtime for the kind of route it
 * serves, so `cache-signal-timers` reaching the page runtimes and not the route ones is every route
 * handler running with the bug while the summary says the kind was reached.
 *
 * What it should have reached is read off the package rather than declared, so that the number of runtimes
 * and their names stay Next.js's to change. Two things say a runtime holds what a patch rewrites:
 *
 * - the patch's `marker`, where it has one. That is a test of the file's contents, which is the question
 *   itself; a runtime it claims and the target skipped is a target gone narrow.
 * - another build of the same entry having been reached, for a patch with no marker to ask. `-turbo` and
 *   `-experimental` are build flags over the same modules (see `RUNTIME`), so one of them patched and
 *   another not is a target that names some of a family and means all of it.
 *
 * What neither sees: a runtime Next.js starts building from modules it did not before, under an entry
 * nothing else covers and (for a patch with a marker) shaped so the marker says no. `--range` and
 * `tools/next-matrix` are what stand behind that, by checking releases and builds rather than one package.
 */
export async function missedRuntimes(
  root: string,
  patch: Patch,
  reached: ReadonlySet<string>,
): Promise<Missed> {
  const claimed: string[] = [];
  const siblings: string[] = [];
  const dir = runtimeDir(root);
  const runtimes = await runtimesOf(root);
  for (const names of runtimes.values()) {
    const took = names.some((name) => reached.has(name));
    for (const name of names) {
      if (reached.has(name)) {
        continue;
      }
      if (took) {
        siblings.push(name);
        continue;
      }
      const marker = patch.marker;
      if (marker === undefined) {
        continue;
      }
      // Read only where a marker is there to ask and nothing in the entry was reached: every other answer
      // is already known, and a runtime is a few hundred kilobytes.
      const source = await readFile(path.join(dir, name), 'utf8');
      if (marker(source)) {
        claimed.push(name);
      }
    }
  }
  return { claimed, siblings };
}
