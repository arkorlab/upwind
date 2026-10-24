import { describe, expect, it } from 'vitest';

// Not through `@stayingupwind/adapter`: it is a build-time package, and the Workers that gate on
// the range must not carry it. Read the declaration where it is written instead.
import { SUPPORTED_NEXT_RANGE as ADAPTER_RANGE } from '../../adapter/src/patches/versions.ts';
import {
  nextSupportOf,
  nextVersionSupported,
  SUPPORTED_NEXT_RANGE,
} from '../src/next-support/next-support.ts';

/**
 * What a host admits is what the adapter can deploy.
 *
 * The adapter's range is the one that means something: `scripts/check-patches.ts` applies the
 * patches that reach Next.js's own package to every published release in it and fails on the first
 * that does not fire, and `tools/next-matrix` holds the four that rewrite what `next build` writes
 * to a real build. This gate restates that range as a tuple, and a restatement is only as good as
 * what holds it in place.
 *
 * On 2026-09-27 nothing did. The gate read `16.2.0` to `17.0.0` — the Adapter API's own history —
 * and a build on 16.2.10 was let through: the app compiled, the Turbopack patch met a shape it did
 * not know, and the build failed at the end, after the install and the compile. It reads the same again now that the adapter builds 16.2, and what 16.2
 * gets of a host is less than 16.3 does: `nextSupportOf` says how much.
 */

/** Versions as Next.js publishes them: releases on either side of the range, and canaries. */
const PUBLISHED = [
  '15.5.4',
  '16.0.10',
  '16.1.9',
  '16.2.0',
  '16.2.12',
  '16.3.0',
  '16.3.8',
  '16.4.0',
  '16.4.2',
  '16.2.0-canary.0',
  '16.3.0-canary.1',
  '16.4.0-canary.48',
  '16.5.0-canary.12',
  '17.0.0-canary.0',
] as const;

const RANGE = /^>=(?<min>\d+\.\d+\.\d+) <(?<max>\d+)$/u;

/** The adapter's range as this contract spells one: `>=16.2.0 <17` to two tuples. */
function tuples(range: string): { min: number[]; max: number[] } {
  const groups = RANGE.exec(range)?.groups;
  if (groups === undefined) {
    throw new Error(`the adapter's range is written some other way now: ${range}`);
  }
  return {
    min: (groups['min'] ?? '').split('.').map(Number),
    max: [Number(groups['max']), 0, 0],
  };
}

describe('the Next.js versions a host admits', () => {
  it('is the range the adapter declares, restated', () => {
    const { min, max } = tuples(ADAPTER_RANGE);

    expect(SUPPORTED_NEXT_RANGE.min).toStrictEqual(min);
    expect(SUPPORTED_NEXT_RANGE.max).toStrictEqual(max);
  });

  /** The floor, its neighbour below, where full support starts, and the ceiling. */
  it.each([
    ['16.1.9', 'unsupported'],
    ['16.2.0', 'limited'],
    ['16.2.10', 'limited'],
    ['16.3.0', 'full'],
    ['16.3.6', 'full'],
    /** A prerelease of a version in the range is that version: the tuple is its first three. */
    ['16.3.0-canary.1', 'full'],
    ['16.4.0-canary.1', 'full'],
    ['17.0.0', 'unsupported'],
    ['nonsense', 'unsupported'],
  ] as const)('%s → %s', (version, support) => {
    expect(nextSupportOf(version)).toBe(support);
    expect(nextVersionSupported(version)).toBe(support !== 'unsupported');
  });

  /**
   * A semantic version's prerelease and build are read as the release they are numbered as, and
   * nothing else after the patch is a version at all.
   */
  it.each([
    ['16.2.0-canary.5', 'limited'],
    ['16.3.0-rc.1+build.7', 'full'],
    ['16.3.0+build.7', 'full'],
    ['16.1.9-canary.1', 'unsupported'],
    ['17.0.0-canary.0', 'unsupported'],
    ['16.3.0junk', 'unsupported'],
    ['16.2.0junk', 'unsupported'],
    ['16.3.0 ', 'unsupported'],
    ['16.3.0-', 'unsupported'],
    ['16.3.0+', 'unsupported'],
    ['16.3.0-canary..1', 'unsupported'],
    ['16.3.0-canary_1', 'unsupported'],
    ['16.3.0-rc.1+build+7', 'unsupported'],
  ] as const)('%j → %s', (version, support) => {
    expect(nextSupportOf(version)).toBe(support);
    expect(nextVersionSupported(version)).toBe(support !== 'unsupported');
  });

  /** Every version Next.js publishes is read as it was before other trailing text was refused. */
  it.each(PUBLISHED)('reads %s as the release it is numbered as', (version) => {
    const release = /^\d+\.\d+\.\d+/u.exec(version)?.[0] ?? '';

    expect(nextSupportOf(version)).toBe(nextSupportOf(release));
  });
});
