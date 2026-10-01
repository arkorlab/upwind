import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { UPWIND_AUTH_BASE_PATH } from '@stayingupwind/core/paas';

/**
 * Where a project keeps its authentication config, and where a route of its own would go.
 *
 * `auth.ts` sits beside `app` — the same place `proxy.ts` and `instrumentation.ts` sit, which is the
 * project root for most projects and `src/` for the ones that use it. That is Next.js's own rule for
 * a root file, and it is kept here rather than restated: a project is a `src/` project because its
 * `app` is under `src`, not because a directory called `src` happens to exist.
 *
 * Nothing here loads the file. Reading a project's TypeScript from this process would mean resolving
 * its `@/` aliases, its `.env` and its bundler's conditions — all of which Next.js already does, for
 * the route this layout is used to write. So the only question asked here is whether the file is
 * there, and the answer to everything else is deferred to the one process that can answer it.
 */

/**
 * What an auth config may be called. Next.js's own root files are resolved against `pageExtensions`,
 * which a project may have changed; this list is fixed and deliberately ordinary, because a project
 * that has moved its extensions has also moved past the point where anything is being set up for it.
 */
const EXTENSIONS: readonly string[] = ['ts', 'tsx', 'mts', 'js', 'jsx', 'mjs'];

/** The name, without an extension. `proxy` and `instrumentation` are its neighbours. */
const CONFIG_NAME = 'auth';

export interface AuthLayout {
  /** The config file, absolute — the one that exists, in the order above. */
  readonly configFile: string;
  /** Whether that file is TypeScript, which decides what a generated route beside it is written as. */
  readonly typescript: boolean;
  /** The directory `app` and the config share: the project root, or `src`. */
  readonly rootDir: string;
  /** The `app` directory, absolute, or nothing for a project that has only `pages`. */
  readonly appDir: string | undefined;
}

/**
 * Next.js's own `findDir`: `./<name>` wins over `./src/<name>`, and neither being there is an
 * answer rather than a failure.
 */
function findDir(projectDir: string, name: string): string | undefined {
  const atRoot = path.join(projectDir, name);
  if (existsSync(atRoot)) {
    return atRoot;
  }
  const underSrc = path.join(projectDir, 'src', name);
  return existsSync(underSrc) ? underSrc : undefined;
}

/**
 * The first of the names that is there, or nothing when the project has no auth config.
 *
 * A file, not merely an entry: a directory called `auth.ts` is not a module, and taking it for one
 * would have upwind write a route importing something that cannot be imported — a build failure
 * about a file the developer never wrote.
 */
function findConfig(rootDir: string): string | undefined {
  for (const extension of EXTENSIONS) {
    const candidate = path.join(rootDir, `${CONFIG_NAME}.${extension}`);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not there. The next name, or none.
    }
  }
  return undefined;
}

/**
 * What this project has to say about authentication, or nothing at all — which is every project
 * that has not asked for any, and is the case this is written to be cheap in: a handful of
 * `existsSync` calls on paths the filesystem has cached, and no further work. `pages` is only
 * looked for when there is no `app`, since it is wanted for one thing and `app` already answers it.
 *
 * The root is taken from `app` where there is one and from `pages` otherwise, so that a project with
 * both is read the way Next.js reads it (they must share a parent, and Next.js refuses the build if
 * they do not). A project with neither has no routes to serve anything from, and the project
 * directory is the honest answer for where its config would go.
 */
export function authLayout(projectDir: string): AuthLayout | undefined {
  const appDir = findDir(projectDir, 'app');
  const rootDir = path.dirname(
    appDir ?? findDir(projectDir, 'pages') ?? path.join(projectDir, 'app'),
  );
  const configFile = findConfig(rootDir);
  if (configFile === undefined) {
    // One case where "no auth config" is the wrong thing to conclude silently: a project half way
    // through moving into `src`, whose `app` is still at the root and whose `auth.ts` has already
    // gone. Next.js reads root files the same way and would ignore a `src/proxy.ts` just as
    // quietly, which is exactly why it is worth saying out loud rather than leaving a developer to
    // wonder why nothing is mounted.
    const otherRoot = rootDir === projectDir ? path.join(projectDir, 'src') : projectDir;
    const elsewhere = findConfig(otherRoot);
    if (elsewhere !== undefined) {
      console.warn(
        `upwind: ${elsewhere} is not where Next.js looks for a root file — it reads them from ${rootDir}, beside \`app\`. Move it there and ${UPWIND_AUTH_BASE_PATH} is served for you.`,
      );
    }
    return undefined;
  }
  return {
    configFile,
    typescript: /\.[cm]?tsx?$/u.test(configFile),
    rootDir,
    appDir,
  };
}
