import { describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { originsOf } from '../src/parts.ts';

/** A stack under `basePath` that holds `routes` alone, which is all the pages are picked from. */
function stackUnder(
  config: { readonly basePath: string; readonly trailingSlash: boolean },
  ...routes: string[]
): CheckedStack {
  const stack = {
    site: new URL('https://site.example/'),
    bundle: { config },
    manifest: { routes: Object.fromEntries(routes.map((route) => [route, {}])) },
  };
  return stack as unknown as CheckedStack;
}

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

    // The front page where Next.js serves it, the page itself, and the first other route — not the
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
});
