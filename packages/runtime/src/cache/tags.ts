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
 * Marks of a tag known at no revision, in force here at once, of which none says all that another
 * does of every entry (`withMark`): each is asked of, and the worst answer stands (`marksValidity`).
 * Nothing tells which of them the host recorded last. Taken as one mark, the one stamped latest
 * would hide a deadline another set, and taken by the order of the calls that made them, one the
 * host recorded later than it was asked for would be lost.
 */
type Marks = readonly TagMark[];

/**
 * How many marks of a tag known at no revision are kept apart at the most (`withMark`): more than
 * calls stamped in that order with deadlines in that order come to. Past that many, the two made
 * earliest are taken as one that says all of both — the later moment, and the earlier deadline —
 * which holds more back than either did, and never less. Of this Function's calls still out, those
 * taken together are held apart again once no more than that many are out (`without`).
 */
const MAX_MARKS = 16;

/**
 * What this isolate knows of one tag, and when the host last said so (`checkedAt`): its latest
 * invalidation the host said the revision of (`mark`), with the latest revision one is known at
 * (`knownRevision`) — what tells a view that held it from one that did not (`TagMark.revision`) —
 * and, apart, those it said none of (`unknown`), known at no revision.
 */
interface TagKnowledge {
  readonly mark?: TagMark | undefined;
  readonly checkedAt?: number | undefined;
  readonly knownRevision?: number | undefined;
  readonly unknown?: Marks | undefined;
}

/**
 * One call of this Function's that records invalidations of tags, from `applyLocal` until the host
 * has answered it: the tags it names, each once, and the mark it puts in force here. An answer
 * settles the call it answers and no other (`confirmLocal`, `settleLocal`), whatever else of the
 * tag is out by then — or was forgotten and made anew meanwhile (`MAX_APPLIED_MARKS`).
 */
export interface LocalInvalidation {
  readonly values: readonly string[];
  readonly mark: TagMark;
}

/**
 * The calls of this Function's still out that name a tag, each added and taken out where it stands,
 * and the marks they applied (`Marks`), in force here at no revision.
 */
interface Unanswered {
  readonly marks: Marks;
  readonly calls: Set<LocalInvalidation>;
}

/**
 * The calls of this Function's out that name a tag past the `MAX_CALLS_OUT` counted one by one: how
 * many, and the marks they applied (`Marks`), in force here at no revision until the last of them is
 * out no more. Held weakly, by the calls themselves: a call whose request ended under it never
 * answers, and nothing but the count is kept of it.
 */
interface Overflow {
  readonly marks: Marks;
  readonly count: number;
  readonly calls: WeakSet<LocalInvalidation>;
}

/**
 * How many calls of this Function's out, of every tag, are counted one by one (`Unanswered`), each
 * taking its own mark out with it as it is answered: more than calls a host answering at all leaves
 * out at once. Past that many, the one out longest is counted with the others past it of each tag it
 * names (`Overflow`), whose marks stay in force until the last of them is answered — calls whose
 * requests ended under them, which never answer, piling up. A call is never taken for one the host
 * never answers for being out long, or one of many: its request may be running yet, and the runtime
 * cannot tell one that is from one that ended under it.
 */
const MAX_CALLS_OUT = 4096;

/**
 * This isolate's own invalidations of one tag, all in force here: those the host has answered at a
 * revision of the scope's (`confirmLocal`), the one answered at the latest with that revision; those
 * it has yet to answer, by the call each is out with (`applyLocal`), and past so many counted
 * together; and those known at no revision for good — the host never answered them, or answered at
 * a revision of another kind (`settleLocal`).
 */
interface AppliedKnowledge {
  readonly answered?: TagMark | undefined;
  readonly answeredRevision?: number | undefined;
  readonly unanswered?: Unanswered | undefined;
  readonly overflow?: Overflow | undefined;
  readonly unrevised?: Marks | undefined;
}

export class TagState {
  readonly #tags = new Lru<string, TagKnowledge>(MAX_TAGS_HELD);
  readonly #applied = new Lru<string, AppliedKnowledge>(MAX_APPLIED_MARKS);
  /** The calls out counted one by one, of every tag, the one out longest first (`MAX_CALLS_OUT`). */
  readonly #out = new Set<LocalInvalidation>();
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

