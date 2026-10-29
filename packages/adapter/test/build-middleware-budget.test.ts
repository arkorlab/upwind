import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  BuildPatternBudget,
  BuildPatternBudgetExceededError,
} from '../../core/src/bundle/pattern-budget.ts';

/** Exercise the pinned generator, including 16.2.0's JSON-only payload grammar in the floor lane. */
const require = createRequire(process.env['UPWIND_MATCHER_NEXT_PACKAGE'] ?? import.meta.url);
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info.js') as {
  getMiddlewareMatchers: (source: string, config: Config) => { regexp: string }[];
};
interface Config {
  readonly basePath?: string;
  readonly i18n?: { readonly locales: readonly string[]; readonly defaultLocale: string };
}
const CONFIGS: readonly Config[] = [
  {},
  { basePath: '/base' },
  { i18n: { locales: ['en', 'ja'], defaultLocale: 'en' } },
  { basePath: '/base', i18n: { locales: ['en', 'ja'], defaultLocale: 'en' } },
  { basePath: '/é', i18n: { locales: ['en', 'ja'], defaultLocale: 'en' } },
];
const SOURCES = ['/:path*', '/docs/:path*', '/docs/:slug'];
const PREFIXES = [
  '',
  '/docs',
  '/en',
  '/en/docs',
  '/_next',
  '/_next/data/b',
  '/_next/data/b/en/docs',
];

/** Exhaust every string of up to three characters from a small delimiter alphabet. */
function suffixes(): string[] {
  const values = [''];
  let previous = [''];
  for (let depth = 0; depth < 3; depth += 1) {
    previous = previous.flatMap((prefix) => ['a', '/', '.', '#', '?'].map((part) => prefix + part));
    values.push(...previous);
  }
  return values;
}

const PATHS = [
  ...PREFIXES.flatMap((prefix) => suffixes().map((suffix) => prefix + suffix)),
  '/docs/a-normal-article-with-a-long-slug',
  '/en/docs/a-normal-article-with-a-long-slug',
  '/_next/',
  '/_next',
  '/en/_next/',
  '/_next/data/b/_next/',
  '/_next/data/b/en/docs/a.json',
  '/_next/data/b/en/docs/a.segments/x.segment.rsc/',
  '/_next/data/x#y.segments/a#b.segment.rsc',
  '/en/a.segments//b.segment.rsc',
  '/en/a.segments/b\nc.segment.rsc',
  '/en/a.segments/b\u{2028}c.segment.rsc',
  '/EN/DOCS/a.RSC',
  '/K/docs/a.rsc',
];

describe('build matching against pinned Next middleware grammar', () => {
  it('does not strip RSC or segment suffixes from the 16.2.0 JSON-only grammar', () => {
    const emitted = getMiddlewareMatchers('/docs/article', CONFIGS[2] ?? {})[0]?.regexp ?? '';
    const modern = String.raw`(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;
    const legacy = String.raw`(\.json)?[\/#\?]?$`;
    const source = emitted.split(modern).join(legacy);
    const paths = [
      '/en/docs/article',
      '/en/docs/article.json',
      '/en/docs/article.rsc',
      '/en/docs/article.RSC',
      '/en/docs/article.segments/x.segment.rsc',
      '/_next/data/b/en/docs/article.json',
      '/_next/data/b/en/docs/article.rsc',
    ];

    expect(paths.map((path) => new BuildPatternBudget().test(source, 'i', path))).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it.each(CONFIGS)('agrees with native matching for %j', (config) => {
    for (const source of SOURCES) {
      const emitted = getMiddlewareMatchers(source, config)[0]?.regexp;
      if (emitted === undefined) throw new Error('Next emitted no matcher');
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- Next's own emitted expression is the differential oracle.
      const native = new RegExp(emitted, 'i');
      for (const path of PATHS) {
        const value = `${config.basePath ?? ''}${path}`;
        const patterns = new BuildPatternBudget();

        expect(patterns.test(emitted, 'i', value), `${source}: ${JSON.stringify(value)}`).toBe(
          native.test(value),
        );
      }
    }
  });

  it('does not trust locale mismatch shortcuts before the complete head proof', () => {
    const emitted = getMiddlewareMatchers('/:path*', CONFIGS[2] ?? {})[0]?.regexp ?? '';
    const legacy = String.raw`(\.json)?[\/#\?]?$`;
    const tail = emitted.endsWith(legacy)
      ? legacy
      : String.raw`(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;
    const source = emitted.split(tail).join(`|^/_next/.*${tail}`);
    const path = `/_next/${'a'.repeat(200)}`;

    expect(() => new BuildPatternBudget().test(source, 'i', path)).toThrow(
      BuildPatternBudgetExceededError,
    );
  });

  it.each(['?', '*', '+', '{0,1}', '{1}', '{2}'])(
    'does not transform a quantified locale group (%s)',
    (quantifier) => {
      const emitted = getMiddlewareMatchers('/:path*', CONFIGS[2] ?? {})[0]?.regexp ?? '';
      const locale = String.raw`(?:\/((?!_next\/)[^/.]{1,}))`;
      const source = emitted.split(locale).join(locale + quantifier);
      const path = `/_next/${'a'.repeat(80)}`;

      expect(() => new BuildPatternBudget().test(source, 'i', path)).toThrow(
        BuildPatternBudgetExceededError,
      );
    },
  );
});
