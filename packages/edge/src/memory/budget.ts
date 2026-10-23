/**
 * One byte budget for everything an isolate holds that can be large — the shells, the delivery
 * records and the manifests (`caches.ts`) — rather than one budget each.
 *
 * Separate budgets add up: each was sized for its own worst case, and an isolate that met all three
 * at once held their sum, which came close enough to the isolate's memory limit that the bodies in
 * flight beside them could cross it. Crossing it resets the isolate, and every site it served loses
 * everything it held. One total cannot be exceeded that way, and what is kept under it is whatever
 * was used last, whichever cache it belongs to: a busy site's records push out an idle site's
 * shells, where separate budgets would have kept both at half.
 */

/** What the budget takes an entry back from when it needs the room. */
interface Holder {
  /** Forget the entry: the budget has already let go of it. */
  forget(slot: Slot): void;
}

/** One entry of one cache, as the budget holds it: where it lives, and what it is charged. */
interface Slot {
  readonly holder: Holder;
  readonly key: string;
  readonly bytes: number;
}

export class IsolateBudget {
  readonly #maxBytes: number;
  readonly #maxEntryBytes: number;
  /** Every entry held against the budget, least recently used first. */
  readonly #slots = new Set<Slot>();
  #usedBytes = 0;

  /**
   * `maxEntryBytes` is the most one entry may be charged. An entry is held only by pushing out
   * others, and without a ceiling one large record could push out every other site's shells and
   * manifests at once.
   */
  constructor(maxBytes: number, maxEntryBytes: number = maxBytes) {
    this.#maxBytes = maxBytes;
    this.#maxEntryBytes = Math.min(maxEntryBytes, maxBytes);
  }

  /**
   * Whether an entry charged `bytes` may be held at all: under the most one entry may be, or under
   * `ceiling` for a cache that sets its own, and never past the whole budget.
   */
  admits(bytes: number, ceiling: number = this.#maxEntryBytes): boolean {
    return bytes <= Math.min(ceiling, this.#maxBytes);
  }

  /** Hold `slot` as the most recently used, and let go of the least recently used until it fits. */
  hold(slot: Slot): void {
    this.#slots.add(slot);
    this.#usedBytes += slot.bytes;
    for (const oldest of this.#slots) {
      if (oldest === slot || this.#usedBytes <= this.#maxBytes) {
        return;
      }
      this.release(oldest);
      oldest.holder.forget(oldest);
    }
  }

  /** Mark `slot` as the most recently used. */
  touch(slot: Slot): void {
    if (this.#slots.delete(slot)) {
      this.#slots.add(slot);
    }
  }

  /** Let go of `slot`; its holder has already forgotten it, or is about to. */
  release(slot: Slot): void {
    if (this.#slots.delete(slot)) {
      this.#usedBytes -= slot.bytes;
    }
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }
}

interface Entry<V> extends Slot {
  readonly value: V;
}

/**
 * What a cache charges an entry, from the value and what its caller measured it at: the measure
 * itself where it is the bytes held, more where the value is held in a form that takes more — a
 * manifest is measured by its JSON and held parsed.
 */
export type Charge<V> = (value: V, bytes: number) => number;

function asMeasured(_value: unknown, bytes: number): number {
  return bytes;
}

/**
 * A cache whose entries are held against an `IsolateBudget`: the least recently used entry goes
 * first, of whichever cache sharing the budget it belongs to.
 */
export class SharedByteLru<V> {
  readonly #budget: IsolateBudget;
  readonly #charge: Charge<V>;
  /** The most one of this cache's entries may be charged, when not the budget's own ceiling. */
  readonly #maxEntryBytes: number | undefined;
  readonly #entries = new Map<string, Entry<V>>();
  readonly #holder: Holder = {
    forget: (slot) => {
      this.#forget(slot);
    },
  };
  #usedBytes = 0;

  constructor(budget: IsolateBudget, charge: Charge<V> = asMeasured, maxEntryBytes?: number) {
    this.#budget = budget;
    this.#charge = charge;
    this.#maxEntryBytes = maxEntryBytes;
  }

  /**
   * Forget an entry the budget let go of, or is letting go of. Its key holds no other: `set` lets go
   * of what the key held before it holds anything new under it.
   */
  #forget(slot: Slot): void {
    if (this.#entries.delete(slot.key)) {
      this.#usedBytes -= slot.bytes;
    }
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.#budget.touch(entry);
    return entry.value;
  }

  /**
   * Hold `value`, measured at `bytes`, and say whether it is held. Whatever was held under `key`
   * goes either way: a value too large to hold replaces the one before it with nothing, rather than
   * leaving that one to be served in its place.
   */
  set(key: string, value: V, bytes: number): boolean {
    this.delete(key);
    const charged = Math.ceil(this.#charge(value, bytes));
    if (!this.#budget.admits(charged, this.#maxEntryBytes)) {
      return false;
    }
    const entry: Entry<V> = { holder: this.#holder, key, value, bytes: charged };
    this.#entries.set(key, entry);
    this.#usedBytes += charged;
    this.#budget.hold(entry);
    return true;
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return;
    }
    this.#budget.release(entry);
    this.#forget(entry);
  }

  /**
   * What this cache holds, without using any of it: no entry is touched, so walking them moves none
   * of them in the budget's order. What is let go of meanwhile is not walked to.
   */
  *values(): Generator<V, void, undefined> {
    for (const entry of this.#entries.values()) {
      yield entry.value;
    }
  }

  /** What this cache's entries are charged, together. */
  get usedBytes(): number {
    return this.#usedBytes;
  }

  get size(): number {
    return this.#entries.size;
  }
}
