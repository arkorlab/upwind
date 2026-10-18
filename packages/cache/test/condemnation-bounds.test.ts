import { describe, expect, it } from 'vitest';

import type { InvalidationRow } from '../src/scope/rows.ts';
import { condemnationOf } from '../src/scope/tags.ts';

const LARGE_HISTORY = 150_000;

function invalidation(
  revision: number,
  staleAt: number,
  hardExpireAt: number | null,
): InvalidationRow {
  return {
    invalidation_id: `invalidation-${revision}`,
    revision,
    target_kind: 'tag',
    target_id: 'shared',
    target_value: 'shared',
    stale_at: staleAt,
    hard_expire_at: hardExpireAt,
    meaning: 'swr',
    expire_seconds: null,
    cause: '{}',
    recorded_at: 1,
  };
}

describe('the bounds of the invalidations a generation is published under', () => {
  it('leaves an untouched generation without a condemnation', () => {
    expect(condemnationOf([])).toBeNull();
  });

  it('keeps the latest revision and earliest moments across unsorted tags', () => {
    const rows = [invalidation(8, 30, 70), invalidation(2, 10, null), invalidation(5, 20, 50)];

    expect(condemnationOf(rows)).toStrictEqual({ revision: 8, staleAt: 10, hardExpireAt: 50 });
    expect(condemnationOf(rows.toReversed())).toStrictEqual({
      revision: 8,
      staleAt: 10,
      hardExpireAt: 50,
    });
  });

  it('omits the hard deadline when every invalidation leaves it open', () => {
    expect(condemnationOf([invalidation(3, 4, null), invalidation(1, 2, null)])).toStrictEqual({
      revision: 3,
      staleAt: 2,
    });
  });

  it('keeps a zero hard deadline beside open and later deadlines', () => {
    expect(
      condemnationOf([invalidation(1, 4, null), invalidation(2, 3, 9), invalidation(3, 2, 0)]),
    ).toStrictEqual({ revision: 3, staleAt: 2, hardExpireAt: 0 });
  });

  it.each([null, 500])(
    'aggregates a retained history with a %s hard deadline without call expansion',
    (hardExpireAt) => {
      // Reuse equal row objects to exercise the argument count without a second large fixture graph.
      const repeated = invalidation(2, 100, hardExpireAt);
      const rows = Array.from({ length: LARGE_HISTORY }, () => repeated);
      rows[0] = invalidation(1, 1, hardExpireAt);
      rows[LARGE_HISTORY / 2] = invalidation(LARGE_HISTORY + 1, 80, hardExpireAt);
      rows[LARGE_HISTORY - 1] = invalidation(3, 90, hardExpireAt === null ? null : 200);

      expect(condemnationOf(rows)).toStrictEqual({
        revision: LARGE_HISTORY + 1,
        staleAt: 1,
        ...(hardExpireAt !== null && { hardExpireAt: 200 }),
      });
    },
  );
});
