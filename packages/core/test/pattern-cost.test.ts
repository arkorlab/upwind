import { describe, expect, it } from 'vitest';

import { longestAffordable, type PatternCost, patternCost } from '../src/request/pattern-cost.ts';

/**
 * A repetition straight after a group each of whose repetitions ends with a delimiter that neither
 * can consume takes each segment once (`takesOneSegment`, `segmentScan`). It is read so only where
 * the stretches it takes from the group's stops cannot overlap; anywhere else it costs what any
 * other repetition does, tried from each of the group's stops.
 */

/** The redirects Next.js 16.4 writes for `trailingSlash: true`, as its adapter compiles them. */
const FILE_REDIRECT = String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/]+\.\w+))\/$`;
const PATH_REDIRECT = String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/\.]+))$`;
/** A class that names an astral character after a group whose repetitions end with one. */
const ASTRAL = '^(?:[^\u{1F600}]+\u{1F600})*[a\u{1F600}-\u{1F601}]+!$';

function costOf(source: string, flags = ''): PatternCost | undefined {
  return patternCost(source, flags, true);
}

describe('a repetition after a group of segments', () => {
  it('takes each segment once', () => {
    expect(costOf(String.raw`^(?:[^/]+\/)*[^/]+$`)?.degree).toBe(1);
    // With a fewest count of its own, and no most but the value's length.
    expect(costOf(String.raw`^(?:[^/]+\/)*[^/]{2,}!$`)?.degree).toBe(1);
    expect(costOf(PATH_REDIRECT, 'i')?.degree).toBe(1);
    // A file's: the extension is a repetition after the name's, which is all that is left.
    expect(costOf(FILE_REDIRECT, 'i')?.degree).toBe(2);
    expect(longestAffordable(costOf(FILE_REDIRECT, 'i'))).toBe(721);
  });

  it.each([
    // It can take the delimiter, and from each stop the rest of the value.
    String.raw`^(?:[^/]+\/)*.+!$`,
    // The group's repetitions begin with the delimiter, and it can stop inside a segment.
    String.raw`^(?:\/[^/]+)*[^/]+!$`,
    // A counted repetition, read as a choice among its counts.
    String.raw`^(?:[^/]+\/)*[^/]{1,100}!$`,
  ])('reads %s as tried from each of the group’s stops', (source) => {
    expect(costOf(source)?.degree).toBe(2);
  });

  it('reads one in a lookbehind, matched from its end backwards, as tried from each stop', () => {
    expect(costOf(String.raw`(?<=(?:[^/]+\/)*[^/]+)!`)?.degree).toBe(3);
  });

  it('leaves one that ends its context to that reading, which costs less', () => {
    // It can take nothing, and nothing after it has to match anything.
    expect(costOf(String.raw`x(?:[^/]+\/)*[^/]*`)).toStrictEqual({
      degree: 2,
      terms: [2.0625, 5.6875, 3.625],
    });
  });

  it('reads none so under `u`, where a surrogate pair is one character', () => {
    expect(costOf(String.raw`^(?:[^/]+\/)*[^/]+$`, 'u')?.degree).toBe(2);
    // The class takes the pair the group's repetitions end with, half of which it seems not to.
    expect(costOf(ASTRAL, 'u')?.degree).toBe(2);
  });
});
