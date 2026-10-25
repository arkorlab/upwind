import os from 'node:os';

import { UPWIND_LOCAL_RESOURCES_ENV } from '@stayingupwind/core/paas';
import type { NextAdapter } from 'next';

import { keepMapsThrough } from './kept-maps.ts';
import { carriesMaps, type SourceMapsOption } from './source-maps.ts';

/** The config `modifyConfig` is handed, as Next.js declares it. */
export type BuildConfig = Parameters<NonNullable<NextAdapter['modifyConfig']>>[0];

/**
 * That the line below has been said already, where the next process to say it can see.
 *
 * A build loads its config more than once and in more than one process, and that is a line worth
 * reading exactly once. The environment is what those processes share.
 */
const SAID_ENV = 'UPWIND_LOCAL_RESOURCES_SAID';

/**
 * Next.js's own default for `experimental.cpus`, which is always set by the time a config is handed
 * over — so "the project chose this" means "not this".
 *
 * The same expression `defaultConfig` uses (`server/config-shared`), and the same test Next.js makes
 * of it when it decides whether a count is a user override (`getNumberOfWorkers` in `build/index`).
 * Read out of a copy of Next.js it would be an import into internals; written here it is one line
 * that is wrong only if Next.js changes its default, and then the worst of it is a build that leaves
 * the count alone.
 */
function defaultCpus(): number {
  return Math.max(1, (Number(process.env['CIRCLE_NODE_TOTAL']) || os.cpus().length) - 1);
}

/**
 * Render this build's pages in one process, because its storage can only be in one.
 *
 * Only for a build that has local storage in it, which is `upwind build` in a project that reads
 * storage and nothing else (`UPWIND_LOCAL_RESOURCES_ENV` says why one process). It is a real cost —
 * page data is collected by one worker rather than several — so it is said out loud rather than done
 * quietly, and a project that has asked for a worker count of its own keeps it: whoever wrote that
 * line knows something this does not.
 */
export function renderInOneProcessForStorage(config: BuildConfig): void {
  const chosen = config.experimental.cpus;
  if (
    process.env[UPWIND_LOCAL_RESOURCES_ENV] !== '1' ||
    (chosen !== undefined && chosen !== defaultCpus())
  ) {
    return;
  }
  config.experimental.cpus = 1;
  if (process.env[SAID_ENV] === '1') {
    return;
  }
  process.env[SAID_ENV] = '1';
  console.log(
    "@stayingupwind/adapter: this build has the project's local storage in it, so its pages are rendered in one process. Set `experimental.cpus` yourself to decide otherwise — a page that reads storage while it prerenders then fails in every process but one.",
  );
}

/** Ask Next.js to emit and retain both the browser and server maps the host carries. */
export function configureBuildSourceMaps(config: BuildConfig, sourceMaps: SourceMapsOption): void {
  if (!carriesMaps(sourceMaps)) return;
  // Both halves, because a stack has both in it: a page's frames are in the browser
  // chunks, and a render's are in the server ones. What keeps the browser maps from being
  // served is `onBuildComplete`, which takes them out of the static files.
  config.productionBrowserSourceMaps = true;
  config.experimental.serverSourceMaps = true;
  // And what keeps them at all, where the project's own hook would take them away first.
  // `compiler` is `{}` among Next.js's defaults, but asked of rather than assumed: this
  // adapter takes a Next.js as old as 16.2, and an absent one has no hook to wrap anyway.
  const compiler = config.compiler as BuildConfig['compiler'] | undefined;
  const kept = keepMapsThrough(compiler?.runAfterProductionCompile);
  if (compiler !== undefined && kept !== undefined) {
    compiler.runAfterProductionCompile = kept;
  }
}
