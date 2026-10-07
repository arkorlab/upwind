import { createRequire } from 'node:module';
import path from 'node:path';

import type { NextAdapter } from 'next';

import { orDefault } from './collect.ts';

type ModifyContext = Parameters<NonNullable<NextAdapter['modifyConfig']>>[1];

/** Node.js's registry of the CommonJS modules this process has loaded, Next.js's own among them. */
const loadedModules = createRequire(import.meta.url).cache;
/** The module `next build` records what it was asked to build in (`NextBuildContext`). */
const BUILD_CONTEXT = `${path.sep}${path.join('next', 'dist', 'build', 'build-context.js')}`;

/**
 * The directory the running `next build` was given, as it recorded it. 16.2's build sets
 * `NextBuildContext.dir` before it loads the config, and so does the worker it compiles in, from
 * what the build handed it, before it loads the config again.
 *
 * Read off the module the running Next.js loaded rather than one resolved from here, which may be
 * another copy of Next.js that built nothing. `undefined` in a process no build recorded one in.
 */
function recordedBuildDir(): string | undefined {
  for (const [file, loaded] of Object.entries(loadedModules)) {
    if (!file.endsWith(BUILD_CONTEXT)) {
      continue;
    }
    const exported = loaded?.exports as { NextBuildContext?: { dir?: unknown } } | undefined;
    const dir = exported?.NextBuildContext?.dir;
    if (typeof dir === 'string') {
      return dir;
    }
  }
  return undefined;
}

/**
 * The project's directory, which `modifyConfig` is told from 16.3.
 *
 * 16.2 tells the hook its phase and its version, and no directory. Its `next build` has recorded
 * the directory by then (`recordedBuildDir`), and that is the project however the build was
 * pointed at it: `next build apps/site` from the root of a repository, for a project with a config
 * of its own or for one that takes the root's. Outside such a build it is the working directory,
 * which is what `next build` resolves when it is given none.
 */
export function projectDirOf(context: ModifyContext): string {
  return (
    orDefault<string | undefined>(context.projectDir, undefined) ??
    recordedBuildDir() ??
    process.cwd()
  );
}