  /**
   * What the host said of a tag, kept whole beside what was already known of it: the latest revision
   * an invalidation of it is known at, and those known at none beside each other (`Marks`).
   *
   * Every revision the host says it recorded an invalidation at is an invalidation of its own, whatever
   * its mark says — two `updateTag`s of one millisecond, or a later one stamped by a clock that reads
   * behind — and a view brought up short of it missed it. So is a mark the host says no revision of,
   * known at the revision of the page of the delta that brought it, though a pull that overlapped the
   * one that brought it first may be bringing it again: the two cannot be told apart by what such a
   * host says, and a render taken for one that missed an invalidation is made again, where one taken
   * for one that held it would be served stale. A host that says each mark's revision is spared that.
   */
  #mark(value: string, mark: TagMark): void {
    const known = this.#tags.get(value);
    const { revision } = mark;
    if (revision === undefined) {
      this.#tags.set(value, { ...known, unknown: withMark(known?.unknown, mark) });
      return;
    }
    const held = known?.mark;
    this.#tags.set(value, {
      ...known,
      mark: held === undefined ? mark : latestOf(held, known?.knownRevision, mark, revision),
      knownRevision: Math.max(known?.knownRevision ?? revision, revision),
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
    const told = this.#tags.get(value);
    return strongest([
      told?.mark,
      ...(told?.unknown ?? []),
      applied?.answered,
      ...(applied?.unanswered?.marks ?? []),
      ...(applied?.overflow?.marks ?? []),
      ...(applied?.unrevised ?? []),
    ]);
  }

  /**
   * Whether a view brought up to the revision `held` held every invalidation of the tag known here
   * that reaches an entry made at `timestamp`: every one this isolate was told, and every one of its
   * own the host answered, known at a revision no later than `held` — one known past it is one the
   * view missed, whatever its time — and none known at no revision reaching it. One of its own out,
   * or known at no revision for good, that reaches it is one no view is known to have held.
   */
  #heldBy(value: string, timestamp: number, held: number): boolean {
    const told = this.#tags.get(value);
    const applied = this.#applied.get(value);
    const within = (revision: number | undefined): boolean =>
      revision === undefined || revision <= held;
    // One known at a revision past `held` is one the view missed, whatever its time says.
    return (
      !reachesAny(applied?.unanswered?.marks, timestamp) &&
      !reachesAny(applied?.overflow?.marks, timestamp) &&
      !reachesAny(applied?.unrevised, timestamp) &&
      within(applied?.answeredRevision) &&
      within(told?.knownRevision) &&
      !reachesAny(told?.unknown, timestamp)
    );
  }

  /**
   * What all that is known of `tag` says of an entry made at `timestamp`, judged at `now` (`validityOf`).
   * What the host said at a revision, what it answered of this isolate's own at one, and each mark
   * known at no revision — what it said at none, and what of this isolate's own is out or known at
   * none for good (`Marks`) — are asked of apart, and the worst answer stands: taken as one mark, the
   * one stamped latest would hide a deadline the others set, whatever the clocks that stamped them
   * read.
   * Known at a revision past the one the entry's view was brought up to (`held`), an invalidation is
   * one that view missed, whatever its time says of the moment the entry was made.
   */
  #validityOfTag(tag: string, timestamp: number, now: number, held: number | undefined): Validity {
    const applied = this.#applied.get(tag);
    const known = this.#tags.get(tag);
    const missed = (revision: number | undefined): boolean =>
      held !== undefined && revision !== undefined && revision > held;
    const byTold = markValidity(
      known?.mark,
      missed(known?.knownRevision) ? -Infinity : timestamp,
      now,
    );
    const byAnswered = markValidity(
      applied?.answered,
      missed(applied?.answeredRevision) ? -Infinity : timestamp,
      now,
    );
    const byUnrevised = marksValidity(
      [
        ...(known?.unknown ?? []),
        ...(applied?.unanswered?.marks ?? []),
        ...(applied?.overflow?.marks ?? []),
        ...(applied?.unrevised ?? []),
      ],
      timestamp,
      now,
    );
    return worst(worst(byTold, byAnswered), byUnrevised);
  }

  /**
   * Count `call` with the others past those counted one by one, of each tag it names that has it out
   * still (`Overflow`).
   */
  #overflowing(call: LocalInvalidation): void {
    for (const value of call.values) {
      const held = this.#applied.get(value);
      if (held?.unanswered?.calls.has(call) === true) {
        this.#applied.set(value, {
          ...held,
          unanswered: without(held.unanswered, call),
          overflow: overflowing(held.overflow, call),
        });
      }
    }
  }

  /** Count `call` out no more (`#out`) once no tag it names has it out one by one. */
  #counted(call: LocalInvalidation): void {
    if (
      call.values.every((value) => this.#applied.get(value)?.unanswered?.calls.has(call) !== true)
    ) {
      this.#out.delete(call);
    }
  }

  get revision(): number {
    return this.#revision;
  }

  /** How many calls of this Function's out are counted one by one, of every tag (`MAX_CALLS_OUT`). */
  get callsOut(): number {
    return this.#out.size;
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
   * An invalidation this Function is recording, as one call (`LocalInvalidation`): in force here
   * before the host has answered, or the delta says so, and known at no revision until the host has
   * answered it (`confirmLocal`) — one no view may yet hold, whatever its time. The call returned is
   * what its answer settles (`answerLocal`, `settleLocal`).
   */
  applyLocal(values: readonly string[], mark: TagMark): LocalInvalidation {
    const call: LocalInvalidation = {
      // Each tag once: a host answers a tag named twice in one call once.
      values: [...new Set(values)],
      mark: { staleAt: mark.staleAt, hardExpireAt: mark.hardExpireAt },
    };
    for (const value of call.values) {
      const held = this.#applied.get(value);
      const out = held?.unanswered;
      const calls = out?.calls ?? new Set<LocalInvalidation>();
      calls.add(call);
      this.#applied.set(value, {
        ...held,
        unanswered: { marks: withMark(out?.marks, call.mark), calls },
      });
    }
    this.#out.add(call);
    for (const longest of this.#out) {
      if (this.#out.size <= MAX_CALLS_OUT) {
        break;
      }
      this.#out.delete(longest);
      this.#overflowing(longest);
    }
    return call;
  }

  /**
   * What the host answered `call` with for the tag, at the revision of the scope it recorded it at
   * (`answered`): the call is out no more, and the marks of the others still out stay, known at no
   * revision. An answer that says no revision is one the invalidation is known at none by for good
   * (`settleLocal`).
   */
  confirmLocal(value: string, answered: TagMark, call: LocalInvalidation): void {
    if (answered.revision === undefined) {
      this.settleLocal(call, [value], answered);
      return;
    }
    const held = this.#applied.get(value);
    this.#applied.set(value, {
      ...held,
      answered:
        held?.answered === undefined
          ? answered
          : latestOf(held.answered, held.answeredRevision, answered, answered.revision),
      answeredRevision: Math.max(held?.answeredRevision ?? answered.revision, answered.revision),
      unanswered: without(held?.unanswered, call),
      overflow: overflowWithout(held?.overflow, call),
    });
    this.#counted(call);
  }

  /**
   * What the host answered `call`, made at `now`, with (`outcome`): each tag it recorded, at the
   * revision it recorded it at (`confirmLocal`) — a view that pulls the delta up to there holds it,
   * whatever the clocks say — and each it recorded nothing of, in force as the call applied it, at
   * no revision (`settleLocal`).
   */
  answerLocal(call: LocalInvalidation, outcome: InvalidateOutcome, now: number): void {
    const asked = new Set(call.values);
    const answered = new Set<string>();
    for (const invalidation of outcome.invalidations) {
      // Only a tag this call applied: an answer for another takes none of the others' out.
      if (!asked.has(invalidation.value) || answered.has(invalidation.value)) {
        continue;
      }
      answered.add(invalidation.value);
      this.confirmLocal(
        invalidation.value,
        {
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
        },
        call,
      );
    }
    this.settleLocal(
      call,
      call.values.filter((value) => !answered.has(value)),
    );
  }

  /**
   * `call` out no more for `values` — every tag it names, unless they are named — and its
   * invalidation of them known at no revision of the scope for good, as `mark` says (the call's
   * own, unless one is given): the host did not answer it, or answered at a revision of another
   * kind. In force here as before, and held against an entry it reaches whatever revision that
   * entry's view was brought up to. A call settled already, or forgotten with the tag, takes
   * nothing out of what another call left out.
   */
  settleLocal(
    call: LocalInvalidation,
    values: readonly string[] = call.values,
    mark: TagMark = call.mark,
  ): void {
    const unknown = { staleAt: mark.staleAt, hardExpireAt: mark.hardExpireAt };
    const distinct = new Set(values);
    for (const value of distinct) {
      const held = this.#applied.get(value);
      this.#applied.set(value, {
        ...held,
        unrevised: withMark(held?.unrevised, unknown),
        unanswered: without(held?.unanswered, call),
        overflow: overflowWithout(held?.overflow, call),
      });
    }
    this.#counted(call);
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
   * pull that brought the view up brought it all the same. One known only at a revision past it is
   * one the view missed, whatever its time says, for the same reason.
   */
  validityOf(tags: readonly string[], timestamp: number, now: number, held?: number): Validity {
    let validity: Validity = 'fresh';
    for (const tag of tags) {
      if (held !== undefined && this.#heldBy(tag, timestamp, held)) {
        continue;
      }
      const answer = this.#validityOfTag(tag, timestamp, now, held);
      if (answer === 'expired') {
        return 'expired';
      }
      if (answer === 'stale') {
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

/**
 * What is out of this Function's own invalidations of a tag once `call` is no longer out: the others,
 * under the marks they applied (`Marks`), each held apart as it was made once no more than
 * `MAX_MARKS` are out. Of more, where `call`'s mark was one of theirs, the marks of the others it
 * said all of come forward in its place; otherwise another says all of it, and they stand as they
 * were. A call not among them — settled already, or out from before the tag was forgotten
 * (`MAX_APPLIED_MARKS`) — takes none of them out.
 */
function without(out: Unanswered | undefined, call: LocalInvalidation): Unanswered | undefined {
  if (out?.calls.delete(call) !== true) {
    return out;
  }
  if (out.calls.size === 0) {
    return undefined;
  }
  if (out.calls.size <= MAX_MARKS) {
    let marks: Marks = [];
    for (const each of out.calls) {
      marks = withMark(marks, each.mark);
    }
    return { marks, calls: out.calls };
  }
  const gone = out.marks.find((each) => sameMark(each, call.mark));
  if (gone === undefined) {
    return out;
  }
  let marks = out.marks.filter((each) => each !== gone);
  // The call made last first: calls stamp their marks in the order they are made, so the first to
  // come forward says all of the most, and those it says all of are passed over (`withMark`).
  for (const each of [...out.calls].toReversed()) {
    if (covers(gone, each.mark)) {
      marks = withMark(marks, each.mark);
    }
  }
  return { marks, calls: out.calls };
}

/** Whether two marks say the same of every entry: the same moment, and the same deadline. */
function sameMark(a: TagMark, b: TagMark): boolean {
  return a.staleAt === b.staleAt && a.hardExpireAt === b.hardExpireAt;
}

/**
 * The two marks of a tag as one, `held` known at `heldAt` and `mark` at `at`: where both are known at
 * revisions of the scope, the one known at the later. The host keeps the latest invalidation it
 * recorded, and that is what an isolate starting now holds, whatever the clocks that stamped the two
 * say — a later one stamped earlier keeps its own deadline. Otherwise, and of one revision, the
 * stronger (`stronger`).
 */
function latestOf(
  held: TagMark,
  heldAt: number | undefined,
  mark: TagMark,
  at: number | undefined,
): TagMark {
  if (heldAt === undefined || at === undefined || heldAt === at) {
    return stronger(held, mark);
  }
  return at > heldAt ? mark : held;
}

/** The calls past those counted one by one, with `call` among them (`Overflow`). */
function overflowing(overflow: Overflow | undefined, call: LocalInvalidation): Overflow {
  return {
    marks: withMark(overflow?.marks, call.mark),
    count: (overflow?.count ?? 0) + 1,
    calls: (overflow?.calls ?? new WeakSet<LocalInvalidation>()).add(call),
  };
}

/**
 * The calls past those counted one by one once `call` is out no more: none, once the last of them
 * is, and their marks stay in force till then. A call not among them takes none of them out.
 */
function overflowWithout(
  overflow: Overflow | undefined,
  call: LocalInvalidation,
): Overflow | undefined {
  if (overflow?.calls.delete(call) !== true) {
    return overflow;
  }
  return overflow.count <= 1 ? undefined : { ...overflow, count: overflow.count - 1 };
}

/** Whether `a` says all that `b` does of every entry: made no earlier, with a deadline no later. */
function covers(a: TagMark, b: TagMark): boolean {
  return a.staleAt >= b.staleAt && (a.hardExpireAt ?? Infinity) <= (b.hardExpireAt ?? Infinity);
}

/**
 * `marks` with `mark` in force beside them (`Marks`): none kept that another says all of (`covers`),
 * the one made earliest first. Past `MAX_MARKS`, the two made earliest are taken as one.
 */
function withMark(marks: Marks | undefined, mark: TagMark): Marks {
  const held = marks ?? [];
  if (held.some((each) => covers(each, mark))) {
    return held;
  }
  const kept = [
    ...held.filter((each) => !covers(mark, each)),
    { staleAt: mark.staleAt, hardExpireAt: mark.hardExpireAt },
  ].toSorted((a, b) => a.staleAt - b.staleAt);
  const [first, second, ...rest] = kept;
  if (first === undefined || second === undefined || kept.length <= MAX_MARKS) {
    return kept;
  }
  return [
    { staleAt: second.staleAt, hardExpireAt: earliest(first.hardExpireAt, second.hardExpireAt) },
    ...rest,
  ];
}

/** Whether any of `marks` reaches an entry made at `timestamp`. */
function reachesAny(marks: Marks | undefined, timestamp: number): boolean {
  return marks?.some((mark) => mark.staleAt >= timestamp) === true;
}

/** What `marks` say of an entry made at `timestamp`, judged at `now`: the worst any of them does. */
function marksValidity(marks: Marks, timestamp: number, now: number): Validity {
  let validity: Validity = 'fresh';
  for (const mark of marks) {
    validity = worst(validity, markValidity(mark, timestamp, now));
  }
  return validity;
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

/** The worse of two answers of what a tag says of an entry. */
function worst(a: Validity, b: Validity): Validity {
  if (a === 'expired' || b === 'expired') {
    return 'expired';
  }
  return a === 'stale' || b === 'stale' ? 'stale' : 'fresh';
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
