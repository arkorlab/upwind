import { describe, expect, it } from 'vitest';

import { evaluateFreshness } from '../src/cache/freshness.ts';
import { type CachePolicy, policyFromBuild, policyUnknown } from '../src/cache/timing.ts';

/** 2026-09-20T00:00:00Z */
const T0 = 1_789_862_400_000;
const SECOND_MS = 1000;
const SIXTY = 60;
const THREE_HUNDRED = 300;
const REVALIDATE_MS = SIXTY * SECOND_MS;
const EXPIRE_MS = THREE_HUNDRED * SECOND_MS;
const TEN = 10;

const policy: CachePolicy = policyFromBuild({
  initialRevalidate: SIXTY,
  initialExpiration: THREE_HUNDRED,
});
const forever: CachePolicy = policyFromBuild({ initialRevalidate: false });

describe('freshness by time', () => {
  it('is fresh until the revalidate deadline has passed, exactly as Next.js compares', () => {
    expect(evaluateFreshness({ policy, cacheTimestamp: T0, now: T0 })).toMatchObject({
      validity: 'fresh',
      cause: 'none',
      revalidateAt: { kind: 'at', unixMs: T0 + REVALIDATE_MS },
      expireAt: { kind: 'at', unixMs: T0 + EXPIRE_MS },
    });
    expect(
      evaluateFreshness({ policy, cacheTimestamp: T0, now: T0 + REVALIDATE_MS }).validity,
    ).toBe('fresh');
    expect(
      evaluateFreshness({ policy, cacheTimestamp: T0, now: T0 + REVALIDATE_MS + 1 }),
    ).toMatchObject({ validity: 'stale', cause: 'time' });
  });

  it('is stale up to the expire deadline and expired past it', () => {
    expect(evaluateFreshness({ policy, cacheTimestamp: T0, now: T0 + EXPIRE_MS }).validity).toBe(
      'stale',
    );
    expect(
      evaluateFreshness({ policy, cacheTimestamp: T0, now: T0 + EXPIRE_MS + 1 }),
    ).toMatchObject({ validity: 'expired', cause: 'time' });
  });

  it('counts from the cache timestamp, not from the last time anyone asked', () => {
    // A long gap changes nothing about where the deadlines are.
    const late = evaluateFreshness({ policy, cacheTimestamp: T0, now: T0 + EXPIRE_MS - 1 });

    expect(late.validity).toBe('stale');
    expect(late.revalidateAt).toStrictEqual({ kind: 'at', unixMs: T0 + REVALIDATE_MS });
  });

  it('never goes stale on time alone when the route has no time-based revalidation', () => {
    const result = evaluateFreshness({
      policy: forever,
      cacheTimestamp: T0,
      now: T0 + EXPIRE_MS * TEN,
    });

    expect(result).toStrictEqual({
      validity: 'fresh',
      cause: 'none',
      revalidateAt: { kind: 'never' },
      expireAt: { kind: 'never' },
    });
  });

  it('is unknown, not fresh, when the lifetime or the origin was never recorded', () => {
    expect(
      evaluateFreshness({ policy: policyUnknown(), cacheTimestamp: T0, now: T0 }),
    ).toStrictEqual({
      validity: 'unknown',
      cause: 'unknown',
      revalidateAt: { kind: 'unknown' },
      expireAt: { kind: 'unknown' },
    });
    expect(evaluateFreshness({ policy, cacheTimestamp: null, now: T0 })).toMatchObject({
      validity: 'unknown',
      cause: 'unknown',
    });
  });
});

describe('freshness by invalidation', () => {
  it('is stale from the moment a tag was invalidated after the generation was made', () => {
    const result = evaluateFreshness({
      policy,
      cacheTimestamp: T0,
      invalidation: { revision: 1, staleAt: T0 + TEN },
      now: T0 + TEN + 1,
    });

    expect(result).toMatchObject({
      validity: 'stale',
      cause: 'invalidation',
      // The effective deadline is the earlier of the lifetime's and the invalidation's.
      revalidateAt: { kind: 'at', unixMs: T0 + TEN },
      expireAt: { kind: 'at', unixMs: T0 + EXPIRE_MS },
    });
  });

  it('keeps a generation condemned on arrival stale, though the record predates its stamp', () => {
    // The invalidation landed while the render ran, so the authority published the generation
    // already condemned; the commit that stamped it came after. Whether the invalidation reached
    // this generation is the authority's judgement, not one to be re-derived from two clocks.
    const result = evaluateFreshness({
      policy,
      cacheTimestamp: T0,
      invalidation: { revision: 1, staleAt: T0 - 1, hardExpireAt: T0 + EXPIRE_MS },
      now: T0 + 1,
    });

    expect(result).toMatchObject({
      validity: 'stale',
      cause: 'invalidation',
      revalidateAt: { kind: 'at', unixMs: T0 - 1 },
    });
  });

  it('is expired once a hard expiry has arrived, and stale until then', () => {
    const invalidation = { revision: 2, staleAt: T0 + 1, hardExpireAt: T0 + TEN };

    expect(
      evaluateFreshness({ policy, cacheTimestamp: T0, invalidation, now: T0 + TEN - 1 }),
    ).toMatchObject({ validity: 'stale', expireAt: { kind: 'at', unixMs: T0 + TEN } });
    expect(
      evaluateFreshness({ policy, cacheTimestamp: T0, invalidation, now: T0 + TEN }),
    ).toMatchObject({ validity: 'expired', cause: 'invalidation' });
  });

  it('cuts a lifetime that would otherwise never end', () => {
    const result = evaluateFreshness({
      policy: forever,
      cacheTimestamp: T0,
      invalidation: { revision: 3, staleAt: T0 + 1, hardExpireAt: T0 + TEN },
      now: T0 + 1,
    });

    expect(result).toMatchObject({
      validity: 'stale',
      revalidateAt: { kind: 'at', unixMs: T0 + 1 },
      expireAt: { kind: 'at', unixMs: T0 + TEN },
    });
  });

  it('applies to a generation whose origin is not recorded', () => {
    expect(
      evaluateFreshness({
        policy: policyUnknown(),
        cacheTimestamp: null,
        invalidation: { revision: 4, staleAt: T0, hardExpireAt: T0 },
        now: T0,
      }),
    ).toMatchObject({ validity: 'expired', cause: 'invalidation' });
  });
});
