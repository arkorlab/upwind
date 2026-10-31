/** The adapter registers the actual Next.js async stores, rather than importing another copy. */
export const NEXT_CACHE_STORAGE_SYMBOL_KEY = 'upwind.next-cache-storage@1';
export const NEXT_REVALIDATION_SYMBOL_KEY = 'upwind.next-revalidation@1';

export interface NextCacheStore {
  readonly type: string;
  readonly phase?: string;
  tags?: string[] | null;
}

export interface NextWorkStore {
  readonly incrementalCache?: unknown;
  pendingRevalidatedTags?: { tag: string; profile: string; revalidatedAt?: number }[];
}

export interface NextStorage<T> {
  getStore(): T | undefined;
}

export interface NextRevalidationProvider {
  readonly workStorage: NextStorage<NextWorkStore>;
  readonly unitStorage: NextStorage<NextCacheStore>;
  readonly revalidateTag?: (tag: string, profile: 'max') => void;
}

interface Registry {
  readonly units: Set<NextStorage<NextCacheStore>>;
  readonly legacyAncestors: WeakSet<NextCacheStore>;
  readonly revalidation: Map<
    NextStorage<NextWorkStore>,
    Map<NextStorage<NextCacheStore>, NextRevalidationProvider>
  >;
}

const LEGACY_CACHE = 'unstable-cache';
const STATE_KEY = Symbol.for('upwind.next-cache-registry@1');
interface RegistryHolder {
  [STATE_KEY]?: Registry;
}

function holder(): RegistryHolder {
  return globalThis as unknown as RegistryHolder;
}

function registry(): Registry {
  const held = holder()[STATE_KEY];
  if (held !== undefined) return held;
  const created: Registry = {
    units: new Set(),
    legacyAncestors: new WeakSet(),
    revalidation: new Map(),
  };
  holder()[STATE_KEY] = created;
  return created;
}

/** Installed before the application's module graph, in Node and in the hosted Function. */
export function installNextCacheRegistry(): void {
  const hooks = globalThis as Record<symbol, unknown>;
  hooks[Symbol.for(NEXT_CACHE_STORAGE_SYMBOL_KEY)] ??= <T extends NextStorage<NextCacheStore>>(
    storage: T,
    store?: NextCacheStore,
    parent?: NextCacheStore,
  ): T => {
    const state = registry();
    state.units.add(storage);
    if (
      store !== undefined &&
      parent !== undefined &&
      (parent.type === LEGACY_CACHE || state.legacyAncestors.has(parent))
    )
      state.legacyAncestors.add(store);
    return storage;
  };
  hooks[Symbol.for(NEXT_REVALIDATION_SYMBOL_KEY)] ??= (
    provider: Partial<NextRevalidationProvider> | null | undefined,
  ): void => {
    // Older bridge output uses getter callbacks rather than the exact storage objects.
    // It can share this hook, but cannot participate in storage-identity deduplication.
    // Ignore incompatible registrations before they can poison a current provider's lookup.
    const workStorage = provider?.workStorage;
    const unitStorage = provider?.unitStorage;
    if (
      typeof workStorage?.getStore !== 'function' ||
      typeof unitStorage?.getStore !== 'function'
    ) {
      return;
    }
    const revalidateTag = provider?.revalidateTag;
    const registered = registry().revalidation;
    let units = registered.get(workStorage);
    if (units === undefined) {
      units = new Map();
      registered.set(workStorage, units);
    }
    const existing = units.get(unitStorage);
    // Earlier Next wrappers declare the fill function inside another function. Their hook
    // executes per fill, so provider object identity is not stable; the exact stores are.
    if (existing === undefined || revalidateTag !== undefined) {
      units.set(unitStorage, {
        workStorage,
        unitStorage,
        ...(revalidateTag !== undefined && { revalidateTag }),
      });
    }
  };
}

function sharedStore(store: NextCacheStore | undefined): boolean {
  return store?.type === 'cache' || store?.type === LEGACY_CACHE;
}

/** Add the read dependency before Next collects and propagates the cache entry's tags. */
export function tagNextCacheRead(tag: string): void {
  for (const storage of registry().units) {
    const store = storage.getStore();
    // Next persists unstable_cache's original options.tags, not tags observed during its callback.
    if (
      store !== undefined &&
      (store.type === LEGACY_CACHE || registry().legacyAncestors.has(store)) &&
      (tag.startsWith('upwind:publication:') || tag.startsWith('upwind:resource-snapshot:'))
    )
      throw new Error('unstable_cache cannot preserve publication dependencies.');
    if (store !== undefined && sharedStore(store)) {
      store.tags ??= [];
      const tags = store.tags;
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }
}

/** Private authority results may use a request/private cache, never a shared component cache. */
export function inPublicNextCache(): boolean {
  return [...registry().units].some((storage) => sharedStore(storage.getStore()));
}

export function currentNextWorkStores(): NextWorkStore[] {
  const stores = new Set<NextWorkStore>();
  for (const storage of registry().revalidation.keys()) {
    const store = storage.getStore();
    if (store !== undefined) stores.add(store);
  }
  return [...stores];
}

/** Enqueue through Next itself only where that public API is permitted. */
export function revalidateNextResource(tag: string): boolean {
  const handled = new Set<NextWorkStore>();
  const providers = [...registry().revalidation.values()].flatMap((units) => [...units.values()]);
  // A site's module graph need not import next/cache. Prefer the real exported function when
  // present, then use the exact wrapper stores for the single reserved, header-safe ASCII tag.
  const ordered = providers.toSorted(
    (a, b) => Number(b.revalidateTag !== undefined) - Number(a.revalidateTag !== undefined),
  );
  for (const provider of ordered) {
    const work = provider.workStorage.getStore();
    const unit = provider.unitStorage.getStore();
    if (
      work !== undefined &&
      Boolean(work.incrementalCache) &&
      unit?.type === 'request' &&
      unit.phase === 'action' &&
      !handled.has(work)
    ) {
      if (provider.revalidateTag !== undefined) {
        provider.revalidateTag(tag, 'max');
      } else if (tag === 'upwind:resource:d1:default') {
        const revalidatedAt = performance.timeOrigin + performance.now();
        work.pendingRevalidatedTags ??= [];
        const pending = work.pendingRevalidatedTags;
        const existing = pending.find((item) => item.tag === tag && item.profile === 'max');
        if (existing === undefined) {
          pending.push({ tag, profile: 'max', revalidatedAt });
        } else {
          existing.revalidatedAt = revalidatedAt;
        }
        // This is the stable SWR part of Next 16.2–16.4's revalidateTag implementation. The
        // timestamp is used by 16.4 and ignored by earlier releases. SWR leaves
        // pathWasRevalidated untouched, so it does not flush the browser router cache.
      } else {
        continue;
      }
      handled.add(work);
    }
  }
  return handled.size > 0;
}
