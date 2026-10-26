import { compareCodeUnits } from '@stayingupwind/core/util';

/** One independently served share of a local check, with a one-based index. */
export interface CheckShard {
  readonly index: number;
  readonly total: number;
}

function validCheckShard(shard: CheckShard): boolean {
  return (
    Number.isSafeInteger(shard.index) &&
    Number.isSafeInteger(shard.total) &&
    shard.index > 0 &&
    shard.total > 0 &&
    shard.index <= shard.total
  );
}

/** Reject an incomplete partition before the check asks anything of its stack. */
export function assertCheckShard(shard: CheckShard | undefined): void {
  if (shard !== undefined && !validCheckShard(shard)) {
    throw new TypeError(
      'a check shard needs positive safe integer index and total, with index <= total',
    );
  }
}

/** The command line's one-based `index/total`, or no valid shard. */
export function parseCheckShard(value: string): CheckShard | null {
  if (!/^\d+\/\d+$/u.test(value)) {
    return null;
  }
  const [index, total] = value.split('/').map(Number);
  const shard = { index: index ?? Number.NaN, total: total ?? Number.NaN };
  return validCheckShard(shard) ? shard : null;
}

/**
 * Assign a category's whole work items in code-unit order. Only ownership is sorted: callers keep
 * their original iteration order and the full manifest each item needs to judge its follow-ups.
 */
export function keysInShard(
  keys: readonly string[],
  shard: CheckShard | undefined,
): ReadonlySet<string> {
  assertCheckShard(shard);
  return new Set(
    shard === undefined
      ? keys
      : keys.toSorted(compareCodeUnits).filter((_, at) => at % shard.total === shard.index - 1),
  );
}
