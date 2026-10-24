import { beforeAll, describe, expect, it } from 'vitest';

import { anyConditionHolds } from '../src/request/conditions.ts';
import {
  budgetPatterns,
  execWithin,
  PatternBudgetExceededError,
  testWithin,
} from '../src/request/pattern-budget.ts';
import {
  literalGate,
  longestAffordable,
  type PatternCost,
  patternCost,
} from '../src/request/pattern-cost.ts';
import {
  unsafeRoutePatternReason,
  unsafeSourcePatternReason,
} from '../src/request/pattern-safety.ts';

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

/**
 * The edge runs every application's routing patterns against values their visitors chose, on one
 * Function they share, and V8 cannot interrupt a match it has begun. So a test is bounded before it
 * is run: by the degree of the polynomial its pattern backtracks in, read off the pattern's shape,
 * and the value's length. What it must not do is read a pattern as cheaper than it is — and what it
 * should not do is read Next.js's own routes as anything but linear, which would leave ordinary
 * requests to the Function.
 */

/** Two repetitions that take what the other does, tried at every place: cubic in the value. */
const CUBIC = String.raw`\w+\w+!`;
/** A repetition, then one that takes the rest of a line: quadratic, unless the value is one line. */
const UNTIL_A_LINE_ENDS = '^(?:a+.*)$';
const UNBOUNDED = 'its cost against a value cannot be bounded within what a test is allowed';
/**
 * The matcher Next.js 16.4 writes for a middleware's `/rewritten/:path*`: the catch-all's segments
 * can each hold a `.`, and end before the payloads a page has, or run into them — cubic, read whole.
 */
