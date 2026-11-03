import type { TagHistoryMark, Validity } from '@stayingupwind/core/cache';

/**
 * The marks of an invalidation this isolate holds of a tag, and what they say of an entry made at a
 * moment: those known at a revision of the scope, kept as the tag's history, and those known at none,
 * kept beside each other (`Marks`). What the tag view keeps of each tag is made of these
 * (`TagState`, in `tags.ts`).
 */

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

/**
 * Marks of a tag known at no revision, in force here at once, of which none says all that another
 * does of every entry (`withMark`): each is asked of, and the worst answer stands (`marksValidity`).
 * Nothing tells which of them the host recorded last. Taken as one mark, the one stamped latest
 * would hide a deadline another set, and taken by the order of the calls that made them, one the
 * host recorded later than it was asked for would be lost.
 *
 * Kept the one made earliest first, each made later sets a later deadline too — else it would say
 * all of the one before — so of those that reach an entry, the first sets the earliest deadline.
 */
export type Marks = readonly TagMark[];

/**
 * How many marks of a tag known at no revision for good, or of calls counted together, are kept
 * apart at the most (`withMark`): more than calls stamped in that order with deadlines in that order
 * come to. Past that many, the two made earliest are taken as one that says all of both — the later
 * moment, and the earlier deadline — which holds more back than either did, and never less. Nothing
 * of either is taken out one by one. The marks of the calls still out counted one by one are kept
 * apart however many they are, each taken out with its call (`without`): no more than the calls.
 */
const MAX_MARKS = 16;

/** Whether `a` says all that `b` does of every entry: made no earlier, with a deadline no later. */
export function covers(a: TagMark, b: TagMark): boolean {
  return a.staleAt >= b.staleAt && deadlineOf(a) <= deadlineOf(b);
}

/** The moment a mark expires what it reaches, where it sets one; never, where it does not. */
function deadlineOf(mark: TagMark): number {
  return mark.hardExpireAt ?? Infinity;
}

/**
 * Where in `marks` the first of them is that reaches an entry made at `timestamp` (`Marks`): of those
 * that do, the one with the earliest deadline. Past the last, where none does.
 */
export function firstReaching(marks: Marks, timestamp: number): number {
  let low = 0;
  let high = marks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((marks[middle]?.staleAt ?? timestamp) < timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Put `mark` in force beside `marks`, where they stand (`Marks`): none kept that another says all of
 * (`covers`). Past `most`, the two made earliest are taken as one.
 */
export function addMark(marks: TagMark[], mark: TagMark, most: number): void {
  const at = firstReaching(marks, mark.staleAt);
  const next = marks[at];
  if (next !== undefined && deadlineOf(next) <= deadlineOf(mark)) {
    return;
  }
  // Those `mark` says all of: the last run of those made before it whose deadlines come no earlier
  // than its own, and one made at its very moment.
  let from = at;
  while (from > 0 && deadlineOf(marks[from - 1] ?? mark) >= deadlineOf(mark)) {
    from -= 1;
  }
  marks.splice(from, (next?.staleAt === mark.staleAt ? at + 1 : at) - from, mark);
  const [first, second] = marks;
  if (first !== undefined && second !== undefined && marks.length > most) {
    marks.splice(0, 2, { staleAt: second.staleAt, hardExpireAt: first.hardExpireAt });
  }
}

/** `marks` with `mark` in force beside them (`addMark`), past `MAX_MARKS` the earliest taken together. */
export function withMark(marks: Marks | undefined, mark: TagMark): Marks {
  const kept = [...(marks ?? [])];
  addMark(kept, mark, MAX_MARKS);
  return kept;
}

/** Whether any of `marks` reaches an entry made at `timestamp`: the one made last does. */
export function reachesAny(marks: Marks | undefined, timestamp: number): boolean {
  return (marks?.at(-1)?.staleAt ?? -Infinity) >= timestamp;
}

/**
 * What `marks` say of an entry made at `timestamp`, judged at `now`: the worst any of them does, which
 * the first of them that reaches it does (`Marks`).
 */
export function marksValidity(marks: Marks | undefined, timestamp: number, now: number): Validity {
  return marks === undefined
    ? 'fresh'
    : markValidity(marks[firstReaching(marks, timestamp)], timestamp, now);
}

/** Earlier deadlines apply only to values that did not already hold their invalidation. */
export function historyValidity(
  history: readonly TagHistoryMark[] | undefined,
  timestamp: number,
  now: number,
  held: number | undefined,
): Validity {
  if (history === undefined) return 'fresh';
  let validity: Validity = 'fresh';
  for (const mark of history) {
    if (held !== undefined && mark.revision <= held) continue;
    validity = worst(validity, markValidity(mark, held === undefined ? timestamp : -Infinity, now));
    if (validity === 'expired') return validity;
  }
  return validity;
}

/** The worse of two answers of what a tag says of an entry. */
export function worst(a: Validity, b: Validity): Validity {
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
