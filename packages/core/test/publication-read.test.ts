import { describe, expect, it } from 'vitest';

import {
  installNextCacheRegistry,
  NEXT_CACHE_STORAGE_SYMBOL_KEY,
  type NextCacheStore,
  type NextStorage,
} from '../src/paas/next-cache-registry.ts';
import { beginPublicationRead } from '../src/paas/publication-read.ts';
import { observePublicationTags } from '../src/paas/publication.ts';

/** The registry only reads a synchronous current store; an inactive fixture leaves no scope. */
function inStore(type: string, body: (store: NextCacheStore) => void): void {
  installNextCacheRegistry();
  const store: NextCacheStore = { type };
  let active: NextCacheStore | undefined = store;
  const storage: NextStorage<NextCacheStore> = { getStore: () => active };
  const register = Reflect.get(globalThis, Symbol.for(NEXT_CACHE_STORAGE_SYMBOL_KEY)) as (
    storage: NextStorage<NextCacheStore>,
  ) => void;
  register(storage);
  try {
    body(store);
  } finally {
    active = undefined;
  }
}

describe('publication read hints in shared caches', () => {
  it('retains a public producer grant after a read begins inside use cache', () => {
    const tag = `upwind:publication:v1:${'a'.repeat(64)}:60000`;
    inStore('cache', (store) => {
      beginPublicationRead();
      observePublicationTags([tag]);

      expect(store.tags).toStrictEqual([tag]);
    });
  });

  it('still refuses unsupported unstable_cache proof after its read hint', () => {
    inStore('unstable-cache', () => {
      beginPublicationRead();

      expect(() => {
        observePublicationTags([`upwind:publication:v1:${'a'.repeat(64)}:60000`]);
      }).toThrow('unstable_cache cannot preserve publication dependencies.');
    });
  });
});
