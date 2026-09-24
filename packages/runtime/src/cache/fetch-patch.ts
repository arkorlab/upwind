/**
 * Both of a deployment's Next.js module graphs get to patch `fetch`.
 *
 * Next.js caches a `fetch` by replacing the global one, and it does that exactly once per
 * isolate: `patchFetch` returns early when `globalThis[Symbol.for('next-patch')]` is set
 * (`next/dist/server/lib/patch-fetch.js`). The patched function closes over the
 * `workAsyncStorage` of the graph that installed it, and reads the request's work store — the
 * incremental cache among it — from there.
 *
 * On Next.js's own server that is one graph. Here it is two: the code built for the Node.js
 * runtime is a module of the Worker, and the code built for the edge runtime is a second one,
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
 * A graph is let in for the length of one invocation and no longer. Leaving the flag down
 * between invocations would let any graph take a turn opened for another — a middleware is
 * loaded from the edge graph and patches nothing, and the Node.js render that follows it in the
 * same request would take the edge graph's turn and patch a second time. Nor is "the global
 * changed while a graph was running" enough to say that graph patched, so a turn counts as
 * taken only when no other invocation overlapped it; where one did, the graph simply gets
 * another turn on a later request.
 */

const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');

export type EntryGraph = 'app' | 'edge';

const patched: Record<EntryGraph, boolean> = { app: false, edge: false };
/** Turns running right now, and how many have been opened in all. */
const turns = { open: 0, opened: 0 };

type Handler = (...args: never[]) => Promise<unknown>;

/** Open a turn for `graph`, and give back what closes it. */
function openTurn(graph: EntryGraph): () => void {
  const before = globalThis.fetch;
  const alone = turns.open === 0;
  turns.opened += 1;
  turns.open += 1;
  const seq = turns.opened;
  Reflect.deleteProperty(globalThis, NEXT_PATCH_SYMBOL);
  return () => {
    turns.open -= 1;
    // Nothing else ran inside this turn, so a global that changed changed for this graph.
    if (alone && turns.open === 0 && turns.opened === seq && globalThis.fetch !== before) {
      patched[graph] = true;
    }
    // Down again: nothing patches outside a turn, whoever asks.
    Reflect.set(globalThis, NEXT_PATCH_SYMBOL, true);
  };
}

/**
 * `handler`, invoked with its graph allowed to patch `fetch` while it has not yet. A graph whose
 * patch is in place is handed back its handler untouched, so once an isolate is serving there is
 * nothing of this on the path at all — not a wrapper, not a promise, not a branch.
 */
export function admitting<H extends Handler>(graph: EntryGraph, handler: H): H {
  if (patched[graph]) {
    return handler;
  }
  return (async (...args: Parameters<H>) => {
    // Asked again here: the handler may have been taken before the graph's turn came.
    if (patched[graph]) {
      return handler(...args);
    }
    const close = openTurn(graph);
    try {
      return await handler(...args);
    } finally {
      close();
    }
  }) as H;
}
