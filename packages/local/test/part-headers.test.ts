import {
  type FreshnessInput,
  policyFromCacheControl,
  policyUnknown,
} from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import { cacheStatesWithin, type Within } from '../src/part-headers.ts';
import { HIT, STALE } from '../src/part-marks.ts';

type RecordedFreshness = Omit<FreshnessInput, 'now'>;

interface Example {
  readonly label: string;
  readonly freshness: RecordedFreshness;
  readonly within: Within;
  readonly states: readonly string[];
}

function timed(revalidate: number | false, expire: number | undefined): RecordedFreshness {
  return { cacheTimestamp: 0, policy: policyFromCacheControl({ revalidate, expire }) };
}

// The request at 10s has a clock allowance from 8s through 12s.
const CROSSES_DEADLINES: Within = { from: 10_000, to: 10_000 };
const examples: readonly Example[] = [
  {
    label: 'includes stale between fresh and expired ends',
    freshness: timed(9, 11),
    within: CROSSES_DEADLINES,
    states: [HIT, STALE],
  },
  {
    label: 'does not invent stale before revalidation',
    freshness: timed(9, 11),
    within: { from: 3000, to: 3000 },
    states: [HIT],
  },
  {
    label: 'keeps an entirely stale window',
    freshness: timed(5, 15),
    within: CROSSES_DEADLINES,
    states: [STALE],
  },
  {
    label: 'permits no mark after expiry',
    freshness: timed(9, 11),
    within: { from: 14_000, to: 14_000 },
    states: [],
  },
  {
    label: 'is still fresh exactly at revalidation',
    freshness: timed(9, 11),
    within: { from: 5000, to: 7000 },
    states: [HIT],
  },
  {
    label: 'is stale exactly at time expiry',
    freshness: timed(9, 11),
    within: { from: 13_000, to: 13_000 },
    states: [STALE],
  },
  {
    label: 'is expired exactly at a hard expiry',
    freshness: { ...timed(9, 11), invalidation: { revision: 1, hardExpireAt: 11_000 } },
    within: { from: 13_000, to: 13_000 },
    states: [],
  },
  {
    label: 'includes the sole integer stale instant at time expiry',
    freshness: timed(9, 9.001),
    within: CROSSES_DEADLINES,
    states: [HIT, STALE],
  },
  {
    label: 'rejects a fractional-only stale gap before hard expiry',
    freshness: { ...timed(9, 11), invalidation: { revision: 1, hardExpireAt: 9001 } },
    within: CROSSES_DEADLINES,
    states: [HIT],
  },
  {
    label: 'does not add stale when time revalidation and expiry coincide',
    freshness: timed(9, 9),
    within: CROSSES_DEADLINES,
    states: [HIT],
  },
  {
    label: 'does not round a submillisecond stale gap into an observation',
    freshness: timed(9.00025, 9.00075),
    within: CROSSES_DEADLINES,
    states: [HIT],
  },
  {
    label: 'includes an integer stale instant after fractional revalidation',
    freshness: timed(9.00025, 9.001),
    within: CROSSES_DEADLINES,
    states: [HIT, STALE],
  },
  {
    label: 'clips revalidation after an earlier hard expiry',
    freshness: { ...timed(9, 11), invalidation: { revision: 1, hardExpireAt: 8500 } },
    within: CROSSES_DEADLINES,
    states: [HIT],
  },
  {
    label: 'retains the core judgement when a recorded invalidation makes it stale',
    freshness: {
      ...timed(9, 11),
      invalidation: { revision: 1, staleAt: 20_000, hardExpireAt: 11_000 },
    },
    within: CROSSES_DEADLINES,
    states: [STALE],
  },
  {
    label: 'keeps unknown timing serveable without asserting stale',
    freshness: { cacheTimestamp: null, policy: policyUnknown() },
    within: CROSSES_DEADLINES,
    states: [HIT],
  },
  {
    label: 'keeps an unbounded generation fresh without a time-based stale phase',
    freshness: timed(false, undefined),
    within: CROSSES_DEADLINES,
    states: [HIT],
  },
  {
    label: 'does not turn an overflowed nonfinite revalidation into an observation',
    freshness: timed(Number.MAX_VALUE, undefined),
    within: CROSSES_DEADLINES,
    states: [HIT],
  },
];

describe('the cache marks a runtime part can have during its request', () => {
  it.each(examples)('$label', ({ freshness, within, states }) => {
    expect([...cacheStatesWithin(freshness, within)]).toStrictEqual(states);
  });
});
