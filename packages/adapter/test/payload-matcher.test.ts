import { createRequire } from 'node:module';

import { beforeAll, describe, expect, it } from 'vitest';

import { matcherHolds } from '../../core/src/paas/payload-matcher.ts';
import {
  budgetPatterns,
  PatternBudgetExceededError,
} from '../../core/src/request/pattern-budget.ts';

/**
 * A middleware's matcher as Next.js 16.4 writes it — ending with the payloads a page has — tested a
 * part at a time where the edge would not test it whole. Whole, `/:locale/:path*`'s was allowed
 * against nine characters, and every longer request, a static file's among them, went to the
 * application's Function before the middleware.
 */

const require = createRequire(import.meta.url);
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info.js') as {
  getMiddlewareMatchers: (
    matchers: string[],
    config: { readonly basePath: string; readonly i18n: undefined },
  ) => { readonly regexp: string }[];
};

/** The matcher Next.js writes for `source`, compiled as the edge compiles it. */
function matcherOf(source: string): RegExp {
  const [matcher] = getMiddlewareMatchers([source], { basePath: '', i18n: undefined });
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- Next.js's own matchers, compiled as the edge compiles them: case-insensitive, without `u`
  return new RegExp(matcher?.regexp ?? '', 'i');
}

const SOURCES = [
  '/:locale/:path*',
  '/(de|en)/:path*',
  '/:locale/blog/:slug',
  '/account/:path*',
  '/blog/:slug',
  '/:path*',
];

const PATHS = [
  '/',
  '/en',
  '/en/',
  '/en/a',
  '/en/a/b',
  '/en/a/b.json',
  '/en/a.rsc',
  '/en/a.RSC',
  '/en/a/b.segments/x/y.segment.rsc',
  '/en/a.segments/b.segment.rsc',
  '/en/a.Segments/b.Segment.rsc',
  '/en/.segments/x.segment.rsc',
  '/en/a.segments/.segment.rsc',
  '/en/a.segments//b.segment.rsc',
  '/en/a.segments/b.segment.rsc/',
  '/en/a.segments/b.segment.rsc#',
  '/en/a.segments/b\nc.segment.rsc',
  '/en//a',
  '/en/a//b',
  '/en/blog/hello',
  '/en/blog/hello.json',
  '/_next/data/build/en/a.json',
  '/_next/static/immutable/chunks/0a1b2c3d4e5f.js',
  '/account',
  '/account/x',
  '/ACCOUNT/x.json',
  '/blog/hello',
  '/blog/hello.segments/__PAGE__.segment.rsc',
  '/blog/a/b',
];

describe('a matcher of Next.js 16.4, tested a part at a time', () => {
  beforeAll(() => {
    budgetPatterns();
  });

  it.each(SOURCES)('answers as the matcher Next.js writes for %s does', (source) => {
    const matcher = matcherOf(source);

    expect(PATHS.map((path) => [path, matcherHolds(matcher, path)])).toStrictEqual(
      PATHS.map((path) => [path, matcher.test(path)]),
    );
  });

  it("tests a static file's path that the matcher whole is not allowed against", () => {
    const matcher = matcherOf('/:locale/:path*');
    const file = `/_next/static/immutable/chunks/${'a'.repeat(512)}.js`;
    const nowhere = `/en/${'a.json/'.repeat(64)}x.js`;

    expect(matcherHolds(matcher, file)).toBe(true);
    expect(matcherHolds(matcher, nowhere)).toBe(true);
    expect(matcherHolds(matcherOf('/:locale/blog/:slug'), file)).toBe(false);
  });

  it("tests a static file's path that holds the matcher's literal where no match could reach it", () => {
    const matcher = matcherOf('/rewritten/:path*');
    // `/rewritten`, which a value without it is tested short of (`literalGate`), is here, but not
    // where the matcher could match it: the whole test is refused, and the head answers.
    const files = [
      `/assets/rewritten/${'a'.repeat(200)}.js`,
      `/_next/static/chunks/app/rewritten/${'b'.repeat(100)}.js`,
    ];

    expect(files.map((file) => matcherHolds(matcher, file))).toStrictEqual([false, false]);
    expect(matcherHolds(matcher, `/rewritten/${'c'.repeat(200)}`)).toBe(true);
  });

  it('answers yes where one way holds, though the head is not allowed against another', () => {
    const matcher = matcherOf('/:locale/:path*');
    // Too long for the head whole, and a segment that splits a short head off.
    const path = `/en/a.segments/${'x'.repeat(40_000)}.segment.rsc`;

    expect(matcherHolds(matcher, path)).toBe(true);
  });

  it('reads where a line terminator rules segments out once, however many places there are', () => {
    const matcher = matcherOf('/:locale/:path*');
    // Every segment's name would run past the line terminator, so none is one.
    const path = `/en/${'a.segments/'.repeat(100_000)}\nx.segment.rsc`;
    const started = performance.now();

    expect(() => matcherHolds(matcher, path)).toThrow(PatternBudgetExceededError);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses a path with more places a segment could begin than it splits', () => {
    const matcher = matcherOf('/:locale/:path*');

    expect(() => matcherHolds(matcher, `/en/${'a.segments/'.repeat(17)}x.segment.rsc`)).toThrow(
      PatternBudgetExceededError,
    );
  });

  it('does not split a matcher that reads past what it matches', () => {
    // `/:locale/:path*` with a lookahead in its first parameter, as an application could write it.
    const { source } = matcherOf('/:locale/:path*');
    const parameter = String.raw`(?:\/([^\/#\?]+?))`;
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- Next.js's own matcher with a lookahead put in, compiled as the edge compiles it
    const matcher = new RegExp(source.replace(parameter, String.raw`(?:\/((?!x)[^\/#\?]+?))`), 'i');

    expect(source).toContain(parameter);
    expect(() => matcherHolds(matcher, `/en/${'a/'.repeat(64)}`)).toThrow(
      PatternBudgetExceededError,
    );
  });
});
