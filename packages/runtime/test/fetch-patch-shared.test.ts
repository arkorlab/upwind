import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Letting the two module graphs patch `fetch` where Next.js makes them share one work storage.
 *
 * From 16.4 Next.js anchors its storages to symbols on `globalThis`, so the Node.js graph's copy
 * and the edge graph's copy read one store. Two fetchers wrapping each other then both find it,
 * and the outer one takes the request's cache lock and calls the inner one, which waits on that
 * lock for good — the hang `runtime/edge-cache.test.ts` met after a tag withdrew an entry. So there
 * is one fetcher, and it is the Node.js graph's wherever it can be.
 *
 * Each case starts the module afresh, as a new isolate does: which graph renders first is the
 * question, and only a fresh module has not been asked it yet.
 */

const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');
/**
 * What a copy of Next.js from 16.4 puts on `globalThis` once it is loaded, under the name of its
 * own release — so the runtime asks for the name's beginning, and every release from 16.4 is one.
 */
function sharedWorkStorage(version: string): symbol {
  return Symbol.for(`@next/work-async-storage@${version}`);
}
const original = globalThis.fetch;

/** A fetcher as Next.js installs it, saying which graph's it is and what it wrapped. */
type Fetcher = typeof fetch & { readonly graph: string; readonly wrapped: typeof fetch };

function patchable(): boolean {
  return Reflect.get(globalThis, NEXT_PATCH_SYMBOL) !== true;
}

/** What Next.js's own `patchFetch` does: wrap the global once, and mark that it did. */
function patchFetch(graph: 'app' | 'edge'): boolean {
  if (!patchable()) {
    return false;
  }
  const wrapped = globalThis.fetch;
  const fetcher = Object.assign((...args: Parameters<typeof fetch>) => wrapped(...args), {
    graph,
    wrapped,
  });
  Reflect.set(globalThis, 'fetch', fetcher);
  Reflect.set(globalThis, NEXT_PATCH_SYMBOL, true);
  return true;
}

/** The two routes of a fresh isolate: a Node.js one and an edge one, each patching as it renders. */
async function isolate(): Promise<{
  readonly nodeRoute: () => Promise<boolean>;
  readonly edgeRoute: () => Promise<boolean>;
}> {
  vi.resetModules();
  const { admitting } = await import('../src/cache/fetch-patch.ts');
  return {
    nodeRoute: admitting('app', () => Promise.resolve(patchFetch('app'))),
    edgeRoute: admitting('edge', () => Promise.resolve(patchFetch('edge'))),
  };
}

function restore(): void {
  Reflect.set(globalThis, 'fetch', original);
  Reflect.deleteProperty(globalThis, NEXT_PATCH_SYMBOL);
}

describe.each(['16.4.0', '16.5.0-canary.2'])(
  'admitting the module graphs to a fetch where they share one storage (%s)',
  (version) => {
    const shared = sharedWorkStorage(version);

    afterEach(() => {
      restore();
      Reflect.deleteProperty(globalThis, shared);
    });

    it("leaves the edge graph the Node.js graph's fetcher when that one patched first", async () => {
      const { nodeRoute, edgeRoute } = await isolate();
      Reflect.set(globalThis, shared, {});

      await expect(nodeRoute()).resolves.toBe(true);
      await expect(edgeRoute()).resolves.toBe(false);

      const fetcher = globalThis.fetch as Fetcher;

      expect(fetcher.graph).toBe('app');
      expect(fetcher.wrapped).toBe(original);
      expect(patchable(), 'no turn is left open between invocations').toBe(false);
    });

    it('patches the Node.js graph over what the edge graph found, rather than over it', async () => {
      const { nodeRoute, edgeRoute } = await isolate();
      Reflect.set(globalThis, shared, {});

      await expect(edgeRoute()).resolves.toBe(true);
      await expect(nodeRoute()).resolves.toBe(true);

      const fetcher = globalThis.fetch as Fetcher;

      // One fetcher, the Node.js graph's, wrapping the fetch the edge graph found: the edge graph's
      // is out of the way rather than beneath it, where both would find the store.
      expect(fetcher.graph).toBe('app');
      expect(fetcher.wrapped).toBe(original);

      await expect(edgeRoute()).resolves.toBe(false);
      await expect(nodeRoute()).resolves.toBe(false);

      expect(patchable(), 'no turn is left open between invocations').toBe(false);
    });
  },
);

describe('admitting the module graphs to a fetch where each has a storage of its own', () => {
  afterEach(() => {
    restore();
  });

  it('still lets both graphs patch, as before 16.4', async () => {
    const { nodeRoute, edgeRoute } = await isolate();

    await expect(nodeRoute()).resolves.toBe(true);
    await expect(edgeRoute()).resolves.toBe(true);

    const fetcher = globalThis.fetch as Fetcher;

    // Before 16.4 each finds only its own graph's store, so the two compose (`fetch-patch.test.ts`).
    expect(fetcher.graph).toBe('edge');
    expect((fetcher.wrapped as Fetcher).graph).toBe('app');
  });
});
