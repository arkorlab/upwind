import { afterAll, describe, expect, it } from 'vitest';

import { admitting } from '../src/cache/fetch-patch.ts';

/**
 * A graph let in to the global `fetch` while another invocation of it is still running.
 *
 * A page answered from a generation streams its resume on after the response has started, and
 * the next request began inside it. Neither invocation was counted as the graph's turn, the next
 * one of the graph was let in again, and Next.js patched a second time over its own fetcher: the
 * outer one took the request's cache lock on a key and called the inner, which waited on that
 * same lock for good. Every render of the page that missed the cache hung, and every request for
 * it after (`app-dir/non-ascii-cache-tags`).
 */

const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');
const original = globalThis.fetch;

/** What Next.js's own `patchFetch` does: wrap the global once, and mark that it did. */
function patchFetch(): boolean {
  if (Reflect.get(globalThis, NEXT_PATCH_SYMBOL) === true) {
    return false;
  }
  const wrapped = globalThis.fetch;
  Reflect.set(globalThis, 'fetch', (...args: Parameters<typeof fetch>) => wrapped(...args));
  Reflect.set(globalThis, NEXT_PATCH_SYMBOL, true);
  return true;
}

/** A graph's handler that patches as it starts, and ends only once `done` resolves. */
function streaming(graph: 'app' | 'edge', done: Promise<unknown>): () => Promise<boolean> {
  return admitting(graph, async () => {
    const patchedHere = patchFetch();
    await done;
    return patchedHere;
  });
}

describe('invocations of one graph running at once', () => {
  afterAll(() => {
    Reflect.set(globalThis, 'fetch', original);
  });

  it('let the graph patch once, and the other graph once beside it', async () => {
    const first = Promise.withResolvers<undefined>();
    const firstPage = streaming('app', first.promise)();
    // The next request begins while the first page is still streaming, and one of the edge graph
    // runs beside them both.
    const secondPage = streaming('app', Promise.resolve())();
    const edgeRoute = streaming('edge', Promise.resolve())();
    first.resolve(undefined);

    await expect(Promise.all([firstPage, secondPage, edgeRoute])).resolves.toStrictEqual([
      true,
      false,
      true,
    ]);
    // And once both have, a graph asked again is patched already.
    await expect(streaming('app', Promise.resolve())()).resolves.toBe(false);
    await expect(streaming('edge', Promise.resolve())()).resolves.toBe(false);
  });
});
