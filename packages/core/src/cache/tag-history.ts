/** One invalidation, including the revision that a regenerated value may already have held. */
export interface TagHistoryMark {
  readonly revision: number;
  readonly staleAt: number;
  readonly hardExpireAt: number | null;
}

/** Bounds both a regional tag record and the per-tag state an isolate retains. */
export const MAX_TAG_HISTORY = 16;

/**
 * Keep every distinct deadline that can still change an entry's validity. A later invalidation
 * with a longer window cannot undo an earlier expiry, and an earlier revision cannot stand in
 * for a later one that a regenerated value's view missed.
 *
 * At the bound, combine the two oldest timestamp ranges conservatively: their later timestamp,
 * earlier deadline and later revision. This may expire an extra value under sustained churn,
 * but never makes an expired value servable again. No history grows with the life of a scope.
 */
export function withTagHistory(
  history: readonly TagHistoryMark[] | undefined,
  mark: TagHistoryMark,
): TagHistoryMark[] {
  const deadline = (each: TagHistoryMark): number => each.hardExpireAt ?? Infinity;
  const covers = (a: TagHistoryMark, b: TagHistoryMark): boolean =>
    a.revision >= b.revision && a.staleAt >= b.staleAt && deadline(a) <= deadline(b);
  if (history?.some((each) => covers(each, mark)) === true) return [...history];
  const kept = (history ?? []).filter((each) => !covers(mark, each));
  kept.push({ revision: mark.revision, staleAt: mark.staleAt, hardExpireAt: mark.hardExpireAt });
  kept.sort((a, b) => a.staleAt - b.staleAt || a.revision - b.revision);
  if (kept.length > MAX_TAG_HISTORY) {
    const [first, second] = kept;
    if (first !== undefined && second !== undefined) {
      const hardExpireAt = Math.min(deadline(first), deadline(second));
      kept.splice(0, 2, {
        revision: Math.max(first.revision, second.revision),
        staleAt: second.staleAt,
        hardExpireAt: hardExpireAt === Infinity ? null : hardExpireAt,
      });
    }
  }
  return kept;
}
