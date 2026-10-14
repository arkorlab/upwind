import { describe, expect, it } from 'vitest';

import { builtNameOf } from '../src/manifest/built-names.ts';
import { routeRequestPathOf } from '../src/manifest/page-keys.ts';

/**
 * The path a request asks for a route by (`routeRequestPathOf`), as the edge finds the route: a
 * member by its built name, a page of its own by its name as it is, and none where no request
 * reaches it.
 */

/** A manifest whose routes are `keys`, under a catch-all at `/docs`, with `own` its own pages. */
function manifestOf(keys: readonly string[], own: readonly string[] = []) {
  return {
    routes: Object.fromEntries(keys.map((key) => [key, true])),
    dynamicRoutes: [{ sourceRegex: '^/docs/(.+?)(?:/)?$' }],
    filesystemPages: Object.fromEntries(own.map((page) => [page, true as const])),
  };
}

/** The path a URL holds once `path`, a path a request asks by, is written into it. */
function asked(path: string | undefined): string {
  if (path === undefined) {
    throw new Error('no path a request asks by');
  }
  return new URL(path, 'https://app.test').pathname;
}

describe('the path a request asks for a route by', () => {
  it('asks for a member by its built name, its escaped slash kept', () => {
    const manifest = manifestOf(['/docs/space here/with%2Fslash/100%']);
    const path = routeRequestPathOf(manifest, '/docs/space here/with%2Fslash/100%');

    expect(asked(path)).toBe('/docs/space%20here/with%2Fslash/100%25');
    expect(builtNameOf(asked(path))).toBe('/docs/space here/with%2Fslash/100%');
  });

  /**
   * A page of its own is named by its path as it is: a `%2F` in it is a `%` and a `2F`, which a
   * request asks by escaped whole, where read as a member's escaped `/` it asks for another page.
   */
  it('asks for a page of its own by its name as it is, an escape in it escaped', () => {
    const manifest = manifestOf(['/a%2F?'], ['/a%2F?']);

    expect(asked(routeRequestPathOf(manifest, '/a%2F?'))).toBe('/a%252F%3F');
  });

  /** Next.js finds a page of its own ahead of a member, for every path that names the member. */
  it('names no path for a member a page of its own shadows', () => {
    const manifest = manifestOf(['/docs/a/b', '/docs/a%2Fb'], ['/docs/a/b']);

    expect(routeRequestPathOf(manifest, '/docs/a%2Fb')).toBeUndefined();
    expect(asked(routeRequestPathOf(manifest, '/docs/a/b'))).toBe('/docs/a/b');
  });

  it('names no path for a route no request reaches', () => {
    const manifest = manifestOf(['/docs/..', '//other.example']);

    expect(routeRequestPathOf(manifest, '/docs/..')).toBeUndefined();
    expect(routeRequestPathOf(manifest, '//other.example')).toBeUndefined();
  });
});
