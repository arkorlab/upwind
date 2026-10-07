import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Both of a deployment's Next.js module graphs get to patch `fetch`, each of them once.
 *
 * Next.js caches a `fetch` by replacing the global one, and it does that exactly once per
 * isolate: `patchFetch` returns early when `globalThis[Symbol.for('next-patch')]` is set
 * (`next/dist/server/lib/patch-fetch.js`). The patched function closes over the
 * `workAsyncStorage` of the graph that installed it, and reads the request's work store — the
 * incremental cache among it — from there.
 *
 * On Next.js's own server that is one graph. Here it is two: the code built for the Node.js
 * runtime is a module of the Function, and the code built for the edge runtime is a second one,
 * with its own copy of Next.js and so its own `AsyncLocalStorage`. Whichever renders first in an
 * isolate takes the global, and every cached `fetch` of the other then finds no work store and
 * is passed straight through — no key, no read, no write, and nothing said about it. A page and
 * a route handler that ask the same URL for the same data end up in two different worlds
 * depending on which route the isolate happened to serve first.
 *
 * So the second graph is let in too, and the two compose: the outer fetcher looks for its own
 * store, finds none for a render of the other graph, and calls what it wrapped (`patch-fetch.js`,
 * "If the workStore is not available … fallback to the original fetch implementation"), which is
 * the other graph's fetcher, which does find one. Order does not matter.
 *
 * What must not happen is one graph patching twice. Both of its fetchers then find the store, and
 * the outer takes the request's cache lock on a key and calls the inner, which waits on that same
 * lock for good (`IncrementalCache.lock`): every render of the page that missed the cache hung,
 * and so did every request for it after. So the flag answers for the graph that asks — which the
 * invocation it runs in says — and it is set for the graph that sets it: each patches once, and
 * two invocations running at once cannot give one graph a second turn. It used to be lowered for
 * the length of an invocation and judged afterwards by whether the global had changed with
 * nothing else running; a first page streamed on while the next request began, neither turn
 * counted, and the next invocation of the same graph patched again (`non-ascii-cache-tags`).
 *
 * From 16.4 the two graphs share their storage: Next.js anchors each of its six storages to a
 * symbol on `globalThis` (`@next/work-async-storage@<version>`,
 * `getOrCreateGlobalAsyncLocalStorage`), which one realm holds one of whatever its copies of
 * Next.js. Both fetchers then find the store, and the two that composed are the double patch above,
 * deadlocked on the lock the outer one took. So where the storage is shared there is one fetcher,
 * and it is the Node.js graph's where it can be, since that is the copy the adapter's rewrites
 * reach (`fetch-cache-wait-until`): a graph that finds it in place does not patch, and the Node.js
 * graph, finding the edge graph's in place, patches over what that one found beneath it rather than
 * over it.
 */

const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');
/** The key Next.js anchors a realm's work storage to from 16.4, before the version it ends in. */
const SHARED_WORK_STORAGE = '@next/work-async-storage@';

export type EntryGraph = 'app' | 'edge';

/** Whether the graph's renders have a patched `fetch` to go through, its own or the other's. */
const patched: Record<EntryGraph, boolean> = { app: false, edge: false };
/**
 * The global `fetch` the edge graph found when it was let patch: what the Node.js graph patches
 * over when it finds the edge graph's fetcher in place.
 */
const beneath: { edge?: typeof fetch } = {};
/** The graph whose handler an invocation is running, while it has not yet patched. */
const invocations = new AsyncLocalStorage<EntryGraph>();
const flag = { installed: false, shared: false };

/** Whether the graphs share one work storage, which a Next.js from 16.4 makes them do. */
function storageShared(): boolean {
  flag.shared ||= Object.getOwnPropertySymbols(globalThis).some(
    (symbol) => symbol.description?.startsWith(SHARED_WORK_STORAGE) === true,
  );
  return flag.shared;
}

/** Whether `graph` patches now, with the global it is to patch over put in place if so. */
function admits(graph: EntryGraph): boolean {
  if (patched[graph]) {
    return false;
  }
  if (storageShared()) {
    if (graph === 'edge' && patched.app) {
      patched.edge = true;
      return false;
    }
    const underEdge = beneath.edge;
    if (underEdge !== undefined && graph === 'app' && patched.edge) {
      Reflect.set(globalThis, 'fetch', underEdge);
    }
  }
  if (graph === 'edge') {
    beneath.edge = globalThis.fetch;
  }
  return true;
}

/**
 * Put the flag in place, once: before the first handler is handed out, and so before anything
 * Next.js runs could read it.
 */
function installFlag(): void {
  if (flag.installed) {
    return;
  }
  flag.installed = true;
  Object.defineProperty(globalThis, NEXT_PATCH_SYMBOL, {
    configurable: true,
    /** Patched, for the graph asking; for anything asking outside an invocation, patched as well. */
    get(): boolean {
      const graph = invocations.getStore();
      return graph === undefined || !admits(graph);
    },
    /** What Next.js sets once it has patched: the graph asking has. */
    set(value: unknown): void {
      const graph = invocations.getStore();
      if (graph !== undefined && value === true) {
        patched[graph] = true;
      }
    },
  });
}

type Handler = (...args: never[]) => Promise<unknown>;

/**
 * `handler`, invoked with its graph allowed to patch `fetch` while it has not yet. A graph whose
 * patch is in place is handed back its handler untouched, so once an isolate is serving there is
 * nothing of this on the path at all — not a wrapper, not a promise, not a branch.
 */
export function admitting<H extends Handler>(graph: EntryGraph, handler: H): H {
  if (patched[graph]) {
    return handler;
  }
  installFlag();
  return (async (...args: Parameters<H>) => {
    // Asked again here: the handler may have been taken before the graph patched.
    if (patched[graph]) {
      return handler(...args);
    }
    return invocations.run(graph, () => handler(...args));
  }) as H;
}
