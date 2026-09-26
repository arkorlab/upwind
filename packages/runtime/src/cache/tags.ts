import { MAX_TAGS_PER_ENTRY, type InvalidationState, type Validity } from '@upwind/core/cache';

import type { CacheHost } from './host.ts';

/**
 * What this isolate knows of the scope's invalidations: the tags the host has recorded an
 * invalidation against, synced from its delta at most once per hold window, and the ones this
 * Worker itself invalidated, applied at once. A data-cache read judges its entry against both
 * (an entry made before a tag's `staleAt` is stale, and expired once the `hardExpireAt` that same
 * invalidation set has arrived), so an invalidation is honoured here without waiting for the
 * delivery record.
 */

export interface TagMark {
  readonly staleAt: number;
  readonly hardExpireAt: number | null;
}

export interface TagStateOptions {
  /** How long a synced view is trusted before the delta is asked for again. */
  readonly holdMs: number;
  readonly log?: ((message: string, detail: string) => void) | undefined;
}

const MAX_LOCAL_CHECKS = 4096;

export class TagState {
  readonly #marks = new Map<string, TagMark>();
  readonly #holdMs: number;
  readonly #log: TagStateOptions['log'];
  readonly #localChecked = new Map<string, number>();
  readonly #localReads = new Map<string, Promise<void>>();
  #revision = 0;
  #syncedAt: number | undefined;
  #inflight: Promise<void> | undefined;

  constructor(options: TagStateOptions) {
    this.#holdMs = options.holdMs;
    this.#log = options.log;
  }

