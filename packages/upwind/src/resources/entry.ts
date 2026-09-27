import { PROJECT_DIR_ENV } from './entry-path.ts';
import { startLocalResources } from './local.ts';

/**
 * The process that renders a build's pages, with its project's storage published before it runs
 * anything.
 *
 * This is what `--import` names (`entry-path.ts` says why it has to be an import). Every process a
 * build starts reaches it — the build itself, the two `tsc` runs, the worker that renders — and
 * only one of them may have storage, because one directory of it admits one runtime (`local.ts`).
 * The one that needs it is the renderer: `generateStaticParams` reading a database is the case that
 * matters, and by the time a page renders it is far too late to publish anything.
 *
 * Next.js names that process for us. `createStaticWorker` puts
 * `__NEXT_PRERENDER_CLIENT_ASSET_SUFFIX` in the environment of the prerender workers and of nothing
 * else, so it is what this reads — and if a later Next.js stops setting it, the build says it found
 * no storage rather than doing something stranger.
 *
 * It is one process only while the build renders in one process, which is `experimental.cpus`, which
 * `upwind build` asks for through the adapter. Several renderers would be several runtimes over one
 * directory, and all but the first would have nothing.
 *
 * Top level and awaited: the runtime has to be up before the module graph below it is evaluated, and
 * an `--import` module is the one place where waiting for that is free.
 */

/** Set by `createStaticWorker`, in the workers that prerender and in no other process. */
const PRERENDER_WORKER_ENV = '__NEXT_PRERENDER_CLIENT_ASSET_SUFFIX';

if (process.env[PRERENDER_WORKER_ENV] !== undefined) {
  const local = await startLocalResources(process.env[PROJECT_DIR_ENV] ?? process.cwd(), {
    // This process is ended by the pool that started it — `SIGTERM`, half a second after it asks —
    // and the runtime's own handlers are what kill the runtime when that happens.
    answersSignals: false,
  });
  process.once('beforeExit', () => {
    // For a process that ends by running out of work rather than by exiting: the runtime's own exit
    // hook covers every `process.exit`, and this covers anything that drains its loop instead.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- nothing is left to wait on it.
    void local.dispose();
  });
}
