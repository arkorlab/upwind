import {
  type InvalidationState,
  MAX_TAGS_PER_CALL,
  type Validity,
} from '@stayingupwind/core/cache';
import { Lru } from '@stayingupwind/core/util';

import type { CacheHost, InvalidateOutcome } from './host.ts';

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
  /**
   * A revision of the scope the invalidation was recorded at or before, where one is known: the one
   * the host says it recorded it at, or, for a mark the delta brought where it does not say, the
   * revision that page of the delta was read at; for this isolate's own invalidation, the one the
   * host answered it with (`confirmLocal`). What tells a view that held the invalidation from one
   * that did not, whatever the clocks that stamped it said: a view brought up to that revision held
   * it (`validityOf`). Unknown for an invalidation of this isolate's the host has yet to answer.
   */
  readonly revision?: number | undefined;
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

/**
 * What this isolate knows of one tag: its latest invalidation, and when the host last said so —
 * with what tells a view that held what it was told from one that did not (`TagMark.revision`): the
 * latest revision a mark it was told was known at, and the latest moment of one known at none.
 */
interface TagKnowledge {
  readonly mark?: TagMark | undefined;
  readonly checkedAt?: number | undefined;
  readonly knownRevision?: number | undefined;
  readonly unknownAt?: number | undefined;
}

/**
 * This isolate's own invalidations of one tag, all in force here: those the host has answered at a
 * revision of the scope's (`confirmLocal`), with the latest of those revisions; those it has yet to
 * answer, with how many of them are out (`applyLocal`); and those known at no revision for good —
 * the host never answered them, or answered at a revision of another kind (`settleLocal`).
 */
interface AppliedKnowledge {
  readonly answered?: TagMark | undefined;
  readonly answeredRevision?: number | undefined;
  readonly unanswered?: { readonly mark: TagMark; readonly count: number } | undefined;
  readonly unrevised?: TagMark | undefined;
}

export class TagState {
  readonly #tags = new Lru<string, TagKnowledge>(MAX_TAGS_HELD);
  readonly #applied = new Lru<string, AppliedKnowledge>(MAX_APPLIED_MARKS);
  readonly #holdMs: number;
  readonly #log: TagStateOptions['log'];
  #revision = 0;
  #syncedAt: number | undefined;

  constructor(options: TagStateOptions) {
    this.#holdMs = options.holdMs;
    this.#log = options.log;
  }

