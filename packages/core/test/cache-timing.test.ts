import { describe, expect, it } from 'vitest';

import {
  deadlineAfter,
  durationFromRevalidate,
  NEXT_ONE_YEAR_SECONDS,
  policyFromBuild,
  policyFromCacheControl,
  policyFromCacheControlHeader,
  policyUnknown,
  timingOf,
} from '../src/cache/timing.ts';

/** 2026-09-20T00:00:00Z */
const T0 = 1_789_862_400_000;
const MINUTE_MS = 60_000;
const SIXTY = 60;
const THREE_HUNDRED = 300;
const TWO_FORTY = 240;

describe('durations from what Next.js says', () => {
  it('keeps the three meanings of a revalidate apart', () => {
    expect(durationFromRevalidate(undefined)).toStrictEqual({ kind: 'unknown' });
    expect(durationFromRevalidate(false)).toStrictEqual({ kind: 'unbounded' });
    expect(durationFromRevalidate(SIXTY)).toStrictEqual({ kind: 'finite', seconds: SIXTY });
  });

  it('reads a build prerender: an expiration only next to a known revalidation', () => {
    expect(
      policyFromBuild({ initialRevalidate: SIXTY, initialExpiration: THREE_HUNDRED }),
    ).toStrictEqual({
      revalidateAfter: { kind: 'finite', seconds: SIXTY },
      expireAfter: { kind: 'finite', seconds: THREE_HUNDRED },
      clientStale: { kind: 'unknown' },
      source: 'build-output',
    });
    expect(policyFromBuild({ initialRevalidate: false })).toMatchObject({
      revalidateAfter: { kind: 'unbounded' },
      expireAfter: { kind: 'unbounded' },
    });
    // A record without the field says nothing: never "no expiry".
    expect(policyFromBuild({})).toMatchObject({
      revalidateAfter: { kind: 'unknown' },
      expireAfter: { kind: 'unknown' },
    });
  });

  it('reads the cache control the app page runtime hands over', () => {
    expect(
      policyFromCacheControl({ revalidate: SIXTY, expire: THREE_HUNDRED }, SIXTY),
    ).toStrictEqual({
      revalidateAfter: { kind: 'finite', seconds: SIXTY },
      expireAfter: { kind: 'finite', seconds: THREE_HUNDRED },
      clientStale: { kind: 'finite', seconds: SIXTY },
      source: 'runtime-output',
    });
    expect(policyFromCacheControl({ revalidate: false })).toMatchObject({
      revalidateAfter: { kind: 'unbounded' },
      expireAfter: { kind: 'unbounded' },
      clientStale: { kind: 'unknown' },
    });
  });

  it('reads the header a route handler or a Pages ISR response is sent with', () => {
    expect(
      policyFromCacheControlHeader(`s-maxage=${SIXTY}, stale-while-revalidate=${TWO_FORTY}`),
    ).toStrictEqual({
      revalidateAfter: { kind: 'finite', seconds: SIXTY },
      expireAfter: { kind: 'finite', seconds: SIXTY + TWO_FORTY },
      clientStale: { kind: 'unknown' },
      source: 'runtime-output',
    });
    expect(policyFromCacheControlHeader(`s-maxage=${NEXT_ONE_YEAR_SECONDS}`)).toMatchObject({
      revalidateAfter: { kind: 'unbounded' },
      expireAfter: { kind: 'unbounded' },
    });
    expect(policyFromCacheControlHeader(`S-MaxAge=${SIXTY}`)).toMatchObject({
      revalidateAfter: { kind: 'finite', seconds: SIXTY },
      expireAfter: { kind: 'unbounded' },
    });
  });

  it.each([
    null,
    undefined,
    '',
    'private, no-cache, no-store, max-age=0, must-revalidate',
    'public, max-age=0',
    's-maxage=soon',
    's-maxage=-1',
  ])('reads no policy from %j', (value) => {
    expect(policyFromCacheControlHeader(value)).toBeUndefined();
  });

  it('has an unknown policy that assumes nothing', () => {
    expect(policyUnknown()).toStrictEqual({
      revalidateAfter: { kind: 'unknown' },
      expireAfter: { kind: 'unknown' },
      clientStale: { kind: 'unknown' },
      source: 'legacy-unknown',
    });
  });
});

describe('deadlines', () => {
  it('follow from an origin and a duration, and are unknown when either is', () => {
    expect(deadlineAfter(T0, { kind: 'finite', seconds: SIXTY })).toStrictEqual({
      kind: 'at',
      unixMs: T0 + MINUTE_MS,
    });
    expect(deadlineAfter(T0, { kind: 'unbounded' })).toStrictEqual({ kind: 'never' });
    expect(deadlineAfter(T0, { kind: 'unknown' })).toStrictEqual({ kind: 'unknown' });
    expect(deadlineAfter(null, { kind: 'finite', seconds: SIXTY })).toStrictEqual({
      kind: 'unknown',
    });
  });

  it('are taken over the cache timestamp, never the time of a read or an index', () => {
    const timing = timingOf({
      cacheTimestamp: T0,
      producedAt: T0 + 1,
      policy: policyFromBuild({ initialRevalidate: SIXTY, initialExpiration: THREE_HUNDRED }),
    });

    expect(timing).toStrictEqual({
      cacheTimestamp: T0,
      producedAt: T0 + 1,
      revalidateAt: { kind: 'at', unixMs: T0 + SIXTY * 1000 },
      expireAt: { kind: 'at', unixMs: T0 + THREE_HUNDRED * 1000 },
    });
  });
});
