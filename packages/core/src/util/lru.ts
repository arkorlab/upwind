/** Small in-memory caches, one per isolate, used by the edge Function, the runtime and by tests. */

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

  /** What is held, least recently used first, without using any of it. */
  *values(): Generator<V, void, undefined> {
    for (const entry of this.#entries.values()) {
      yield entry.value;
    }
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * Least-recently-used cache bounded by a count of entries, with no expiry of its own.
 *
 * For what is true until something says otherwise, rather than for what goes stale on a clock: the
 * bound is there so an isolate that sees unboundedly many keys does not grow without end, and the
 * caller decides what a missing key means.
 */
export class Lru<K, V> {
  readonly #maxEntries: number;
  readonly #entries = new Map<K, V>();

  constructor(maxEntries: number) {
    this.#maxEntries = maxEntries;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

interface TtlEntry<V> {
  readonly value: V;
  readonly expiresAt: number;
  readonly bytes: number;
  /** What the entry shares with others, where it does (`ByteBudget.sharedOf`). */
  readonly shared?: SharedBytes | undefined;
}

/** Bytes the values of several entries may hold together, and what holds them. */
export interface SharedBytes {
  readonly holder: unknown;
  readonly bytes: number;
}

interface ByteBudget<K, V> {
  readonly maxBytes: number;
  readonly sizeOf: (value: V, key: K) => number;
  /**
   * What a value holds that the values of other entries may hold too, which `sizeOf` leaves out: the
   * entries whose values name one holder — the same one, not an equal one — are charged its bytes
   * once, as the first of them said, from the first of them set until the last of them is gone.
   */
  readonly sharedOf?: ((value: V) => SharedBytes | undefined) | undefined;
}

/** What the entries sharing one holder are charged, once, and how many of them there are. */
interface Shared {
  readonly bytes: number;
  readonly entries: number;
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
  readonly #shared = new Map<unknown, Shared>();
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

  /** Charge an entry set its own bytes, and what it shares only where nothing set holds that yet. */
  #charge(bytes: number, shared: SharedBytes | undefined): void {
    this.#usedBytes += bytes;
    if (shared === undefined) {
      return;
    }
    const held = this.#shared.get(shared.holder);
    this.#shared.set(shared.holder, {
      bytes: held?.bytes ?? shared.bytes,
      entries: (held?.entries ?? 0) + 1,
    });
    if (held === undefined) {
      this.#usedBytes += shared.bytes;
    }
  }

  /** Give back what an entry gone was charged: what it shared, once the last entry sharing it goes. */
  #discharge({ bytes, shared }: TtlEntry<V>): void {
    this.#usedBytes -= bytes;
    if (shared === undefined) {
      return;
    }
    const held = this.#shared.get(shared.holder);
    if (held !== undefined && held.entries > 1) {
      this.#shared.set(shared.holder, { bytes: held.bytes, entries: held.entries - 1 });
      return;
    }
    this.#shared.delete(shared.holder);
    this.#usedBytes -= held?.bytes ?? shared.bytes;
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
    const shared = this.#budget?.sharedOf?.(value);
    const maxBytes = this.#budget?.maxBytes ?? Infinity;
    if (bytes + (shared?.bytes ?? 0) > maxBytes) {
      return;
    }
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs, bytes, shared });
    this.#charge(bytes, shared);
    while (this.#entries.size > this.#maxEntries || this.#usedBytes > maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.delete(oldest.value);
    }
  }

  delete(key: K): void {
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      this.#entries.delete(key);
      this.#discharge(entry);
    }
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  get size(): number {
    return this.#entries.size;
  }
}
