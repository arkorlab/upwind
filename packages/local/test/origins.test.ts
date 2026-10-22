import type { Route } from '@stayingupwind/core/bundle';
import { describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { originsOf } from '../src/parts.ts';

/** The rules of a build with none but `beforeFiles`, in the place Next.js writes a rewrite's. */
function routingOf(beforeFiles: readonly Route[]): Record<string, unknown> {
  return {
    beforeMiddleware: [],
    middlewareMatchers: [],
    beforeFiles,
    afterFiles: [],
    dynamicRoutes: [],
    onMatch: [],
    fallback: [],
  };
}

/**
 * A stack under `basePath` that holds `routes` alone, which is all the pages are picked from, and
 * `rules`, the build's rewrites before the filesystem.
 */
function stackWith(
  config: { readonly basePath: string; readonly trailingSlash: boolean },
  rules: readonly Route[],
  routes: readonly string[],
): CheckedStack {
  const stack = {
    site: new URL('https://site.example/'),
    bundle: { config, routing: routingOf(rules) },
    manifest: { routes: Object.fromEntries(routes.map((route) => [route, {}])) },
  };
  return stack as unknown as CheckedStack;
}

/** A stack under `basePath` that holds `routes` alone, which is all the pages are picked from. */
function stackUnder(
  config: { readonly basePath: string; readonly trailingSlash: boolean },
  ...routes: string[]
): CheckedStack {
  return stackWith(config, [], routes);
}

/** `/p01` to `/p12` beside the front page: more other pages than are asked from by place alone. */
const TWELVE = [
  '/',
  ...Array.from({ length: 12 }, (_, at) => `/p${String(at + 1).padStart(2, '0')}`),
];

/**
 * The pages `originsOf` picks, each by what a verdict and a request say of it: the path the router
 * names it by, its URL's, whether it is the page itself, and how a verdict says it.
 */
function pickedFor(stack: CheckedStack, page: string): readonly unknown[] {
  const picked = originsOf(stack, new URL(page, stack.site));
  return picked.map(({ path, url, itself, as }) => [path, url.pathname, itself, as]);
}

describe("the pages a router asks for a page's parts from", () => {
  it('picks another under the base path by its route, the router naming each without it', () => {
    const stack = stackUnder(
      { basePath: '/docs', trailingSlash: false },
      '/docs',
      '/docs/about',
      '/docs/shop',
    );

    // The front page where Next.js serves it, the page itself, and each other route — not the
    // page itself, nor the front page, under their deployed pathnames.
    expect(pickedFor(stack, '/docs/about')).toStrictEqual([
      ['/', '/docs', false, ''],
      ['/about', '/docs/about', true, ', from the page itself'],
      ['/shop', '/docs/shop', false, ', from /docs/shop'],
    ]);
  });

  it('asks from the front page under the base path with the trailing slash the build asks for', () => {
    const stack = stackUnder({ basePath: '/docs', trailingSlash: true }, '/docs/about');

    expect(pickedFor(stack, '/docs/about/')).toStrictEqual([
      ['/', '/docs/', false, ''],
      ['/about', '/docs/about/', true, ', from the page itself'],
    ]);
  });

  it('keeps every other concrete page in deterministic order', () => {
    const stack = stackUnder(
      { basePath: '', trailingSlash: false },
      '/target',
      '/b',
      '/[slug]',
      '/a',
      '/',
    );

    expect(pickedFor(stack, '/target')).toStrictEqual([
      ['/', '/', false, ''],
      ['/target', '/target', true, ', from the page itself'],
      ['/a', '/a', false, ', from /a'],
      ['/b', '/b', false, ', from /b'],
    ]);
  });

  it('keeps every other page when the target is the front page', () => {
    const stack = stackUnder({ basePath: '/docs', trailingSlash: false }, '/docs/b', '/docs/a');

    expect(pickedFor(stack, '/docs')).toStrictEqual([
      ['/', '/docs', true, ''],
      ['/a', '/docs/a', false, ', from /docs/a'],
      ['/b', '/docs/b', false, ', from /docs/b'],
    ]);
  });

  it('asks from the first other pages by their place alone where no rule tells pages apart', () => {
    const stack = stackUnder({ basePath: '', trailingSlash: false }, ...TWELVE);

    // Eight other pages, not eleven: every page asked from every other grows with their square.
    expect(originsOf(stack, new URL('/p01', stack.site)).map(({ path }) => path)).toStrictEqual([
      '/',
      '/p01',
      '/p02',
      '/p03',
      '/p04',
      '/p05',
      '/p06',
      '/p07',
      '/p08',
      '/p09',
    ]);
  });

  it('asks past them from each page a rule tells apart by the page a request comes from', () => {
    const rules: Route[] = [
      // As Next.js writes an intercepting route's rewrite: for the router on one page alone.
      {
        source: '/p01',
        sourceRegex: '^/p01$',
        destination: '/(.)p01',
        has: [{ type: 'header', key: 'Next-Url', value: '/p11' }],
      },
      // And a rule for a request that does not come from another.
      {
        sourceRegex: '^/p01$',
        destination: '/elsewhere',
        missing: [{ type: 'header', key: 'referer', value: '.*/p12' }],
      },
    ];
    const stack = stackWith({ basePath: '', trailingSlash: false }, rules, TWELVE);

    expect(pickedFor(stack, '/p01').slice(10)).toStrictEqual([
      ['/p11', '/p11', false, ', from /p11'],
      ['/p12', '/p12', false, ', from /p12'],
    ]);
  });

  it('asks from no page past them that a rule answers as one before it', () => {
    const rules: Route[] = [
      { sourceRegex: '^/p01$', has: [{ type: 'header', key: 'next-url', value: '/p1[0-2]' }] },
    ];
    const stack = stackWith({ basePath: '', trailingSlash: false }, rules, TWELVE);

    // `/p10` is the first the rule holds for; `/p11` and `/p12` are answered as it is.
    expect(pickedFor(stack, '/p01').slice(10)).toStrictEqual([
      ['/p10', '/p10', false, ', from /p10'],
    ]);
  });
});
