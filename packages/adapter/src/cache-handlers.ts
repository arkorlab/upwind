import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { jsLiteral } from './codegen.ts';
import { exists } from './fs.ts';

/**
 * The cache handlers an application configured — `cacheHandler`, the incremental cache Next.js
 * keeps `fetch` and `unstable_cache` values in, and `cacheHandlers`, a module for each kind of
 * `"use cache"` — bundled into the Function.
 *
 * Next.js's route modules load each with a dynamic `import()` of a file, by the path `next build`
 * recorded for it in `required-server-files.json`, relative to the build's output directory
 * (`getIncrementalCache` and `loadCustomCacheHandlers`, in `route-module.ts`). A Function has no
 * file to import, so the `cache-handlers` patch turns both imports into a `require` of the module
 * written here, which answers each recorded path with the handler the build bundled for it.
 *
 * What a handler replaces is what Next.js hands it, and no more. Next.js in minimal mode keeps no
 * page in the incremental cache (`ResponseCache`), so a `cacheHandler` takes the data cache and the
 * pages stay the platform's; a kind of `cacheHandlers` takes that kind of `"use cache"`, and the
 * other kinds stay the platform's. Next.js keeps the handler a kind had among those an
 * invalidation is handed (`setCacheHandler` adds to the set it never takes from), so
 * `revalidateTag`, `revalidatePath` and `updateTag` reach the platform's cache as well.
 */

/**
 * The generated module's name, under the directory the build works in and removes once the
 * Functions are made: it is an input of their bundles alone, and names files by where the build
 * ran.
 */
const MODULE_NAME = 'cache-handlers.cjs';
const WORK_DIR = 'work';
/** What Next.js records the configuration a route module reads at request time in. */
const SERVER_FILES_MANIFEST = 'required-server-files.json';

/** A cache handler the application configured. */
export interface CacheHandlerModule {
  /** The option that names it: `cacheHandler`, or `cacheHandlers.<kind>`. */
  readonly option: string;
  /** The path Next.js recorded for it, relative to the output directory: what it is imported by. */
  readonly recorded: string;
  /** The module's file. */
  readonly file: string;
}

function recordedPath(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The handlers `next build` recorded, each with the file its path names: none for a build that
 * configured none, or that recorded no configuration at all. A recorded path whose file is not
 * there fails the build here, where the message can say which option named it, rather than on the
 * first request that asks for it.
 */
export async function configuredCacheHandlers(distDir: string): Promise<CacheHandlerModule[]> {
  const manifest = path.join(distDir, SERVER_FILES_MANIFEST);
  if (!(await exists(manifest))) {
    return [];
  }
  const parsed: unknown = JSON.parse(await readFile(manifest, 'utf8'));
  const config =
    typeof parsed === 'object' && parsed !== null && 'config' in parsed ? parsed.config : undefined;
  if (typeof config !== 'object' || config === null) {
    return [];
  }
  const recorded: { option: string; value: unknown }[] = [];
  if ('cacheHandler' in config) {
    recorded.push({ option: 'cacheHandler', value: config.cacheHandler });
  }
  const kinds = 'cacheHandlers' in config ? config.cacheHandlers : undefined;
  if (typeof kinds === 'object' && kinds !== null) {
    const entries = Object.entries(kinds);
    for (const [kind, value] of entries) {
      recorded.push({ option: `cacheHandlers.${kind}`, value });
    }
  }
  const handlers: CacheHandlerModule[] = [];
  for (const { option, value } of recorded) {
    const relative = recordedPath(value);
    if (relative === undefined) {
      continue;
    }
    const file = path.resolve(distDir, relative);
    if (!(await exists(file))) {
      throw new Error(
        `@stayingupwind/adapter: ${option} names ${file}, which is not there to bundle into the Function`,
      );
    }
    handlers.push({ option, recorded: relative, file });
  }
  return handlers;
}

/**
 * Write the module the patched route modules load the handlers from, and answer its path.
 *
 * Each handler is required once it is asked for, as Next.js imports it, rather than when the
 * Function starts: a handler that throws as it loads fails what it was asked for, as it would under
 * Next.js. And each is answered by its default export where it has one, as
 * `dynamicImportEsmDefault` answers: a CommonJS module's `module.exports`, an ES module's
 * `export default`, and a compiled one's `exports.default` alike.
 *
 * A handler travels as what it imports, bundled with it. A file it reads at run time does not:
 * Next.js traces a handler only into the whole server's trace, among everything else the server
 * reads, and nothing here traces it apart. And an ES module that awaits at its top level is not
 * taken by the Function's CommonJS bundle, however it were loaded; Rolldown refuses the build, as
 * it would for a route's.
 */
export async function writeCacheHandlers(
  outDir: string,
  handlers: readonly CacheHandlerModule[],
): Promise<string> {
  const source = [
    '// Generated by @stayingupwind/adapter: the cache handlers this build configured, by the path',
    '// Next.js recorded for each in `required-server-files.json`.',
    "'use strict';",
    'const handlers = {',
    ...handlers.map(
      (handler) => `  ${jsLiteral(handler.recorded)}: () => require(${jsLiteral(handler.file)}),`,
    ),
    '};',
    'exports.load = async (recorded) => {',
    '  const load = Object.hasOwn(handlers, recorded) ? handlers[recorded] : undefined;',
    '  if (load === undefined) {',
    "    throw new Error('@stayingupwind/adapter: no cache handler was bundled for ' + recorded);",
    '  }',
    '  const loaded = load();',
    '  return loaded.default || loaded;',
    '};',
    '',
  ].join('\n');
  const workDir = path.join(outDir, WORK_DIR);
  await mkdir(workDir, { recursive: true });
  const file = path.join(workDir, MODULE_NAME);
  await writeFile(file, source);
  return file;
}

/**
 * What a build that configures its own cache handler is told: that it is taken, what it takes from
 * the platform's cache, and what of the platform's it does not have.
 */
export function cacheHandlersWarning(handlers: readonly CacheHandlerModule[]): string {
  const named = handlers.map((handler) => `${handler.option} (${handler.recorded})`).join(', ');
  return [
    `@stayingupwind/adapter: this build configures its own cache handler: ${named}.`,
    'It is bundled into the Function and takes what Next.js hands it from the platform’s cache',
    '— a cacheHandler the data cache (fetch, unstable_cache), a kind of cacheHandlers that kind',
    'of "use cache" — while pages stay the platform’s, and revalidateTag, revalidatePath and',
    'updateTag still reach the platform’s cache. It runs in each isolate of the Function: what',
    'it keeps in memory is that isolate’s alone, and a store every isolate reaches is what',
    'makes a cache shared. And what the platform’s own handlers do beside the cache is not done',
    'for it: a write is not held to land before the response ends, and a value Next.js answers',
    'stale is revalidated behind the response only as far as the request’s work goes on. What',
    'it imports is bundled with it; a file it reads at run time is not.',
  ].join(' ');
}

/**
 * The module the cache handlers the app configured are loaded from (`writeCacheHandlers`), and the
 * warning a build that configures one is given; nothing for a build that configures none.
 */
export async function cacheHandlersModule(
  distDir: string,
  outDir: string,
): Promise<string | undefined> {
  const handlers = await configuredCacheHandlers(distDir);
  if (handlers.length === 0) {
    return undefined;
  }
  console.warn(cacheHandlersWarning(handlers));
  return writeCacheHandlers(outDir, handlers);
}
