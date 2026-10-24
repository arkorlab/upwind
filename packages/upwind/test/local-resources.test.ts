import { AsyncLocalStorage } from 'node:async_hooks';

import { describe, expect, it } from 'vitest';

import { DEFAULT_D1_CACHE_TAG } from '../../core/src/paas/d1-observation.ts';
import {
  type NextCacheStore,
  type NextRevalidationProvider,
  type NextStorage,
  type NextWorkStore,
  NEXT_CACHE_STORAGE_SYMBOL_KEY,
  NEXT_REVALIDATION_SYMBOL_KEY,
} from '../../core/src/paas/next-cache-registry.ts';
import {
  type PublishedResources,
  RESOURCES_MANIFEST_BINDING,
  RESOURCES_SYMBOL_KEY,
} from '../../core/src/paas/resources.ts';
import { publishResources } from '../src/resources/publish.ts';

describe('local D1 publication', () => {
  it('tags local cache reads and enqueues native SWR only for committed action and route-handler writes', async () => {
    let written = false;
    let failed = false;
    let queries = 0;
    const native = {
      prepare: (sql: string) => {
        return {
          all: () => {
            queries += 1;
            return failed
              ? Promise.reject(new Error(`statement failed: ${sql}`))
              : Promise.resolve({ results: [{ id: 1 }], meta: { changed_db: written } });
          },
        };
      },
    };
    publishResources({
      [RESOURCES_MANIFEST_BINDING]: JSON.stringify([{ name: 'DB', type: 'd1' }]),
      DB: native,
    });
    const symbols = globalThis as Record<symbol, unknown>;
    const published = symbols[Symbol.for(RESOURCES_SYMBOL_KEY)] as PublishedResources;
    const database = published.resources['DB']?.binding as typeof native;
    const work = new AsyncLocalStorage<NextWorkStore>();
    const unit = new AsyncLocalStorage<NextCacheStore>();
    const registerStorage = symbols[Symbol.for(NEXT_CACHE_STORAGE_SYMBOL_KEY)] as (
      storage: NextStorage<NextCacheStore>,
    ) => void;
    const registerProvider = symbols[Symbol.for(NEXT_REVALIDATION_SYMBOL_KEY)] as (
      provider: NextRevalidationProvider,
    ) => void;
    registerStorage(unit);
    registerProvider({ workStorage: work, unitStorage: unit });
    const cache: NextCacheStore = { type: 'cache', tags: null };
    await unit.run(cache, () => database.prepare('SELECT id FROM items').all());

    expect(cache.tags).toStrictEqual([DEFAULT_D1_CACHE_TAG]);

    const action: NextWorkStore = { incrementalCache: {} };
    await work.run(action, () => {
      return unit.run({ type: 'request', phase: 'action' }, async () => {
        await database.prepare('SELECT id FROM items').all();

        expect(action.pendingRevalidatedTags).toBeUndefined();

        written = true;
        await database.prepare('UPDATE items SET id=1').all();
      });
    });

    const anyMoment: unknown = expect.any(Number);

    expect(action.pendingRevalidatedTags).toStrictEqual([
      { tag: DEFAULT_D1_CACHE_TAG, profile: 'max', revalidatedAt: anyMoment },
    ]);

    const routeHandler: NextWorkStore = { incrementalCache: {} };
    await work.run(routeHandler, () => {
      return unit.run({ type: 'request', phase: 'action' }, () =>
        database.prepare('INSERT INTO items VALUES (1)').all(),
      );
    });

    expect(routeHandler.pendingRevalidatedTags).toHaveLength(1);

    const rejected: NextWorkStore = { incrementalCache: {} };
    failed = true;

    await expect(
      work.run(rejected, () => {
        return unit.run({ type: 'request', phase: 'action' }, () =>
          database.prepare('INSERT INTO items VALUES (1)').all(),
        );
      }),
    ).rejects.toThrow('statement failed');

    expect(rejected.pendingRevalidatedTags).toBeUndefined();
    expect(queries).toBe(5);

    failed = false;
    const prerender: NextWorkStore = { incrementalCache: {} };
    await work.run(prerender, () => {
      return unit.run({ type: 'prerender', phase: 'render' }, () =>
        database.prepare('INSERT INTO items VALUES (1)').all(),
      );
    });

    expect(prerender.pendingRevalidatedTags).toBeUndefined();
  });
});
