/** Small in-memory caches used by the edge Worker (per isolate) and by tests. */

interface ByteLruEntry<V> {
  readonly value: V;
  readonly bytes: number;
}

/** Least-recently-used cache bounded by a byte budget rather than an entry count. */
export class ByteLru<K, V> {
  readonly #maxBytes: number;
  readonly #entries = new Map<K, ByteLruEntry<V>>();
  #usedBytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  #evict(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#usedBytes <= this.#maxBytes) {
        return;
      }
      this.#entries.delete(key);
      this.#usedBytes -= entry.bytes;
    }
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, bytes: number): void {
    if (bytes > this.#maxBytes) {
      return;
    }
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#usedBytes -= existing.bytes;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { value, bytes });
    this.#usedBytes += bytes;
    this.#evict();
  }

  delete(key: K): void {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#usedBytes -= existing.bytes;
      this.#entries.delete(key);
    }
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  get size(): number {
    return this.#entries.size;
  }
}

interface TtlEntry<V> {
  readonly value: V;
  readonly expiresAt: number;
  readonly bytes: number;
}

interface ByteBudget<K, V> {
  readonly maxBytes: number;
  readonly sizeOf: (value: V, key: K) => number;
}

/** An isolate hit, including one whose TTL has elapsed and may be served while KV refreshes. */
export interface TtlPeek<V> {
  readonly value: V;
  readonly stale: boolean;
}

/** Fixed-TTL cache bounded by entry count and an optional byte budget, with LRU eviction. */
export class TtlCache<K, V> {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<K, TtlEntry<V>>();
  readonly #budget: ByteBudget<K, V> | undefined;
  #usedBytes = 0;

  constructor(
    ttlMs: number,
    maxEntries: number,
    now: () => number = () => Date.now(),
    budget?: ByteBudget<K, V>,
  ) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
    this.#budget = budget;
  }

  get(key: K): V | undefined {
    const hit = this.peek(key);
    if (hit === undefined || hit.stale) {
      if (hit?.stale === true) {
        this.delete(key);
      }
      return undefined;
    }
    return hit.value;
  }

  /**
   * The stored value even after its TTL, without dropping it.
   *
   * `get` treats expiry as a miss so a caller that must not serve stale data still goes to KV.
   * A first-byte path that already has the bytes can `peek` and refresh in the background.
   */
  peek(key: K): TtlPeek<V> | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    const stale = entry.expiresAt <= this.#now();
    if (!stale) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return { value: entry.value, stale };
  }

  set(key: K, value: V, ttlMs = this.#ttlMs): void {
    this.delete(key);
    const bytes = this.#budget?.sizeOf(value, key) ?? 0;
    const maxBytes = this.#budget?.maxBytes ?? Infinity;
    if (bytes > maxBytes) {
      return;
    }
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs, bytes });
    this.#usedBytes += bytes;
    while (this.#entries.size > this.#maxEntries || this.#usedBytes > maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.#usedBytes -= this.#entries.get(key)?.bytes ?? 0;
    this.#entries.delete(key);
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  get size(): number {
    return this.#entries.size;
  }
}
