import { createRequire } from 'node:module';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { middlewareApplies } from '../../core/src/paas/middleware.ts';
import { matcherHolds } from '../../core/src/paas/payload-matcher.ts';
import {
  budgetPatterns,
  createPatternBudget,
  type PatternBudget,
  PatternBudgetExceededError,
} from '../../core/src/request/pattern-budget.ts';

/**
 * A middleware's matcher as Next.js 16.4 writes it — ending with the payloads a page has — tested a
 * part at a time where the edge would not test it whole. Whole, `/:locale/:path*`'s was allowed
 * against nine characters, and every longer request, a static file's among them, went to the
 * application's Function before the middleware.
 */

const require = createRequire(process.env['UPWIND_MATCHER_NEXT_PACKAGE'] ?? import.meta.url);
interface Config {
  readonly basePath?: string;
  readonly i18n?: { readonly locales: readonly string[]; readonly defaultLocale: string };
}
interface MatcherInput {
  readonly source: string;
  readonly locale?: false;
  readonly has?: {
    readonly type: 'header';
    readonly key: string;
    readonly value: string;
  }[];
  readonly missing?: {
    readonly type: 'cookie';
    readonly key: string;
    readonly value: string;
  }[];
}
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info.js') as {
  getMiddlewareMatchers: (
    matchers: readonly (string | MatcherInput)[],
    config: Config,
  ) => {
    readonly regexp: string;
    readonly has?: MatcherInput['has'];
    readonly missing?: MatcherInput['missing'];
  }[];
};

function emittedMatcher(source: string | MatcherInput, config: Config) {
  const [matcher] = getMiddlewareMatchers([source], config);
  if (matcher === undefined) throw new Error('Next emitted no matcher');
  return matcher;
}

/** The matcher Next.js writes for `source`, compiled as the edge compiles it. */
function matcherOf(source: string | MatcherInput, config: Config = {}): RegExp {
  const matcher = emittedMatcher(source, config);
  // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- Next.js's own matchers, compiled as the edge compiles them: case-insensitive, without `u`
  return new RegExp(matcher.regexp, 'i');
}

const SOURCES = [
  '/:locale/:path*',
  '/(de|en)/:path*',
  '/:locale/blog/:slug',
  '/account/:path*',
  '/blog/:slug',
  '/:path*',
];

const I18N = { locales: ['en', 'ja'], defaultLocale: 'en' };
const CONFIGS: readonly Config[] = [
  {},
  { basePath: '/base' },
  { i18n: I18N },
  { basePath: '/base', i18n: I18N },
  { basePath: '/é', i18n: I18N },
];
const requestScope: { current: PatternBudget | undefined } = { current: undefined };

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
    budgetPatterns(() => requestScope.current);
  });

  afterEach(() => {
    requestScope.current = undefined;
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

  it.each(CONFIGS)(
    'agrees with Next locale matching for %j within each request budget',
    (config) => {
      const paths = [
        ...PATHS,
        '/en/account/profile',
        '/ja/docs/a-normal-article-with-a-long-slug',
        '/_next/',
        '/_next',
        '/en/_next/',
        '/_next/data/b/_next/',
        '/_next/data/b/en/docs/article.json',
        '/_next/data/b/en/docs/a.segments/x.segment.rsc/',
        '/_next/data/x#y.segments/a#b.segment.rsc',
        '/en/a.segments/b\u{2028}c.segment.rsc',
        '/EN/DOCS/a.RSC',
        '/K/docs/a.rsc',
        '/en/docs/hello%20world',
      ];
      for (const source of ['/:path*', '/docs/:path*', '/docs/:slug']) {
        for (const input of [source, { source, locale: false as const }]) {
          const matcher = matcherOf(input, config);
          for (const path of paths) {
            requestScope.current = createPatternBudget();
            const value = `${config.basePath ?? ''}${path}`;

            expect(matcherHolds(matcher, value), `${source}: ${JSON.stringify(value)}`).toBe(
              matcher.test(value),
            );
          }
        }
      }
    },
  );

  it('keeps header and cookie conditions beside the locale matcher', () => {
    const emitted = emittedMatcher(
      {
        source: '/docs/:path*',
        has: [{ type: 'header', key: 'x-preview', value: 'enabled' }],
        missing: [{ type: 'cookie', key: 'disabled', value: '1' }],
      },
      { basePath: '/base', i18n: I18N },
    );
    const matchers = [{ sourceRegex: emitted.regexp, has: emitted.has, missing: emitted.missing }];
    const url = new URL('https://example.test/base/en/docs/a-normal-article-with-a-long-slug');
    const headers = [
      new Headers({ 'x-preview': 'enabled' }),
      new Headers(),
      new Headers({ 'x-preview': 'enabled', cookie: 'disabled=1' }),
    ];

    expect(headers.map((value) => middlewareApplies(matchers, url, value))).toStrictEqual([
      true,
      false,
      false,
    ]);
  });

  it('charges a conclusive locale mismatch to the shared request budget', () => {
    const matcher = matcherOf('/:path*', { i18n: I18N });
    const path = '/_next/static/chunks/example.js';
    requestScope.current = { remaining: 1400 };

    expect(matcherHolds(matcher, path)).toBe(false);
    expect(requestScope.current.remaining).toBeLessThan(1400);
    expect(() => matcherHolds(matcher, path)).toThrow(PatternBudgetExceededError);
  });

  it('does not use a locale mismatch before proving the complete remaining grammar', () => {
    const { source } = matcherOf('/:path*', { i18n: I18N });
    const tail = String.raw`(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- Next's expression with an alternative outside its locale guard
    const matcher = new RegExp(source.split(tail).join(`|^/_next/.*${tail}`), 'i');

    expect(() => matcherHolds(matcher, `/_next/${'a'.repeat(200)}`)).toThrow(
      PatternBudgetExceededError,
    );
  });

  it.each(['?', '*', '+', '{0,1}', '{1}', '{2}'])(
    'does not resolve a quantified locale assertion (%s)',
    (quantifier) => {
      const { source } = matcherOf('/:path*', { i18n: I18N });
      const locale = String.raw`(?:\/((?!_next\/)[^/.]{1,}))`;
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- malformed variants of Next's known guard must stay unsupported
      const matcher = new RegExp(source.split(locale).join(locale + quantifier), 'i');

      expect(() => matcherHolds(matcher, `/_next/${'a'.repeat(80)}`)).toThrow(
        PatternBudgetExceededError,
      );
    },
  );
});
