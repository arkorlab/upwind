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
  readonly workStore: () => NextWorkStore | undefined;
  readonly unitStore: () => NextCacheStore | undefined;
  readonly revalidateTag?: (tag: string, profile: 'max') => void;
}

interface Registry {
  readonly units: Set<NextStorage<NextCacheStore>>;
  readonly revalidation: Set<NextRevalidationProvider>;
}

const STATE_KEY = Symbol.for('upwind.next-cache-registry@1');
const globalRegistry = globalThis as typeof globalThis & { [STATE_KEY]?: Registry };

function registry(): Registry {
  return (globalRegistry[STATE_KEY] ??= {
    units: new Set(),
    revalidation: new Set(),
  });
}

/** Installed before the application's module graph, in Node and in the hosted Function. */
export function installNextCacheRegistry(): void {
  const hooks = globalThis as typeof globalThis & Record<symbol, unknown>;
  hooks[Symbol.for(NEXT_CACHE_STORAGE_SYMBOL_KEY)] ??= <T extends NextStorage<NextCacheStore>>(
    storage: T,
  ): T => {
    registry().units.add(storage);
    return storage;
  };
  hooks[Symbol.for(NEXT_REVALIDATION_SYMBOL_KEY)] ??= (
    provider: NextRevalidationProvider,
  ): void => {
    registry().revalidation.add(provider);
  };
}

/** Add the read dependency before Next collects and propagates the cache entry's tags. */
export function tagNextCacheRead(tag: string): void {
  for (const storage of registry().units) {
    const store = storage.getStore();
    if (store?.type === 'cache') {
      const tags = (store.tags ??= []);
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }
}

export function currentNextWorkStores(): NextWorkStore[] {
  const stores = new Set<NextWorkStore>();
  for (const provider of registry().revalidation) {
    const store = provider.workStore();
    if (store !== undefined) stores.add(store);
  }
  return [...stores];
}

/** Enqueue through Next itself only where that public API is permitted. */
export function revalidateNextResource(tag: string): boolean {
  const handled = new Set<NextWorkStore>();
  const providers = [...registry().revalidation];
  // A site's module graph need not import next/cache. Prefer the real exported function when
  // present, then use the exact wrapper stores for the single reserved, header-safe ASCII tag.
  for (const provider of providers.toSorted(
    (a, b) => Number(b.revalidateTag !== undefined) - Number(a.revalidateTag !== undefined),
  )) {
    const work = provider.workStore();
    const unit = provider.unitStore();
    if (
      Boolean(work?.incrementalCache) &&
      unit?.type === 'request' &&
      unit.phase === 'action' &&
      work !== undefined &&
      !handled.has(work)
    ) {
      if (provider.revalidateTag !== undefined) {
        provider.revalidateTag(tag, 'max');
      } else if (tag === 'upwind:resource:d1:default') {
        const revalidatedAt = performance.timeOrigin + performance.now();
        const pending = (work.pendingRevalidatedTags ??= []);
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
