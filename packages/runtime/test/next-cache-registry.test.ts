import { AsyncLocalStorage } from 'node:async_hooks';

import { describe, expect, it, vi } from 'vitest';

import {
  currentNextWorkStores,
  installNextCacheRegistry,
  type NextCacheStore,
  type NextRevalidationProvider,
  type NextStorage,
  type NextWorkStore,
  revalidateNextResource,
  tagNextCacheRead,
} from '../../core/src/paas/next-cache-registry.ts';

describe('next resource cache registry', () => {
  it('upgrades a previously installed registry and storage hook before tracking legacy ancestors', () => {
    const hooks = globalThis as Record<symbol, unknown>;
    const stateKey = Symbol.for('upwind.next-cache-registry@1');
    const hookKey = Symbol.for('upwind.next-cache-storage@1');
    const previousState = hooks[stateKey];
    const previousHook = hooks[hookKey];
    const older = { units: new Set<NextStorage<NextCacheStore>>(), revalidation: new Map() };
    hooks[stateKey] = older;
    hooks[hookKey] = (storage: NextStorage<NextCacheStore>) => {
      older.units.add(storage);
      return storage;
    };
    try {
      installNextCacheRegistry();
      const unit = new AsyncLocalStorage<NextCacheStore>();
      const store: NextCacheStore = { type: 'cache' };
      const register = hooks[hookKey] as (
        storage: NextStorage<NextCacheStore>,
        store: NextCacheStore,
        parent: NextCacheStore,
      ) => void;
      register(unit, store, { type: 'unstable-cache' });

      expect(() => {
        unit.run(store, () => {
          tagNextCacheRead('upwind:publication:v1:protected');
        });
      }).toThrow('unstable_cache cannot preserve publication dependencies.');
      expect(older.units.has(unit)).toBe(true);
    } finally {
      if (previousState === undefined) Reflect.deleteProperty(hooks, stateKey);
      else hooks[stateKey] = previousState;
      if (previousHook === undefined) Reflect.deleteProperty(hooks, hookKey);
      else hooks[hookKey] = previousHook;
    }
  });

  it('ignores older and malformed providers without poisoning current revalidation', () => {
    installNextCacheRegistry();
    const register = (globalThis as Record<symbol, unknown>)[
      Symbol.for('upwind.next-revalidation@1')
    ] as (provider: unknown) => void;
    const oldWorkStore = vi.fn();
    const oldUnitStore = vi.fn();
    const oldRevalidate = vi.fn();
    const workStorage = new AsyncLocalStorage<NextWorkStore>();
    const unitStorage = new AsyncLocalStorage<NextCacheStore>();
    const native = vi.fn();
    register({ workStorage, unitStorage, revalidateTag: native });
    for (let fill = 0; fill < 1000; fill += 1) {
      register({ workStore: oldWorkStore, unitStore: oldUnitStore, revalidateTag: oldRevalidate });
    }
    register({ workStorage, unitStorage: {} });
    register({ workStorage: {}, unitStorage });
    register(null);
    const store: NextWorkStore = { incrementalCache: {} };
    workStorage.run(store, () => {
      expect(currentNextWorkStores()).toStrictEqual([store]);

      unitStorage.run({ type: 'request', phase: 'action' }, () => {
        expect(revalidateNextResource('upwind:resource:d1:default')).toBe(true);
      });
    });

    expect(native).toHaveBeenCalledExactlyOnceWith('upwind:resource:d1:default', 'max');
    expect(oldWorkStore).not.toHaveBeenCalled();
    expect(oldUnitStore).not.toHaveBeenCalled();
    expect(oldRevalidate).not.toHaveBeenCalled();
  });

  it('retains one provider per exact storage pair across recurring fills and preserves the native provider', () => {
    installNextCacheRegistry();
    const work = new AsyncLocalStorage<NextWorkStore>();
    const unit = new AsyncLocalStorage<NextCacheStore>();
    const workStorage = { getStore: vi.fn(() => work.getStore()) };
    const unitStorage = { getStore: vi.fn(() => unit.getStore()) };
    const hooks = globalThis as Record<symbol, unknown>;
    const register = hooks[Symbol.for('upwind.next-revalidation@1')] as (
      provider: NextRevalidationProvider,
    ) => void;
    const native = vi.fn();
    register({ workStorage, unitStorage });
    register({ workStorage, unitStorage, revalidateTag: native });
    for (let fill = 0; fill < 1000; fill += 1) {
      register({ workStorage, unitStorage });
    }
    const store: NextWorkStore = { incrementalCache: {} };
    work.run(store, () => {
      expect(currentNextWorkStores()).toStrictEqual([store]);
      expect(workStorage.getStore).toHaveBeenCalledExactlyOnceWith();

      workStorage.getStore.mockClear();
      unit.run({ type: 'request', phase: 'action' }, () => {
        expect(revalidateNextResource('upwind:resource:d1:default')).toBe(true);
      });
    });

    expect(native).toHaveBeenCalledExactlyOnceWith('upwind:resource:d1:default', 'max');
    expect(workStorage.getStore).toHaveBeenCalledExactlyOnceWith();
    expect(unitStorage.getStore).toHaveBeenCalledExactlyOnceWith();
  });

  it('retains a native provider whose function is not enumerable', () => {
    installNextCacheRegistry();
    const workStorage = new AsyncLocalStorage<NextWorkStore>();
    const unitStorage = new AsyncLocalStorage<NextCacheStore>();
    const native = vi.fn();
    const register = (globalThis as Record<symbol, unknown>)[
      Symbol.for('upwind.next-revalidation@1')
    ] as (provider: unknown) => void;
    register(
      Object.defineProperty({ workStorage, unitStorage }, 'revalidateTag', { value: native }),
    );
    const store: NextWorkStore = { incrementalCache: {} };
    workStorage.run(store, () => {
      unitStorage.run({ type: 'request', phase: 'action' }, () => {
        expect(revalidateNextResource('upwind:resource:d1:default')).toBe(true);
      });
    });

    expect(native).toHaveBeenCalledExactlyOnceWith('upwind:resource:d1:default', 'max');
    expect(store.pendingRevalidatedTags).toBeUndefined();
  });

  it('retains the automatic dependency after 128 existing tags, since Next limits each cacheTag call', () => {
    installNextCacheRegistry();
    const unit = new AsyncLocalStorage<NextCacheStore>();
    const register = (globalThis as Record<symbol, unknown>)[
      Symbol.for('upwind.next-cache-storage@1')
    ] as <T extends NextStorage<NextCacheStore>>(storage: T) => T;
    register(unit);
    const tags = Array.from({ length: 128 }, (_value, index) => `tag-${index}`);
    unit.run({ type: 'cache', tags }, () => {
      tagNextCacheRead('upwind:resource:d1:default');
      tagNextCacheRead('upwind:resource:d1:default');
    });

    expect(tags).toHaveLength(129);
    expect(tags.at(-1)).toBe('upwind:resource:d1:default');
  });
});