  /**
   * Bring the view up to the host's revision through its delta, page by page, as asked at `now`:
   * `true` once the last page is in, and `false` where the host could not be read to the end. What
   * the pages before that brought stays in the view, and the revision with it; the hold it was last
   * brought up for (`#syncedAt`) stands as it was.
   */
  async #pull(host: TagHost, now: number): Promise<boolean> {
    try {
      let truncated = true;
      while (truncated) {
        const delta = await host.tagsDelta(this.#revision);
        for (const tag of delta.tags) {
          this.#mark(tag.value, {
            staleAt: tag.staleAt,
            hardExpireAt: tag.hardExpireAt,
            revision: tag.revision ?? delta.revision,
          });
        }
        this.#revision = Math.max(this.#revision, delta.revision);
        truncated = delta.truncated;
      }
      // Pulls overlap, and one that began earlier can answer last: what a later one brought is in
      // the view already, and its hold stands. So does a page another pull took of a delta it has
      // not finished: this pull's last answer held every invalidation the host had made when this
      // pull began, which is all `#syncedAt` claims, and what the other pull still has to bring
      // was made after that — a change the hold lets wait, as it lets wait one made after any pull.
      this.#syncedAt = Math.max(this.#syncedAt ?? now, now);
      return true;
    } catch (error) {
      // What is known stays known: a read judged against an older view is a read that may be
      // served stale for one hold, never one that fails.
      this.#log?.('tags not synced', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** What the host said of a tag, kept whole beside what was already known of it. */
  #mark(value: string, mark: TagMark): void {
    const known = this.#tags.get(value);
    const held = known?.mark;
    this.#tags.set(value, {
      ...known,
      mark: held === undefined ? mark : stronger(held, mark),
      ...(mark.revision === undefined
        ? { unknownAt: Math.max(known?.unknownAt ?? mark.staleAt, mark.staleAt) }
        : { knownRevision: Math.max(known?.knownRevision ?? mark.revision, mark.revision) }),
    });
  }

  async #pullLocal(host: TagHost, values: readonly string[], now: number): Promise<void> {
    const result = await host.getTags(values);
    for (const tag of result.tags) {
      this.#mark(tag.value, {
        staleAt: tag.staleAt,
        hardExpireAt: tag.hardExpireAt,
        revision: tag.revision,
      });
    }
    // Every tag asked about, not only the ones the host had something to say about: the answer
    // that a tag has no invalidation is worth the same hold as the answer that it has one.
    //
    // The two loops are one turn: there is no `await` between them, so no other read can evict
    // what the first just marked before the second reads it back. A second read of this key
    // would find the mark even if one could — it is read and written together.
    //
    // Questions overlap, and one asked earlier can answer last: what a later one was told is in the
    // view already, and its hold stands.
    for (const value of values) {
      const known = this.#tags.get(value);
      this.#tags.set(value, { ...known, checkedAt: Math.max(known?.checkedAt ?? now, now) });
    }
  }

  /**
   * What this isolate knows of a tag: what it was told, and what it did itself, the strongest of
   * them. The second is kept apart because it is the only one no read brings back — see
   * `MAX_APPLIED_MARKS`.
   */
  #markOf(value: string): TagMark | undefined {
    const applied = this.#applied.get(value);
    return strongest([
      this.#tags.get(value)?.mark,
      applied?.answered,
      applied?.unanswered?.mark,
      applied?.unrevised,
    ]);
  }

  /**
   * Whether a view brought up to the revision `held` held every invalidation of the tag known here
   * that reaches an entry made at `timestamp`: one this isolate was told, known at a revision no
   * later than `held` — none known at no revision reaching it — and one of its own the host answered
   * at such a revision. One of its own out, or known at no revision for good, that reaches it is one
   * no view is known to have held.
   */
  #heldBy(value: string, timestamp: number, held: number): boolean {
    const told = this.#tags.get(value);
    const applied = this.#applied.get(value);
    const reaches = (mark: TagMark | undefined): boolean =>
      mark !== undefined && mark.staleAt >= timestamp;
    const within = (revision: number | undefined): boolean =>
      revision === undefined || revision <= held;
    return (
      !reaches(applied?.unanswered?.mark) &&
      !reaches(applied?.unrevised) &&
      (!reaches(applied?.answered) || within(applied?.answeredRevision)) &&
      (!reaches(told?.mark) ||
        ((told?.unknownAt ?? timestamp - 1) < timestamp && within(told?.knownRevision)))
    );
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
   *
   * Each call that needs a pull makes its own, whatever pull is under way: that one is I/O of the
   * request that started it, which the Workers runtime cancels once that request is over, and a
   * regeneration of another request waiting on it would wait as long as its request was let run.
   * What two pulls bring is merged, whichever answers first.
   *
   * Answers whether the view stands brought up: held within the hold, or pulled by this call — not
   * by another that a clock reading the same moment could not tell from it. Never rejects.
   */
  async sync(host: TagHost, now: number, options: { force?: boolean } = {}): Promise<boolean> {
    const held = this.#syncedAt !== undefined && now - this.#syncedAt < this.#holdMs;
    if (held && options.force !== true) {
      return true;
    }
    return this.#pull(host, now);
  }

  /**
   * Check only the tags a read uses, through KV in the caller's region.
   *
   * Every judgement a data cache makes runs after this — `getUseCache`, the fetch cache's `get`
   * and `getExpiration` all sync the very tags they are about to weigh — which is what lets the
   * synced view be bounded: a tag this isolate has forgotten is one it asks about again here.
   * `currentGeneration` is the reader that does not, and `MAX_APPLIED_MARKS` is why it need not.
   *
   * What the host answered is held; a question still under way is not. It is I/O of the request
   * that asked it, which the Workers runtime cancels once that request is over, and a read of
   * another request waiting on it would wait for nothing — so a tag no answer is held for is asked
   * about again by every read that needs it, until one answer is in.
   */
  async syncLocal(host: TagHost, values: readonly string[], now: number): Promise<void> {
    const needed = [...new Set(values)].filter((value) => {
      const checked = this.#tags.get(value)?.checkedAt;
      return checked === undefined || now - checked >= this.#holdMs;
    });
    const reads: Promise<void>[] = [];
    for (let offset = 0; offset < needed.length; offset += MAX_TAGS_PER_CALL) {
      reads.push(this.#pullLocal(host, needed.slice(offset, offset + MAX_TAGS_PER_CALL), now));
    }
    await Promise.all(reads);
  }

  /**
   * An invalidation this Function is recording: in force here before the host has answered, or the
   * delta says so, and known at no revision until the host has answered it (`confirmLocal`) — one
   * no view may yet hold, whatever its time.
   */
  applyLocal(values: readonly string[], mark: TagMark): void {
    const unknown = { staleAt: mark.staleAt, hardExpireAt: mark.hardExpireAt };
    // Each tag once: a host answers a tag named twice in one call once.
    const distinct = new Set(values);
    for (const value of distinct) {
      const held = this.#applied.get(value);
      const out = held?.unanswered;
      this.#applied.set(value, {
        ...held,
        unanswered: {
          mark: out === undefined ? unknown : stronger(out.mark, unknown),
          count: (out?.count ?? 0) + 1,
        },
      });
    }
  }

  /**
   * What the host answered one of this Function's invalidations of the tag with, at the revision of
   * the scope it recorded it at (`answered`): one fewer is out. The marks of those still out stay as
   * they were, known at no revision, until the last of them has been answered — a moment two of them
   * read is no proof which one an answer is for. An answer that says no revision is one the
   * invalidation is known at none by for good (`settleLocal`).
   */
  confirmLocal(value: string, answered: TagMark): void {
    if (answered.revision === undefined) {
      this.settleLocal([value], answered);
      return;
    }
    const held = this.#applied.get(value);
    this.#applied.set(value, {
      ...held,
      answered: held?.answered === undefined ? answered : stronger(held.answered, answered),
      answeredRevision: Math.max(held?.answeredRevision ?? answered.revision, answered.revision),
      unanswered: oneFewer(held?.unanswered),
    });
  }

  /**
   * What the host answered this Function's invalidation of `values` with (`outcome`), the call made
   * at `now` with `applied` in force while it was out: each tag it recorded, at the revision it
   * recorded it at (`confirmLocal`) — a view that pulls the delta up to there holds it, whatever the
   * clocks say — and each it recorded nothing of, in force as it was applied, at no revision
   * (`settleLocal`).
   */
  answerLocal(
    values: readonly string[],
    applied: TagMark,
    outcome: InvalidateOutcome,
    now: number,
  ): void {
    const asked = new Set(values);
    const answered = new Set<string>();
    for (const invalidation of outcome.invalidations) {
      // Only a tag this call applied: an answer for another takes none of the others' out.
      if (!asked.has(invalidation.value) || answered.has(invalidation.value)) {
        continue;
      }
      answered.add(invalidation.value);
      this.confirmLocal(invalidation.value, {
        revision: invalidation.revision ?? outcome.revision,
        // The request may have read cache data while the invalidation call was in flight.
        staleAt: Math.max(now, invalidation.staleAt),
        // The deadline by this isolate's clock too, whichever comes first: a host whose clock
        // runs ahead must not leave an `updateTag` servable here, as stale, until this clock catches
        // up with it.
        hardExpireAt:
          invalidation.hardExpireAt === null
            ? null
            : Math.min(
                invalidation.hardExpireAt,
                now + Math.max(0, invalidation.hardExpireAt - invalidation.staleAt),
              ),
      });
    }
    this.settleLocal(
      [...asked].filter((value) => !answered.has(value)),
      applied,
    );
  }

  /**
   * One of this Function's invalidations of these tags no longer out, and known at no revision of
   * the scope for good: the host did not answer it, or answered at a revision of another kind. In
   * force here as before, and held against an entry it reaches whatever revision that entry's view
   * was brought up to.
   */
  settleLocal(values: readonly string[], mark: TagMark): void {
    const unknown = { staleAt: mark.staleAt, hardExpireAt: mark.hardExpireAt };
    const distinct = new Set(values);
    for (const value of distinct) {
      const held = this.#applied.get(value);
      this.#applied.set(value, {
        ...held,
        unrevised: held?.unrevised === undefined ? unknown : stronger(held.unrevised, unknown),
        unanswered: oneFewer(held?.unanswered),
      });
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
   *
   * Where the entry was made against a view brought up to a revision of the scope (`held`), an
   * invalidation the mark says was recorded at or before it was in that view, whatever its time
   * says: the clock that stamped it may read later than the moment the view was asked for, and the
   * pull that brought the view up brought it all the same.
   */
  validityOf(tags: readonly string[], timestamp: number, now: number, held?: number): Validity {
    let validity: Validity = 'fresh';
    for (const tag of tags) {
      if (held !== undefined && this.#heldBy(tag, timestamp, held)) {
        continue;
      }
      const applied = this.#applied.get(tag);
      // What is out, or known at no revision for good, is asked of apart, and the worse answer
      // stands: an answer of the host's, whatever its clock read, is not taken for newer than an
      // invalidation of this isolate's it holds no revision of.
      const told = strongest([this.#tags.get(tag)?.mark, applied?.answered]);
      const own = strongest([applied?.unanswered?.mark, applied?.unrevised]);
      const byTold = markValidity(told, timestamp, now);
      const byOwn = markValidity(own, timestamp, now);
      if (byTold === 'expired' || byOwn === 'expired') {
        return 'expired';
      }
      if (byTold === 'stale' || byOwn === 'stale') {
        validity = 'stale';
      }
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
 * the earlier deadline. What revision each is known at is kept apart from the mark they make
 * (`TagKnowledge`, `AppliedKnowledge`), and read off neither.
 */
function stronger(a: TagMark, b: TagMark): TagMark {
  if (a.staleAt !== b.staleAt) {
    return a.staleAt > b.staleAt ? a : b;
  }
  return { staleAt: a.staleAt, hardExpireAt: earliest(a.hardExpireAt, b.hardExpireAt) };
}

/** What is out of this Function's own invalidations of a tag once one more is no longer out. */
function oneFewer(out: AppliedKnowledge['unanswered']): AppliedKnowledge['unanswered'] | undefined {
  return out === undefined || out.count <= 1 ? undefined : { mark: out.mark, count: out.count - 1 };
}

/** The strongest of `marks` (`stronger`), or none where there are none. */
function strongest(marks: readonly (TagMark | undefined)[]): TagMark | undefined {
  let found: TagMark | undefined;
  for (const mark of marks) {
    if (mark !== undefined) {
      found = found === undefined ? mark : stronger(found, mark);
    }
  }
  return found;
}

/** What one mark says of an entry made at `timestamp`, judged at `now` (`validityOf`). */
function markValidity(mark: TagMark | undefined, timestamp: number, now: number): Validity {
  if (mark === undefined || mark.staleAt < timestamp) {
    return 'fresh';
  }
  return mark.hardExpireAt !== null && mark.hardExpireAt <= now ? 'expired' : 'stale';
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