const CATCH_ALL_MATCHER = String.raw`^(?:\/(_next\/data\/[^/]{1,}))?\/rewritten(?:\/((?:[^\/#\?]+?)(?:\/(?:[^\/#\?]+?))*))?(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;
/**
 * Choices that can each match nothing, and a character none of them matches: one attempt tries
 * every way the choices can match nothing before it fails, which is all of them, and twenty-four of
 * them take seconds in V8 against an empty value.
 */
function nothingChoices(count: number): string {
  return `${'(?:a?|b?)'.repeat(count)}!`;
}

function degreeOf(source: string, flags = '', lineFree = true): number | undefined {
  return patternCost(source, flags, lineFree)?.degree;
}

/** The longest value of no line terminator a test of the pattern is allowed against. */
function affordable(source: string, flags = ''): number {
  return longestAffordable(patternCost(source, flags, true));
}

/** A pattern as the edge holds one: compiled from the string an application wrote. */
function compiled(source: string, flags = 'u'): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- the costly shapes under test
  return new RegExp(source, flags);
}

describe('patternCost', () => {
  it.each([
    // A dynamic route: its parameter is forced by the slash after it, or by the end.
    String.raw`^\/blog(?:\/([^\/]+?))(?:\/)?$`,
    '^[/]?/(?<nxtPlocale>[^/]+?)/blog/(?<nxtPslug>[^/]+?)(?:/)?$',
    // Catch-alls, required and optional.
    String.raw`^\/docs(?:\/(.+?))(?:\/)?$`,
    String.raw`^\/shop(?:\/(.+?))?(?:\/)?$`,
    // `:path*`, a repetition its delimiter splits.
    String.raw`^(?:\/((?:[^\/#\?]+?)(?:\/(?:[^\/#\?]+?))*))?(?:\/)?$`,
    // A middleware's matcher: a lookahead, a `.*` that takes the rest, and optional parts after it.
    String.raw`^(?:\/(_next\/data\/[^/]{1,}))?(?:\/((?!api\/|_next\/|ingest\/|_vercel\/|.*\..*).*))(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`,
    // An image pattern's `**`: a dot no `.` or `..` segment begins, repeated.
    String.raw`^(?:\/images(?:\/(?!\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)|$))$`,
    // The redirect of `trailingSlash: true` for a path that names no file: its last segment after
    // a group of segments, each of which ends at a slash neither can take.
    PATH_REDIRECT,
  ])('reads Next.js’s own %s as linear', (source) => {
    expect(degreeOf(source, 'i')).toBe(1);
    expect(affordable(source, 'i')).toBeGreaterThan(4096);
  });

  it.each([
    // Repetitions side by side, each of which can take what the other does.
    ['^(?:.*.*.*.*!)$', 4],
    [String.raw`^(?:\w+\w+!)$`, 2],
    // Tried from every place in the value: one more.
    [CUBIC, 3],
    ['a+b', 2],
    ['.*Mobile.*', 2],
    ['^(?:.*Mobile.*)$', 1],
    ['a*a*a*a*a*b', 6],
  ])('reads %s as of degree %d', (source, degree) => {
    expect(degreeOf(source)).toBe(degree);
  });

  /**
   * The redirects of `trailingSlash: true` take a path's last segment after a group of segments:
   * from each place the group stops, the repetition takes no more than the value holds before the
   * next slash, so all of them together take the value once. Read as a repetition from each of
   * those places, the redirect for a file's path was cubic, and a path of 63 characters cost half
   * of what a request is allowed.
   */

  it('reads the literal every match of a pattern passes through, and what comes before it', () => {
    const gate = literalGate(CATCH_ALL_MATCHER, 'i', true);

    expect(degreeOf(CATCH_ALL_MATCHER, 'i')).toBe(3);
    expect(gate?.literal).toBe('/rewritten');
    expect(gate?.cost?.degree).toBe(1);
    // Read in lower case under `i`, and as written otherwise.
    expect(literalGate(String.raw`^\/Blog\/[^/]+$`, 'i', true)?.literal).toBe('/blog/');
    expect(literalGate(String.raw`^\/Blog\/[^/]+$`, '', true)?.literal).toBe('/Blog/');
  });

  it.each([
    // No character of its own at the top of the pattern: every one of them is in a group.
    String.raw`^(?:\/((?:[^\/#\?]+?)(?:\/(?:[^\/#\?]+?))*))?(?:\/)?$`,
    // More than one alternative, each with its own.
    String.raw`^\/a\w+\w+!|^\/b\w+\w+!`,
    // A character `i` folds to others past ASCII that lower case does not (`ς` and `σ`).
    String.raw`^\/ς\w+\w+!`,
  ])('reads no literal gate of %s', (source) => {
    expect(literalGate(source, 'i', true)).toBeUndefined();
  });

  it('reads a repetition that ends the match, and nothing else, as one scan', () => {
    // It can take nothing, and nothing after it has to match anything.
    expect(degreeOf(String.raw`(?<id>\d*)`)).toBe(1);
    expect(degreeOf('Bearer .*')).toBe(1);
    // A `.*` before a `$` takes the rest of a value with no line terminator, and not of one with.
    expect(degreeOf(UNTIL_A_LINE_ENDS)).toBe(1);
    expect(degreeOf(UNTIL_A_LINE_ENDS, '', false)).toBe(2);
    // A lookbehind is matched from its end backwards: no repetition in it ends anything.
    expect(degreeOf('(?<=a+.*)b')).toBeGreaterThan(degreeOf('(?=a+.*)b') ?? 0);
  });

  it('reads a choice among a few counts as a constant, not a degree', () => {
    expect(degreeOf('^(?:[a-z]{2})$')).toBe(0);
    expect(degreeOf(String.raw`^(?:\d{2,4})$`)).toBe(0);
    expect(affordable(String.raw`^(?:\d{2,4})$`)).toBe(Infinity);
    expect(degreeOf('^(?:a{1,1000})$')).toBe(1);
  });

  it('counts what a counted quantifier takes each time it is reached', () => {
    // Tried from every place in a run of letters, each of these takes 64 of them there.
    const once = affordable('[a-z]{64}0');
    const fifteen = affordable(`${'[a-z]{64}'.repeat(15)}0`);

    expect(once).toBeLessThan(8192);
    expect(fifteen).toBeLessThan(once / 10);
  });

  it('counts each part of a long pattern each time it is reached', () => {
    const long = `(?:${'a'.repeat(400)}|${'a'.repeat(399)}b)c`;

    expect(degreeOf(long)).toBe(1);
    expect(affordable(long)).toBeLessThan(16_384);
    expect(affordable('(?:ab|ac)d')).toBeGreaterThan(131_072);
  });

  it('reads alternatives no two of which begin alike as one way on', () => {
    // Twenty choices in a row: a million ways where each can take what the other does, one where not.
    expect(affordable(`^(?:${'(?:a|b)'.repeat(20)})$`)).toBe(Infinity);
    expect(affordable(`^(?:${'(?:a|a)'.repeat(20)})$`)).toBe(-1);
  });

  it('reads a lookaround that holds wherever it can match nothing as matching nothing', () => {
    // Positive, and with an alternative that can match nothing: what comes before it ends there.
    expect(degreeOf('.*(?=a?)')).toBe(1);
    // Negative, it holds only where its alternatives do not, which is nowhere here.
    expect(degreeOf('.*(?!a?)')).toBe(2);
  });

  it('reads nothing of groups nested deeper than any route’s', () => {
    expect(patternCost(`^${'(?:'.repeat(1000)}a${')'.repeat(1000)}$`, '', true)).toBeUndefined();
    expect(degreeOf(`^${'(?:'.repeat(8)}a+${')'.repeat(8)}b$`)).toBe(1);
  });

  it('reads a lookbehind as matched backwards, where nothing after a repetition stops it', () => {
    expect(degreeOf('(?<=[^/]+/a*)x')).toBe(3);
    expect(degreeOf('(?=[^/]+/a*)x')).toBe(2);
  });

  it.each(['m', 'v', 'iu'])('reads nothing under the flags %s', (flags) => {
    expect(patternCost('a', flags, true)).toBeUndefined();
  });

  it.each([
    String.raw`(a)\1`,
    String.raw`(?<a>a)\k<a>`,
    '(?=a)*b',
    '(a+)+',
    '(a|aa)+',
    '(?i:a)',
    // Twenty repetitions side by side: no value of two characters is short enough.
    `${'a*'.repeat(20)}b`,
  ])('reads nothing of %s', (source) => {
    expect(patternCost(source, '', true)).toBeUndefined();
    expect(affordable(source)).toBe(-1);
  });

  it('reads the braces no quantifier begins as the characters they are', () => {
    expect(degreeOf('^(?:(a+){two})$')).toBe(1);
    expect(degreeOf('^(?:a]b})$')).toBe(0);
  });

  /**
   * Tried anywhere, a pattern is tried from each place in the value and from its end, so an empty
   * value is tried once — and a pattern whose one attempt is the expensive part costs that there.
   */
  it('charges the attempt made from the end of the value, which an empty value has', () => {
    expect(affordable(nothingChoices(12))).toBe(-1);
    expect(affordable(nothingChoices(8))).toBeGreaterThan(0);
    // An ordinary pattern barely moves: the attempt from the end is one more of many.
    expect(affordable('a+b')).toBeGreaterThan(700);
  });

  it('allows a value as long as its cost affords', () => {
    expect(longestAffordable({ degree: 0, terms: [1000] })).toBe(Infinity);
    expect(longestAffordable({ degree: 2, terms: [0, 0, 1] })).toBe(724);
    expect(longestAffordable({ degree: 3, terms: [0, 0, 0, 1] })).toBe(80);
    expect(longestAffordable({ degree: 0, terms: [2 ** 30] })).toBe(-1);
  });
});

