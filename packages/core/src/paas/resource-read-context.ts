import { currentNextWorkStores } from './next-cache-registry.ts';

export interface ResourcePrimaryReadStorage {
  getStore(): true | undefined;
  run<T>(value: true, work: () => T): T;
}

const PRIMARY_READ_KEY = Symbol.for('upwind.resource-primary-reads@1');
const PRIMARY_STORE_KEY = Symbol.for('upwind.resource-primary-store@1');
const PRIMARY_STORES_KEY = Symbol.for('upwind.resource-primary-stores@1');
const primaryGlobal = globalThis as typeof globalThis & {
  [PRIMARY_READ_KEY]?: ResourcePrimaryReadStorage;
  [PRIMARY_STORE_KEY]?: <T extends object>(store: T) => T;
  [PRIMARY_STORES_KEY]?: WeakSet<object>;
};
const primaryStores = (primaryGlobal[PRIMARY_STORES_KEY] ??= new WeakSet<object>());

/** Supplied by the host; the contract itself requires neither Node nor another Next store. */
export function installResourcePrimaryReadStorage(storage: ResourcePrimaryReadStorage): void {
  primaryGlobal[PRIMARY_READ_KEY] ??= storage;
  primaryGlobal[PRIMARY_STORE_KEY] ??= <T extends object>(store: T): T => {
    if (readsPrimary()) primaryStores.add(store);
    return store;
  };
}

/** Next's clean snapshot restores its own work store but intentionally drops ambient ALS. */
export function readsPrimary(): boolean {
  return (
    primaryGlobal[PRIMARY_READ_KEY]?.getStore() === true ||
    currentNextWorkStores().some((store) => primaryStores.has(store))
  );
}

/** Internal regeneration scope; synchronous work and promises retain the same primary-read flag. */
export function withPrimaryResourceReads<T>(work: () => T): T {
  const storage = primaryGlobal[PRIMARY_READ_KEY];
  if (storage === undefined)
    throw new Error('Upwind primary resource read context is not installed');
  return storage.run(true, work);
}
