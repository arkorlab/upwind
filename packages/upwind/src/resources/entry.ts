import { PROJECT_DIR_ENV } from './entry-path.ts';
import { startLocalResources } from './local.ts';
import { installNextResourceCacheLoader } from './next-cache-loader.ts';

/**
 * The process that renders a build's pages, with its project's storage published before it runs
 * anything.
 *
 * This is what `--import` names (`entry-path.ts` says why it has to be an import). Every process a
 * build starts reaches it — the build itself, the two `tsc` runs, the worker that renders — and only
 * the renderer needs storage: `generateStaticParams` reading a database is the case that matters, and
 * by the time a page renders it is far too late to publish anything.
 *
 * Next.js names that process for us. `createStaticWorker` puts
 * `__NEXT_PRERENDER_CLIENT_ASSET_SUFFIX` in the environment of the prerender workers and of nothing
 * else, so it is what this reads — and if a later Next.js stops setting it, the build says it found
 * no storage rather than doing something stranger.
 *
 * It is one process because `upwind build` asks the adapter to render in one (`experimental.cpus`).
 * Several renderers would be several runtimes over one directory: they could all read it, and the
 * first of them to write would be the only one that could (`local.ts`).
 *
 * Top level and awaited: the runtime has to be up before the module graph below it is evaluated, and
 * an `--import` module is the one place where waiting for that is free.
 *
 * Nothing here disposes of it. A process holding a runtime never runs out of work — the handles it
 * keeps see to that — so `beforeExit` is not a thing that happens here. What ends this process is the
 * pool's `SIGTERM`, and what ends the runtime with it is the runtime's own handler for that signal,
 * which is why this one is left to answer it (`local.ts`, `answersSignals`).
 */

/** Set by `createStaticWorker`, in the workers that prerender and in no other process. */
const PRERENDER_WORKER_ENV = '__NEXT_PRERENDER_CLIENT_ASSET_SUFFIX';

if (process.env[PRERENDER_WORKER_ENV] !== undefined) {
  installNextResourceCacheLoader();
  await startLocalResources(process.env[PROJECT_DIR_ENV] ?? process.cwd(), {
    // This process is ended by the pool that started it — `SIGTERM`, half a second after it asks —
    // and the runtime's own handlers are what kill the runtime when that happens.
    answersSignals: false,
  });
}