describe('a bounded test', () => {
  beforeAll(() => {
    budgetPatterns();
  });

  it('runs a test whose cost against the value is within what a test is allowed', () => {
    const longest = 'a'.repeat(affordable(CUBIC));

    expect(testWithin(compiled(CUBIC), longest)).toBe(false);
    expect(execWithin(compiled('^/blog/([^/]+)$'), '/blog/post')?.[1]).toBe('post');
  });

  it('refuses one whose cost is past it, without running it', () => {
    const started = performance.now();

    expect(() => testWithin(compiled(CUBIC), 'a'.repeat(4096))).toThrow(PatternBudgetExceededError);
    expect(() => testWithin(compiled(String.raw`(a)\1`), 'a')).toThrow(PatternBudgetExceededError);
    // Run, the first of these takes tens of seconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses a test of an empty value whose one attempt is past what a test is allowed', () => {
    const started = performance.now();

    expect(() => testWithin(compiled(nothingChoices(24)), '')).toThrow(PatternBudgetExceededError);
    // Run, this takes seconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  /**
   * A static file's path, against the matcher of a middleware's `/rewritten/:path*`: a test of it
   * stops at `/rewritten`, which the path does not hold, and so is no more than what comes before.
   * Read as the whole pattern costs, it was refused past a few dozen characters, and the file was
   * handed to the application's Function, which has no static file to serve.
   */
  it('tests a value that does not hold the literal every match passes through', () => {
    const pattern = compiled(CATCH_ALL_MATCHER, 'i');
    const file = `/_next/static/immutable/chunks/${'a'.repeat(4096)}.js`;
    const data = `/_next/data/b/${'a'.repeat(4096)}.json`;

    expect(testWithin(pattern, file)).toBe(false);
    expect(testWithin(pattern, data)).toBe(false);
    expect(testWithin(pattern, '/rewritten/a/b.rsc')).toBe(true);
  });

  it('holds a value that does to what the whole pattern costs, in either case', () => {
    const pattern = compiled(CATCH_ALL_MATCHER, 'i');
    const segments = 'a.segments/'.repeat(8);

    expect(() => testWithin(pattern, `/rewritten/${segments}`)).toThrow(PatternBudgetExceededError);
    expect(() => testWithin(pattern, `/ReWritten/${segments}`)).toThrow(PatternBudgetExceededError);
  });

  it('holds a value that does not to what comes before the literal, however costly that is', () => {
    // Cubic before its literal: a value without it is tested against all of that.
    const pattern = compiled(String.raw`\w+\w+!gate.*`);

    expect(() => testWithin(pattern, 'a'.repeat(4096))).toThrow(PatternBudgetExceededError);
  });

  it('reads a value with a line terminator as one `.` does not take whole', () => {
    const pattern = compiled(UNTIL_A_LINE_ENDS);

    expect(() => testWithin(pattern, 'a'.repeat(4096))).not.toThrow();
    expect(() => testWithin(pattern, `${'a'.repeat(4096)}\n`)).toThrow(PatternBudgetExceededError);
  });

  it('matches a value spelled as the condition is written, with no test to make', () => {
    // Eight repetitions side by side, tried whole: a test affords a value of a few characters.
    const written = 'a*a*a*a*a*a*a*a*!';
    const condition = { type: 'header' as const, key: 'x-written', value: written };
    const url = new URL('https://example.com/');

    expect(anyConditionHolds([condition], url, new Headers({ 'x-written': written }))).toBe(true);
  });

  it('lets a condition the edge does not run be no answer at all, rather than no match', () => {
    const condition = { type: 'header' as const, key: 'x-crafted', value: CUBIC };
    const url = new URL('https://example.com/');
    const crafted = new Headers({ 'x-crafted': 'a'.repeat(4096) });

    expect(() => anyConditionHolds([condition], url, crafted)).toThrow(PatternBudgetExceededError);
    expect(anyConditionHolds([condition], url, new Headers({ 'x-crafted': 'abc!' }))).toBe(true);
  });
});

describe('the upload', () => {
  it('refuses a pattern the edge could run against no value', () => {
    expect(unsafeRoutePatternReason(String.raw`(a)\1`)).toBe(UNBOUNDED);
    expect(unsafeSourcePatternReason(String.raw`^(a)\1$`)).toBe(UNBOUNDED);
    expect(unsafeSourcePatternReason(`^(?:${'(?:a|a)'.repeat(20)})$`)).toBe(UNBOUNDED);
  });

  it('refuses a source whose cost cannot be bounded where it runs without regard to case', () => {
    // Twenty choices in a row that one spelling tells apart, and `i` does not.
    const folded = '(?:a|A)'.repeat(20);

    expect(unsafeSourcePatternReason(`^(?:${folded})$`)).toBe(UNBOUNDED);
    // A condition runs as it is written.
    expect(unsafeRoutePatternReason(folded)).toBeUndefined();
  });

  it('refuses a source tried anywhere whose one attempt is past what a test is allowed', () => {
    expect(unsafeSourcePatternReason(nothingChoices(12))).toBe(UNBOUNDED);
  });

  it('refuses a pattern nested past what is read, rather than throwing', () => {
    expect(unsafeSourcePatternReason(`^${'(?:'.repeat(1000)}a${')'.repeat(1000)}$`)).toBe(
      UNBOUNDED,
    );
  });

  it('admits one of a degree the edge runs against shorter values only', () => {
    expect(unsafeRoutePatternReason('.*.*.*.*!')).toBeUndefined();
    expect(unsafeRoutePatternReason(CUBIC)).toBeUndefined();
  });
});
