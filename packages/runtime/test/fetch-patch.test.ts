import { afterAll, describe, expect, it } from 'vitest';

import { admitting } from '../src/cache/fetch-patch.ts';

/**
 * Letting both of a deployment's Next.js module graphs patch `fetch`.
 *
 * Next.js patches the global once per isolate and remembers having done it on
 * `Symbol.for('next-patch')`. Two graphs live in this Worker — the code built for the Node.js
 * runtime and the code built for the edge runtime, each with its own copy of Next.js and so its
 * own work-store storage — and the one that loses would silently stop caching any `fetch` it was
 * told to cache.
 *
 * One isolate's story, in the order a request makes it: a middleware loaded from the edge graph
 * that renders nothing, the Node.js route behind it, a second request of the same shape, and
 * then an edge route. The two cases below run in that order and share the module's state, as
 * the requests of one isolate do.
 */

const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');
const original = globalThis.fetch;

function patchable(): boolean {
  return Reflect.get(globalThis, NEXT_PATCH_SYMBOL) !== true;
}

/** What Next.js's own `patchFetch` does: wrap the global once, and mark that it did. */
function patchFetch(): boolean {
  if (!patchable()) {
    return false;
  }
  const wrapped = globalThis.fetch;
  Reflect.set(globalThis, 'fetch', (...args: Parameters<typeof fetch>) => wrapped(...args));
  Reflect.set(globalThis, NEXT_PATCH_SYMBOL, true);
  return true;
}

/** A graph's handler; whether it renders is what decides whether Next.js patches in it. */
function renderer(graph: 'app' | 'edge', renders: boolean): () => Promise<boolean> {
  return admitting(graph, () => Promise.resolve(renders && patchFetch()));
}

/** The middleware: loaded from the edge graph, and it renders nothing. */
const middleware = renderer('edge', false);
const nodeRoute = renderer('app', true);
const edgeRoute = renderer('edge', true);

describe('admitting a module graph to the global fetch', () => {
  afterAll(() => {
    Reflect.set(globalThis, 'fetch', original);
    Reflect.deleteProperty(globalThis, NEXT_PATCH_SYMBOL);
  });

  it('keeps a graph its turn until it has taken it', async () => {
    // First request: the middleware spends nothing, and the Node.js route patches.
    await expect(middleware()).resolves.toBe(false);
    await expect(nodeRoute()).resolves.toBe(true);

    // Second request of the same shape: the turn the middleware opened is not the Node.js
    // graph's to take, and that graph has taken its own already.
    await expect(middleware()).resolves.toBe(false);
    await expect(nodeRoute()).resolves.toBe(false);

    // The edge graph never took a turn, so it still gets one.
    await expect(middleware()).resolves.toBe(false);
    await expect(edgeRoute()).resolves.toBe(true);
  });

  it('leaves no turn open once both graphs have patched', async () => {
    await expect(nodeRoute()).resolves.toBe(false);
    await expect(edgeRoute()).resolves.toBe(false);
    await expect(middleware()).resolves.toBe(false);

    expect(patchable(), 'no turn is left open between invocations').toBe(false);
  });
});
