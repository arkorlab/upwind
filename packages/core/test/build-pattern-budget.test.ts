import { describe, expect, it } from 'vitest';

import { staticPagesMembersOf } from '../src/bundle/fallback-pages.ts';
import { filesystemPagesOf } from '../src/bundle/filesystem-pages.ts';
import {
  BuildPatternBudget,
  BuildPatternBudgetExceededError,
} from '../src/bundle/pattern-budget.ts';
import { edgeServedRewrites, prerenderResponseHeaders } from '../src/bundle/serving.ts';
import { staticPagesPrivacyOf } from '../src/bundle/static-pages.ts';
import { testWithin } from '../src/request/pattern-budget.ts';
import { fallbackBundle } from './fallback-pages-fixtures.ts';
import { fixtureBundle, staticPrerender } from './fixtures/bundle.ts';

const SOURCE = '^/a*a*a*a*!$';
const PATHNAME = `/${'a'.repeat(200)}b`;

describe('explicit build pattern allowances', () => {
  it('retains flags, captures, and the missing-literal shortcut', () => {
    const patterns = new BuildPatternBudget();

    expect(patterns.exec('^/(?<slug>[^/]+)$', 'i', '/Foo')?.groups?.['slug']).toBe('Foo');
    expect(patterns.test('^/literal/a*a*a*a*!$', 'i', PATHNAME)).toBe(false);
  });

  it('charges successive affordable matches to the operation, independently of other operations', () => {
    const patterns = new BuildPatternBudget(48);

    expect(patterns.test('^a$', '', 'a')).toBe(true);
    expect(() => {
      for (let count = 0; count < 48; count += 1) patterns.test('^a$', '', 'a');
    }).toThrow(BuildPatternBudgetExceededError);
    expect(new BuildPatternBudget(48).test('^a$', '', 'a')).toBe(true);
  });

  it('refuses header folding, rewrite analysis, and filesystem classification without enabling request budgets', () => {
    const bundle = fixtureBundle();
    const page = { ...staticPrerender(), pathname: PATHNAME };
    bundle.routing.beforeMiddleware = [{ sourceRegex: SOURCE, headers: { 'x-example': 'value' } }];

    expect(() => prerenderResponseHeaders(bundle, page)).toThrow(BuildPatternBudgetExceededError);

    bundle.routing.beforeMiddleware = [{ sourceRegex: SOURCE, destination: '/elsewhere' }];
    bundle.staticFiles = bundle.staticFiles.map((file) => {
      return {
        ...file,
        blob: { ...file.blob, byteLength: 100_000_000 },
      };
    });
    bundle.routing.beforeFiles = [
      { source: PATHNAME, sourceRegex: '^/literal$', destination: '/hello.txt' },
    ];

    expect(() => edgeServedRewrites(bundle)).toThrow(BuildPatternBudgetExceededError);

    bundle.entrypoints = [{ id: 'page', pathname: PATHNAME, kind: 'app-page' }];

    expect(() => filesystemPagesOf(bundle, [{ sourceRegex: SOURCE }])).toThrow(
      BuildPatternBudgetExceededError,
    );
    // An unbounded but cheap non-match still runs in the application's own default mode.
    expect(testWithin(/(a)\1/u, 'aa')).toBe(true);
  });

  it('keeps runtime privacy defaults and explicit build contexts separate', () => {
    const bundle = fallbackBundle();
    const patterns = new BuildPatternBudget(1);

    expect(() => staticPagesMembersOf(bundle, patterns)).toThrow(BuildPatternBudgetExceededError);
    expect(() => staticPagesMembersOf(bundle, patterns)).toThrow(BuildPatternBudgetExceededError);
    expect(staticPagesMembersOf(bundle).size).toBe(1);

    const privacy = fixtureBundle();
    privacy.staticPagesPrivacy = 1;

    expect(() => staticPagesPrivacyOf(privacy, new BuildPatternBudget(1))).toThrow(
      BuildPatternBudgetExceededError,
    );
  });
});
