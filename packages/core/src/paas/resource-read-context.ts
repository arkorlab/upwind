import { currentNextWorkStores, type NextWorkStore } from './next-cache-registry.ts';

export interface ResourcePrimaryReadStorage {
  getStore(): true | undefined;
  run<T>(value: true, work: () => T): T;
}

const PRIMARY_READ_KEY = Symbol.for('upwind.resource-primary-reads@1');
const PRIMARY_STORE_KEY = Symbol.for('upwind.resource-primary-store@1');
const PRIMARY_STORES_KEY = Symbol.for('upwind.resource-primary-stores@1');
interface PrimaryReadHolder {
  [PRIMARY_READ_KEY]?: ResourcePrimaryReadStorage;
  [PRIMARY_STORE_KEY]?: (store: NextWorkStore) => NextWorkStore;
  [PRIMARY_STORES_KEY]?: WeakSet<NextWorkStore>;
}

function holder(): PrimaryReadHolder {
  return globalThis as unknown as PrimaryReadHolder;
}

function stores(): WeakSet<NextWorkStore> {
  const held = holder()[PRIMARY_STORES_KEY];
  if (held !== undefined) return held;
  const created = new WeakSet<NextWorkStore>();
  holder()[PRIMARY_STORES_KEY] = created;
  return created;
}

const primaryStores = stores();

/** Supplied by the host; the contract itself requires neither Node nor another Next store. */
export function installResourcePrimaryReadStorage(storage: ResourcePrimaryReadStorage): void {
  const existing = holder()[PRIMARY_READ_KEY];
  if (existing === undefined) {
    holder()[PRIMARY_READ_KEY] = storage;
  }
  const capture = holder()[PRIMARY_STORE_KEY];
  if (capture !== undefined) return;
  holder()[PRIMARY_STORE_KEY] = (store: NextWorkStore): NextWorkStore => {
    if (readsPrimary()) primaryStores.add(store);
    return store;
  };
}

/** Next's clean snapshot restores its own work store but intentionally drops ambient ALS. */
export function readsPrimary(): boolean {
  const storage = holder()[PRIMARY_READ_KEY];
  return (
    storage?.getStore() === true ||
    currentNextWorkStores().some((store) => primaryStores.has(store))
  );
}

/** Internal regeneration scope; synchronous work and promises retain the same primary-read flag. */
export function withPrimaryResourceReads<T>(work: () => T): T {
  const storage = holder()[PRIMARY_READ_KEY];
  if (storage === undefined)
    throw new Error('Upwind primary resource read context is not installed');
  return storage.run(true, work);
}
