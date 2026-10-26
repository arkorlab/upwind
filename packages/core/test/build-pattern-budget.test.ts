import { describe, expect, it, vi } from 'vitest';

import {
  completePrerenders,
  edgeServedRewrites,
  prerenderResponseHeaders,
} from '../src/bundle/build-serving.ts';
import { staticPagesMembersOf } from '../src/bundle/fallback-pages.ts';
import { filesystemPagesOf } from '../src/bundle/filesystem-pages.ts';
import {
  BuildPatternBudget,
  BuildPatternBudgetExceededError,
} from '../src/bundle/pattern-budget.ts';
import { staticPagesPrivacyOf } from '../src/bundle/static-pages.ts';
import { testWithin } from '../src/request/pattern-budget.ts';
import { MAX_NESTING } from '../src/request/pattern-cost.ts';
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

  it.each([MAX_NESTING + 1, 800])(
    'refuses payload heads nested %i levels before native matching',
    (depth) => {
      const suffix = String.raw`(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;
      const source = `^${'(?:'.repeat(depth)}a${')'.repeat(depth)}${suffix}`;
      const test = vi.spyOn(RegExp.prototype, 'test');
      const exec = vi.spyOn(RegExp.prototype, 'exec');
      try {
        expect(() => new BuildPatternBudget().test(source, 'i', 'a')).toThrow(
          BuildPatternBudgetExceededError,
        );
        expect(
          test.mock.contexts.filter(
            (pattern) => pattern instanceof RegExp && pattern.source === source,
          ),
        ).toHaveLength(0);
        expect(
          exec.mock.contexts.filter(
            (pattern) => pattern instanceof RegExp && pattern.source === source,
          ),
        ).toHaveLength(0);
      } finally {
        test.mockRestore();

        exec.mockRestore();
      }
    },
  );

  it('charges successive affordable matches to the operation, independently of other operations', () => {
    const patterns = new BuildPatternBudget(48);

    expect(patterns.test('^a$', '', 'a')).toBe(true);
    expect(() => {
      for (let count = 0; count < 48; count += 1) patterns.test('^a$', '', 'a');
    }).toThrow(BuildPatternBudgetExceededError);
    expect(new BuildPatternBudget(48).test('^a$', '', 'a')).toBe(true);
  });

  it('memoizes bounded boolean results without reusing them for captures or skipping lookup charges', () => {
    const patterns = new BuildPatternBudget(15_000);
    const source = '^a+a+!$';
    const value = 'a'.repeat(100);

    expect(patterns.test(source, '', value)).toBe(false);

    for (let repeat = 0; repeat < 10; repeat += 1)
      expect(patterns.test(source, '', value)).toBe(false);

    expect(() => patterns.exec(source, '', value)).toThrow(BuildPatternBudgetExceededError);
    expect(() => {
      for (let repeat = 0; repeat < 100; repeat += 1) patterns.test(source, '', value);
    }).toThrow(BuildPatternBudgetExceededError);
  });

  it('returns fresh mutable capture arrays from each execution', () => {
    const patterns = new BuildPatternBudget();
    const source = '^/(.+)$';
    const first = patterns.exec(source, '', '/one') ?? [];
    first[1] = 'changed';
    const second = patterns.exec(source, '', '/one');

    expect(second).not.toBe(first);
    expect(second?.[1]).toBe('one');
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

  it('passes the supplied matcher through generation rewrite analysis', () => {
    const bundle = fixtureBundle();
    bundle.staticFiles = bundle.staticFiles.map((file) => {
      return {
        ...file,
        blob: { ...file.blob, byteLength: 100_000_000 },
      };
    });
    bundle.routing.beforeMiddleware = [{ sourceRegex: '^/earlier$', destination: '/elsewhere' }];
    bundle.routing.beforeFiles = [
      { source: '/alias', sourceRegex: '^/alias$', destination: '/hello.txt' },
    ];
    const patterns = { test: vi.fn(() => false), exec: vi.fn(() => null) };
    completePrerenders(bundle, patterns);

    expect(patterns.test).toHaveBeenCalledWith('^/earlier$', 'i', '/alias');
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