  async #pull(host: CacheHost, now: number): Promise<void> {
    try {
      let truncated = true;
      while (truncated) {
        const delta = await host.tagsDelta(this.#revision);
        for (const tag of delta.tags) {
          this.#mark(tag.value, { staleAt: tag.staleAt, hardExpireAt: tag.hardExpireAt });
        }
        this.#revision = Math.max(this.#revision, delta.revision);
        truncated = delta.truncated;
      }
      this.#syncedAt = now;
    } catch (error) {
      // What is known stays known: a read judged against an older view is a read that may be
      // served stale for one hold, never one that fails.
      this.#log?.('tags not synced', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The tag's latest invalidation, kept whole.
   *
   * A host keeps only the latest one as well — a new one replaces the tag's record, which is
   * what the delta reads — so this is what an isolate that started a moment ago holds. Keeping the
   * later `staleAt` beside the earlier `hardExpireAt` would make a window nobody opened, and would
   * make this isolate judge an entry differently from the one next to it. Two recorded in the same
   * millisecond are settled by the earlier deadline.
   */
  #mark(value: string, mark: TagMark): void {
    const existing = this.#marks.get(value);
    if (existing === undefined || mark.staleAt > existing.staleAt) {
      this.#marks.set(value, mark);
      return;
    }
    if (mark.staleAt === existing.staleAt) {
      this.#marks.set(value, {
        staleAt: existing.staleAt,
        hardExpireAt: earliest(existing.hardExpireAt, mark.hardExpireAt),
      });
    }
  }

  async #pullLocal(host: CacheHost, values: readonly string[], now: number): Promise<void> {
    try {
      const result = await host.getTags(values);
      for (const tag of result.tags) {
        this.#mark(tag.value, { staleAt: tag.staleAt, hardExpireAt: tag.hardExpireAt });
      }
      for (const value of values) {
        this.#localChecked.delete(value);
        this.#localChecked.set(value, now);
      }
      // Negative lookups must not make a high-cardinality app retain every tag it ever saw.
      while (this.#localChecked.size > MAX_LOCAL_CHECKS) {
        const oldest = this.#localChecked.keys().next();
        if (oldest.done === true) break;
        this.#localChecked.delete(oldest.value);
      }
    } finally {
      for (const value of values) this.#localReads.delete(value);
    }
  }

  get revision(): number {
    return this.#revision;
  }

  /**
   * Bring the view up to the host's revision, unless it was brought up within the hold.
   *
   * A regeneration asks for it whatever the hold says (`force`): the revision this view stands at
   * is what the commit tells the host the render was judged against, and the host
   * condemns a generation whose renderer was behind. Within the hold that claim would be older
   * than the render — including on the isolate that just invalidated a tag itself, whose view
   * knows of it but whose revision does not.
   */
  async sync(host: CacheHost, now: number, options: { force?: boolean } = {}): Promise<void> {
    const held = this.#syncedAt !== undefined && now - this.#syncedAt < this.#holdMs;
    if (held && options.force !== true) {
      return;
    }
    // One pull at a time: whoever arrives while it runs waits for the same one.
    this.#inflight ??= this.#pull(host, now);
    try {
      await this.#inflight;
    } finally {
      this.#inflight = undefined;
    }
  }

  /** Check only the tags a read uses, through KV in the caller's region. */
  async syncLocal(host: CacheHost, values: readonly string[], now: number): Promise<void> {
    const needed = [...new Set(values)].filter((value) => {
      const checked = this.#localChecked.get(value);
      return checked === undefined || now - checked >= this.#holdMs;
    });
    const waiting = new Set<Promise<void>>();
    const unread: string[] = [];
    for (const value of needed) {
      const pending = this.#localReads.get(value);
      if (pending === undefined) unread.push(value);
      else waiting.add(pending);
    }
    for (let offset = 0; offset < unread.length; offset += MAX_TAGS_PER_ENTRY) {
      const batch = unread.slice(offset, offset + MAX_TAGS_PER_ENTRY);
      const read = this.#pullLocal(host, batch, now);
      for (const value of batch) this.#localReads.set(value, read);
      waiting.add(read);
    }
    await Promise.all(waiting);
  }

  /** An invalidation this Worker just recorded: in force here before the delta says so. */
  applyLocal(values: readonly string[], mark: TagMark): void {
    for (const value of values) {
      this.#mark(value, mark);
    }
  }

  /**
   * The state of an entry made at `timestamp` under these tags, judged at `now`.
   *
   * An invalidation reaches the entries made before it and no others, so that is the one question
   * asked of each tag; an entry it reached is stale from then, and past the deadline the
   * invalidation set it may not be served at all.
   *
   * An entry made in the same millisecond as the invalidation counts as made before it. A Worker's
   * clock stands still while it computes and moves only when I/O completes, so a write and the
   * `updateTag` that follows it with no I/O between them read the same time — and the render after
   * the update has to miss what the update was for. Next.js settles a tie the same way where it
   * holds an entry against the expiration a handler reports (`shouldDiscardCacheEntry`), which is
   * what `getExpiration` hands it from here; the price of the other kind of tie, a value made just
   * after an invalidation, is one render more.
   */
  validityOf(tags: readonly string[], timestamp: number, now: number): Validity {
    let validity: Validity = 'fresh';
    for (const tag of tags) {
      const mark = this.#marks.get(tag);
      if (mark === undefined || mark.staleAt < timestamp) {
        continue;
      }
      if (mark.hardExpireAt !== null && mark.hardExpireAt <= now) {
        return 'expired';
      }
      validity = 'stale';
    }
    return validity;
  }

  /** The latest moment any of the tags was invalidated; 0 when none was. */
  staleAtOf(tags: readonly string[]): number {
    let latest = 0;
    for (const tag of tags) {
      latest = Math.max(latest, this.#marks.get(tag)?.staleAt ?? 0);
    }
    return latest;
  }
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  return b === null ? a : Math.min(a, b);
}

/** The worse of what the tags say and what the record itself carries. */
export function recordValidity(
  tags: TagState,
  input: {
    readonly tags: readonly string[];
    readonly timestamp: number;
    readonly invalidation?: InvalidationState | undefined;
    readonly now: number;
  },
): Validity {
  const byTags = tags.validityOf(input.tags, input.timestamp, input.now);
  if (byTags === 'expired') {
    return byTags;
  }
  const { invalidation } = input;
  if (invalidation === undefined) {
    return byTags;
  }
  if (invalidation.hardExpireAt !== undefined && invalidation.hardExpireAt <= input.now) {
    return 'expired';
  }
  return byTags === 'fresh' && invalidation.staleAt === undefined ? 'fresh' : 'stale';
}
