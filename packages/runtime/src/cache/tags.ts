import {
  type InvalidationState,
  MAX_TAGS_PER_CALL,
  type Validity,
} from '@stayingupwind/core/cache';
import { Lru } from '@stayingupwind/core/util';

import type { CacheHost } from './host.ts';

/**
 * What this isolate knows of the scope's invalidations: the tags the host has recorded an
 * invalidation against, synced from its delta at most once per hold window, and the ones this
 * Function itself invalidated, applied at once. A data-cache read judges its entry against both
 * (an entry made before a tag's `staleAt` is stale, and expired once the `hardExpireAt` that same
 * invalidation set has arrived), so an invalidation is honoured here without waiting for the
 * delivery record.
 */

/**
 * What this view asks of the host, and no more: the scope's delta, and the state of named tags.
 * Named so the two calls it makes are the two a reader has to account for.
 */
export type TagHost = Pick<CacheHost, 'getTags' | 'tagsDelta'>;

export interface TagMark {
  readonly staleAt: number;
  readonly hardExpireAt: number | null;
}

export interface TagStateOptions {
  /** How long a synced view is trusted before the delta is asked for again. */
  readonly holdMs: number;
  readonly log?: ((message: string, detail: string) => void) | undefined;
}

/**
 * How many tags this isolate keeps what the host told it about.
 *
 * A mark and the `checkedAt` beside it are kept under one bound, and that is the point: the mark
 * says a tag was invalidated, `checkedAt` says the host was asked about it lately and need not be
 * asked again within the hold. Bounded apart, a mark could be dropped while its `checkedAt` stood,
 * and `validityOf` would then call a stale entry fresh with no read left to correct it. Dropped
 * together, the next read of a key asks the host about its tags again — `syncLocal` runs ahead of
 * every judgement a data cache makes — and learns the same thing over.
 *
 * Unbounded was the state before: an application that invalidates by `product-<id>` handed this
 * isolate one entry per id it ever saw, kept for as long as the isolate lived.
 *
 * What a mark forgotten here costs `currentGeneration`, which does not re-read, is the one thing
 * this bound gives up, and it is deliberate: a mark of *another* isolate's invalidation reaches
 * the record itself — the host rewrites what the invalidation touched — and the record is what
 * that judgement is about. The delta only ever told it sooner. Waiting for the record is the lag
 * its own read already has (its `cacheTtl`, and the hold on `recordMemo`);
 * asking the host again before judging would put a round trip on the path a Function answers a
 * document from, which is the one thing that may not get slower. What may not wait is this
 * isolate's own invalidation, and that is `MAX_APPLIED_MARKS`.
 */
const MAX_TAGS_HELD = 4096;

/**
 * How many tags this isolate keeps its *own* invalidations for, in a bound of their own.
 *
 * Not every reader re-reads. `currentGeneration` judges a delivery record it has just read against
 * this view and asks the host nothing more (`cache/current.ts`), because the record travels
 * through KV and may say nothing yet of what this Function invalidated a moment ago — which is the
 * whole reason `applyLocal` exists. A mark of that kind dropped from the synced bound would leave
 * that judgement calling the record fresh, and nothing would correct it until the record itself
 * caught up.
 *
 * So the marks this Function made are held apart from the ones it was told, and only what it made
 * itself can push them out: an application would have to invalidate this many distinct tags in one
 * isolate, by when the oldest are long since in the records. Read together (`#markOf`), the
 * stronger of the two wins.
 */
const MAX_APPLIED_MARKS = 4096;

/** What this isolate knows of one tag: its latest invalidation, and when the host last said so. */
interface TagKnowledge {
  readonly mark?: TagMark | undefined;
  readonly checkedAt?: number | undefined;
}

export class TagState {
  readonly #tags = new Lru<string, TagKnowledge>(MAX_TAGS_HELD);
  readonly #applied = new Lru<string, TagMark>(MAX_APPLIED_MARKS);
  readonly #holdMs: number;
  readonly #log: TagStateOptions['log'];
  readonly #localReads = new Map<string, Promise<void>>();
  #revision = 0;
  #syncedAt: number | undefined;
  #inflight: Promise<void> | undefined;

  constructor(options: TagStateOptions) {
    this.#holdMs = options.holdMs;
    this.#log = options.log;
  }

  async #pull(host: TagHost, now: number): Promise<void> {
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

  /** What the host said of a tag, kept whole beside what was already known of it. */
  #mark(value: string, mark: TagMark): void {
    const known = this.#tags.get(value);
    const held = known?.mark;
    this.#tags.set(value, { ...known, mark: held === undefined ? mark : stronger(held, mark) });
  }

  async #pullLocal(host: TagHost, values: readonly string[], now: number): Promise<void> {
    try {
      const result = await host.getTags(values);
      for (const tag of result.tags) {
        this.#mark(tag.value, { staleAt: tag.staleAt, hardExpireAt: tag.hardExpireAt });
      }
      // Every tag asked about, not only the ones the host had something to say about: the answer
      // that a tag has no invalidation is worth the same hold as the answer that it has one.
      //
      // The two loops are one turn: there is no `await` between them, so no other read can evict
      // what the first just marked before the second reads it back. A second read of this key
      // would find the mark even if one could — it is read and written together.
      for (const value of values) {
        this.#tags.set(value, { ...this.#tags.get(value), checkedAt: now });
      }
    } finally {
      for (const value of values) this.#localReads.delete(value);
    }
  }

  /**
   * What this isolate knows of a tag: what it was told, and what it did itself, the stronger of
   * the two. The second is kept apart because it is the only one no read brings back — see
   * `MAX_APPLIED_MARKS`.
   */
  #markOf(value: string): TagMark | undefined {
    const synced = this.#tags.get(value)?.mark;
    const applied = this.#applied.get(value);
    if (synced === undefined || applied === undefined) {
      return synced ?? applied;
    }
    return stronger(synced, applied);
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
  async sync(host: TagHost, now: number, options: { force?: boolean } = {}): Promise<void> {
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

  /**
   * Check only the tags a read uses, through KV in the caller's region.
   *
   * Every judgement a data cache makes runs after this — `getUseCache`, the fetch cache's `get`
   * and `getExpiration` all sync the very tags they are about to weigh — which is what lets the
   * synced view be bounded: a tag this isolate has forgotten is one it asks about again here.
   * `currentGeneration` is the reader that does not, and `MAX_APPLIED_MARKS` is why it need not.
   */
  async syncLocal(host: TagHost, values: readonly string[], now: number): Promise<void> {
    const needed = [...new Set(values)].filter((value) => {
      const checked = this.#tags.get(value)?.checkedAt;
      return checked === undefined || now - checked >= this.#holdMs;
    });
    const waiting = new Set<Promise<void>>();
    const unread: string[] = [];
    for (const value of needed) {
      const pending = this.#localReads.get(value);
      if (pending === undefined) unread.push(value);
      else waiting.add(pending);
    }
    for (let offset = 0; offset < unread.length; offset += MAX_TAGS_PER_CALL) {
      const batch = unread.slice(offset, offset + MAX_TAGS_PER_CALL);
      const read = this.#pullLocal(host, batch, now);
      for (const value of batch) this.#localReads.set(value, read);
      waiting.add(read);
    }
    await Promise.all(waiting);
  }

  /** An invalidation this Function just recorded: in force here before the delta says so. */
  applyLocal(values: readonly string[], mark: TagMark): void {
    for (const value of values) {
      const held = this.#applied.get(value);
      this.#applied.set(value, held === undefined ? mark : stronger(held, mark));
    }
  }

  /**
   * The state of an entry made at `timestamp` under these tags, judged at `now`.
   *
   * An invalidation reaches the entries made before it and no others, so that is the one question
   * asked of each tag; an entry it reached is stale from then, and past the deadline the
   * invalidation set it may not be served at all.
   *
   * An entry made in the same millisecond as the invalidation counts as made before it. A Function's
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
      const mark = this.#markOf(tag);
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
      latest = Math.max(latest, this.#markOf(tag)?.staleAt ?? 0);
    }
    return latest;
  }
}

/**
 * The two marks a tag can have as one: the later invalidation, since a host keeps only the latest
 * and that is what an isolate starting now would hold. Keeping the later `staleAt` beside the
 * earlier `hardExpireAt` would make a window nobody opened, and would make this isolate judge an
 * entry differently from the one next to it; two recorded in the same millisecond are settled by
 * the earlier deadline.
 */
function stronger(a: TagMark, b: TagMark): TagMark {
  if (a.staleAt !== b.staleAt) {
    return a.staleAt > b.staleAt ? a : b;
  }
  return { staleAt: a.staleAt, hardExpireAt: earliest(a.hardExpireAt, b.hardExpireAt) };
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
