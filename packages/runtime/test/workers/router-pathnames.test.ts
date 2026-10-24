import { resolveRoutes, type Route } from '@next/routing';
import type { ImagesConfig } from '@stayingupwind/core/images';
import { describe, expect, it } from 'vitest';

import { prerenderedName } from '../../src/name-spellings.ts';
import { askedOf, landedRoute, pathnamesFor, resolvedOf } from '../../src/routing.ts';
import { routerPathnames, type Store } from '../../src/store.ts';

/**
 * The pathnames the router resolves by name, for an application that keeps its pages under a
 * trailing slash.
 *
 * With `trailingSlash: true` Next.js redirects `/docs/hello` to `/docs/hello/`, and its filesystem
 * check takes the slash off again before it looks for a page (`getItem`). `@next/routing` looks a
 * pathname up as it came. Offered each page under its own name alone, it found none of them where
 * the application keeps them: the base path's home answered 404, and `/docs/hello/` went to the
 * one dynamic route that would take it, a `[slug]` page rendering a slug of `hello`.
 */

const BASE_PATH = '/docs';
const SLUG_ROUTE = {
  sourceRegex: '^/docs[/]?/(?<nxtPslug>[^/]+?)(?:/)?$',
  destination: '/docs/[slug]?nxtPslug=$nxtPslug',
};
const NO_BLOB = { sha256: '0'.repeat(64), byteLength: 1, contentType: 'text/html' };

function manifestOf(trailingSlash: boolean): Parameters<typeof routerPathnames>[0] {
  return {
    config: {
      basePath: BASE_PATH,
      trailingSlash,
      skipTrailingSlashRedirect: false,
      poweredByHeader: true,
    },
    entrypoints: [
      { id: '/docs', kind: 'pages', pathname: '/docs' },
      { id: '/docs/gssp', kind: 'pages', pathname: '/docs/gssp' },
      { id: '/docs/[slug]', kind: 'pages', pathname: '/docs/[slug]' },
      {
        id: '/docs/_next/data/b/gssp.json',
        kind: 'pages',
        pathname: '/docs/_next/data/b/gssp.json',
      },
      { id: '/docs/api/hello', kind: 'pages-api', pathname: '/docs/api/hello' },
    ],
    prerenders: [],
    // A page with no data is a file of the build, as `public/` files are.
    staticFiles: [
      { pathname: '/docs/hello', blob: NO_BLOB, immutable: false },
      { pathname: '/docs/robots.txt', blob: NO_BLOB, immutable: false },
    ],
  };
}

describe('the pathnames the router resolves by name', () => {
  it('offers each page under its spelling with a trailing slash as well', () => {
    const { pathnames, slashSpellings } = routerPathnames(manifestOf(true));

    expect([...slashSpellings]).toStrictEqual([
      ['/docs/', '/docs'],
      ['/docs/gssp/', '/docs/gssp'],
      ['/docs/api/hello/', '/docs/api/hello'],
      ['/docs/hello/', '/docs/hello'],
    ]);
    expect(pathnames).toStrictEqual(expect.arrayContaining([...slashSpellings.keys()]));
  });

  /**
   * A page's props the build wrote under the base path: offered by name, as they are without one.
   * Not offered, every data request of an application under a base path answered 404.
   */
  it('offers a data route the build wrote under the base path by its name', () => {
    const data = '/docs/_next/data/b/gsp/first.json';
    const manifest = {
      ...manifestOf(false),
      prerenders: [
        {
          id: data,
          pathname: data,
          route: '/docs/gsp/[post]',
          parentOutputId: '/docs/gsp/[post]',
          groupId: 1,
        },
      ],
    };

    expect(routerPathnames(manifest).pathnames).toContain(data);
  });

  it('offers a page under its own name alone when the application keeps it there', () => {
    const { pathnames, slashSpellings } = routerPathnames(manifestOf(false));

    expect(slashSpellings.size).toBe(0);
    expect(pathnames.filter((pathname) => pathname.endsWith('/'))).toStrictEqual([]);
  });

  it.each([
    ['the home under the base path', '/docs/', '/docs'],
    ['a page the build wrote as a file', '/docs/hello/', '/docs/hello'],
    ['a page rendered on request', '/docs/gssp/', '/docs/gssp'],
    ['a member of the dynamic route, still', '/docs/first/', '/docs/[slug]'],
  ])('resolves %s where the application keeps it', async (_label, path, page) => {
    const { pathnames, slashSpellings } = routerPathnames(manifestOf(true));

    const routed = await resolveRoutes({
      url: new URL(`https://docs.example${path}`),
      buildId: 'b',
      basePath: BASE_PATH,
      requestBody: new ReadableStream(),
      headers: new Headers(),
      pathnames,
      routes: {
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [SLUG_ROUTE],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: true,
      },
      invokeMiddleware: () => Promise.resolve({}),
    });
    const route = routed.resolvedPathname;

    expect(route === undefined ? undefined : (slashSpellings.get(route) ?? route)).toBe(page);
  });
});

/**
 * A store as the Worker builds one from its manifest, as much of it as a route is looked up in: its
 * rewrites are `afterFiles`, and its other tables are empty.
 */
function storeOf(
  manifest: Parameters<typeof routerPathnames>[0],
  afterFiles: readonly Route[] = [],
): Store {
  return {
    manifest: {
      ...manifest,
      routing: { beforeMiddleware: [], beforeFiles: [], afterFiles, fallback: [] },
    },
    prerendersByPathname: new Map(
      manifest.prerenders.map((prerender) => [prerender.pathname, prerender]),
    ),
    staticFiles: new Map(manifest.staticFiles.map((file) => [file.pathname, file])),
    ...routerPathnames(manifest),
  } as unknown as Store;
}

/** `manifest` with files of the build at `pathnames` as well. */
function withFiles(
  manifest: Parameters<typeof routerPathnames>[0],
  pathnames: readonly string[],
): Parameters<typeof routerPathnames>[0] {
  const files = pathnames.map((pathname) => ({ pathname, blob: NO_BLOB, immutable: false }));
  return { ...manifest, staticFiles: [...manifest.staticFiles, ...files] };
}

/**
 * A store with the member `/docs/a%2Fb` of `/docs/[slug]` (the value `a/b`), the member `/docs/c/d`
 * of `/docs/[...parts]`, and the prerender of the page `/docs/gssp`.
 */
function escapedSlashStore(): Store {
  return storeOf({
    ...manifestOf(false),
    prerenders: [
      {
        id: '/docs/a%2Fb',
        pathname: '/docs/a%2Fb',
        route: '/docs/[slug]',
        parentOutputId: '/docs/[slug]',
        groupId: 1,
        parentFallbackMode: false,
      },
      {
        id: '/docs/c/d',
        pathname: '/docs/c/d',
        route: '/docs/[...parts]',
        parentOutputId: '/docs/[...parts]',
        groupId: 2,
        parentFallbackMode: false,
      },
      {
        id: '/docs/gssp',
        pathname: '/docs/gssp',
        route: '/docs/gssp',
        parentOutputId: '/docs/gssp',
        groupId: 3,
        parentFallbackMode: false,
      },
    ],
  });
}

/** The names the router is offered for a request for `path`. */
function offeredTo(store: Store, path: string): string[] {
  return pathnamesFor(store, new URL(`https://docs.example${path}`));
}

/** The route a request for `path`, resolved by that spelling, is looked up as. */
function lookedUpIn(store: Store, path: string): string {
  return resolvedOf(store, path, { pathname: path, query: {} }, asked(path)).route;
}

function asked(path: string): { url: URL; rewrite: undefined } {
  return { url: new URL(`https://docs.example${path}`), rewrite: undefined };
}

/**
 * Next.js names what it builds without a trailing slash, the pages of an application that keeps
 * them under one included, and so are the shells and generations the Worker keeps of them. A member
 * of a dynamic route asked for with the slash was looked up with it, found none of them, and was
 * rendered whole on every request.
 */
describe('what a resolved route is looked up as', () => {
  it.each([
    {
      label: 'a member of a dynamic route',
      route: '/docs/[slug]',
      path: '/docs/first/',
      expected: { route: '/docs/[slug]', pathname: '/docs/first' },
    },
    {
      label: 'a page under its spelling with the slash',
      route: '/docs/gssp/',
      path: '/docs/gssp/',
      expected: { route: '/docs/gssp', pathname: '/docs/gssp' },
    },
    {
      label: 'the home under the base path',
      route: '/docs/',
      path: '/docs/',
      expected: { route: '/docs', pathname: '/docs' },
    },
  ])(
    'looks $label up as the build named it, and hands the handler the URL asked for',
    ({ route, path, expected }) => {
      const resolved = resolvedOf(
        storeOf(manifestOf(true)),
        route,
        { pathname: path, query: {} },
        asked(path),
      );

      expect(resolved).toStrictEqual({ ...expected, url: path });
    },
  );

  /**
   * A member of a route built with `fallback: false` resolves by its own name, which names no
   * entrypoint; the route it was built from is the page whose handler takes the URL asked for.
   */
  it('hands a member of a closed route the URL a rewrite was asked by, as it hands its route', () => {
    const manifest = manifestOf(true);
    const closed = {
      ...manifest,
      entrypoints: [
        ...manifest.entrypoints,
        { id: '/docs/closed/[id]', kind: 'pages' as const, pathname: '/docs/closed/[id]' },
      ],
      prerenders: [
        {
          id: '/docs/closed/a',
          pathname: '/docs/closed/a',
          route: '/docs/closed/[id]',
          parentOutputId: '/docs/closed/[id]',
          groupId: 1,
          parentFallbackMode: false,
        },
      ],
    };

    const resolved = resolvedOf(
      storeOf(closed),
      '/docs/closed/a',
      { pathname: '/docs/closed/a', query: {} },
      asked('/docs/alias'),
    );

    expect(resolved.url).toBe('/docs/alias');
  });

  /**
   * A middleware's rewrite to a Pages Router route is none its handler can apply again: it is
   * handed the path asked for with the query routing ended on — what the middleware added, and the
   * route's parameters, which the handler takes from there and leaves out of `req.url`. Handed the
   * destination, a Pages API route said `/api/proxy/bar` where Next.js deployed says the path the
   * client asked for (`middleware-rewrites`).
   */
  it('hands a Pages route the path asked for, with the query a middleware rewrite ended on', () => {
    const resolved = resolvedOf(
      storeOf(manifestOf(false)),
      '/docs/[slug]',
      { pathname: '/docs/first', query: { key: 'value', added: '1', nxtPslug: 'first' } },
      {
        url: new URL('https://docs.example/docs/alias?key=value'),
        rewrite: new URL('https://docs.example/docs/first?key=value&added=1'),
      },
    );

    expect(resolved.url).toBe('/docs/alias?key=value&added=1&nxtPslug=first');
  });

  /**
   * An App Router route reads the URL the client asked for as its own: a page renders it as its
   * canonical URL, which `usePathname` says, and a route handler's request is at it. Handed the
   * destination of a `next.config` rewrite, a page said `/hooks/use-pathname` where Next.js says
   * `/rewritten-use-pathname` (`app-dir/hooks`).
   */
  it.each([
    { kind: 'app-page' as const, route: '/docs/canonical' },
    { kind: 'app-route' as const, route: '/docs/api/canonical' },
  ])('hands an App Router $kind the URL a rewrite was asked by', ({ kind, route }) => {
    const manifest = manifestOf(false);
    const app = {
      ...manifest,
      entrypoints: [...manifest.entrypoints, { id: route, kind, pathname: route }],
    };

    const resolved = resolvedOf(
      storeOf(app),
      route,
      { pathname: route, query: { from: 'destination' } },
      asked('/docs/alias?asked=1'),
    );

    expect(resolved.url).toBe('/docs/alias?asked=1');
  });

  /**
   * The rewrite an App Router route applies again puts the dynamic route's parameters in the query
   * its `searchParams` are, and takes out again only those it was handed as `nxtP…`: without them
   * a page's `searchParams` said its `params` too (`app-dir/rewrite-with-search-params`). The
   * query asked for stays as it was spelled.
   */
  it("hands an App Router page the route's parameters after the query a rewrite was asked by", () => {
    const manifest = manifestOf(false);
    const route = '/docs/[domain]/[...section]';
    const app = {
      ...manifest,
      entrypoints: [
        ...manifest.entrypoints,
        { id: route, kind: 'app-page' as const, pathname: route },
      ],
    };

    const resolved = resolvedOf(
      storeOf(app),
      route,
      {
        pathname: '/docs/vercel-test/galleries/123',
        query: { param: 'a b', nxtPdomain: 'vercel-test', nxtPsection: 'galleries/123' },
      },
      asked('/docs/galleries/123?param=a%20b'),
    );

    expect(resolved.url).toBe(
      '/docs/galleries/123?param=a%20b&nxtPdomain=vercel-test&nxtPsection=galleries%2F123',
    );
  });

  /** The handler reads the locale off the path it is handed: a rewrite into another one keeps it. */
  it('hands the path asked for in the locale a middleware rewrote it to', () => {
    const manifest = manifestOf(false);
    const localized = {
      ...manifest,
      config: { ...manifest.config, i18n: { defaultLocale: 'en', locales: ['en', 'es'] } },
    };
    const resolved = resolvedOf(
      storeOf(localized),
      '/docs/[slug]',
      { pathname: '/docs/es/first', query: { nxtPslug: 'first' } },
      {
        url: new URL('https://docs.example/docs/country'),
        rewrite: new URL('https://docs.example/docs/es/first'),
      },
    );

    expect(resolved.url).toBe('/docs/es/country?nxtPslug=first');
  });

  /** The edge that ran the middleware sends the request on to the rewrite, and says what was asked. */
  it('takes the URL asked for from the edge, where the edge ran the middleware', () => {
    const rewritten = new Request('https://docs.example/docs/first?added=1', {
      headers: { 'x-arkor-original-url': '/docs/alias' },
    });
    const plain = new Request('https://docs.example/docs/first');

    expect(
      askedOf(rewritten, 'https://docs.example/docs/alias', new URL(rewritten.url), undefined),
    ).toStrictEqual({
      url: new URL('https://docs.example/docs/alias'),
      rewrite: new URL('https://docs.example/docs/first?added=1'),
    });
    expect(askedOf(plain, plain.url, new URL(plain.url), undefined)).toStrictEqual({
      url: new URL(plain.url),
      rewrite: undefined,
    });
  });

  /**
   * Next.js names a prerendered member by its parameters' own characters and a request carries
   * them escaped; its filesystem check looks the path up decoded as well. Looked up as it came, a
   * member of a route built with `dynamicParams = false` was no member at all, and answered 404.
   */
  it('looks a member asked for escaped up by the name its prerender was given', () => {
    const manifest = manifestOf(false);
    const named = {
      ...manifest,
      prerenders: ['/docs/sticks & stones', '/docs/記事', '/docs/100%25'].map((pathname) => {
        return {
          id: pathname,
          pathname,
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 1,
          parentFallbackMode: false,
        };
      }),
    };
    const lookedUp = (path: string): string => {
      return resolvedOf(storeOf(named), '/docs/[slug]', { pathname: path, query: {} }, asked(path))
        .pathname;
    };

    expect(lookedUp('/docs/sticks%20%26%20stones')).toBe('/docs/sticks & stones');
    expect(lookedUp('/docs/sticks%20&%20stones')).toBe('/docs/sticks & stones');
    expect(lookedUp('/docs/%E8%A8%98%E4%BA%8B')).toBe('/docs/記事');
    // A name the build gave with an escape in it is found as it came, before anything is decoded.
    expect(lookedUp('/docs/100%25')).toBe('/docs/100%25');
    // One that names no prerender either way, or does not decode, is left as it came.
    expect(lookedUp('/docs/not%20built')).toBe('/docs/not%20built');
    expect(lookedUp('/docs/%E8%A8')).toBe('/docs/%E8%A8');
  });

  /**
   * A member of a route built with `dynamicParams = false` resolves by its own name alone, and the
   * router matches the names it is handed as they are: asked for escaped, it resolved to nothing,
   * and answered 404 (`prerender-encoding`).
   */
  it('resolves a member of a closed route asked for escaped to the name the build gave it', async () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      prerenders: [
        {
          id: '/docs/sticks & stones',
          pathname: '/docs/sticks & stones',
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 1,
          parentFallbackMode: false,
        },
      ],
    });
    const url = new URL('https://docs.example/docs/sticks%20%26%20stones');
    const routed = await resolveRoutes({
      url,
      buildId: 'b',
      basePath: BASE_PATH,
      requestBody: new ReadableStream(),
      headers: new Headers(),
      pathnames: pathnamesFor(store, url),
      // The closed route's own matcher asks for the draft cookies, which this request has not.
      routes: {
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: true,
      },
      invokeMiddleware: () => Promise.resolve({}),
    });
    const target = routed.invocationTarget ?? { pathname: '', query: {} };

    expect(
      resolvedOf(store, routed.resolvedPathname ?? '', target, asked(url.pathname)),
    ).toStrictEqual({
      route: '/docs/sticks & stones',
      pathname: '/docs/sticks & stones',
      url: '/docs/sticks%20%26%20stones',
    });

    // A request that spells nothing escaped is handed the names with their escaped spellings, the
    // same ones each time.
    const plain = pathnamesFor(store, new URL('https://docs.example/docs/hello'));

    expect(plain).toBe(pathnamesFor(store, new URL('https://docs.example/docs/gssp')));
    expect(plain).toStrictEqual([
      ...store.pathnames,
      '/docs/sticks%20&%20stones',
      '/docs/sticks%20%26%20stones',
    ]);
  });

  /**
   * A rewrite to a member of a closed route spelled escaped, as a destination is written: the
   * request brings no escaped spelling of its own, and the router took the destination for no name,
   * so the member answered 404 where the same path asked for directly was served
   * (`param-matching-routing`).
   */
  it.each([
    ['/docs/sticks & stones', '/docs/sticks%20%26%20stones'],
    ['/docs/sticks & stones', '/docs/sticks%20&%20stones'],
    ['/docs/100%', '/docs/100%25'],
    // As RFC 3986 escapes a value: `'` escaped, which `encodeURIComponent` leaves be.
    ["/docs/rock'n", '/docs/rock%27n'],
    ['/docs/記事', '/docs/%E8%A8%98%E4%BA%8B'],
    // In lowercase hex, which spells the same name.
    ['/docs/記事', '/docs/%e8%a8%98%e4%ba%8b'],
    ['/docs/café', '/docs/caf%c3%a9'],
    // Written as no encoder writes it: in hex of mixed case, and a character escaped that needs no escape.
    ['/docs/記事', '/docs/%e8%A8%98%E4%BA%8B'],
    ['/docs/cafe', '/docs/caf%65'],
    // The member whose value is `a/b`, its slash escaped in its name, in either case of hex.
    ['/docs/a%2Fb', '/docs/a%2fb'],
  ])('resolves %s, a member of a closed route a rewrite names as %s', async (name, destination) => {
    const rewrite = { sourceRegex: '^/docs/alias(?:/)?$', destination };
    const store = storeOf(
      {
        ...manifestOf(false),
        prerenders: [
          {
            id: name,
            pathname: name,
            route: '/docs/[slug]',
            parentOutputId: '/docs/[slug]',
            groupId: 1,
            parentFallbackMode: false,
          },
        ],
      },
      [rewrite],
    );
    const url = new URL('https://docs.example/docs/alias');
    const routed = await resolveRoutes({
      url,
      buildId: 'b',
      basePath: BASE_PATH,
      requestBody: new ReadableStream(),
      headers: new Headers(),
      pathnames: pathnamesFor(store, url),
      routes: {
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [rewrite],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: true,
      },
      invokeMiddleware: () => Promise.resolve({}),
    });
    const target = routed.invocationTarget ?? { pathname: '', query: {} };

    expect(
      resolvedOf(store, routed.resolvedPathname ?? '', target, asked(url.pathname)),
    ).toMatchObject({
      route: name,
      pathname: name,
    });
  });

  /**
   * A rewrite's path written out in full is offered as it is written, which may be no encoder's
   * spelling, a request's values in its query alone included; a path a request's values are put in,
   * one that spells no name, another origin's, and a redirect's are not offered. A fragment is part
   * of the path the router sets (`%23`), and that path spells no name. An escaped slash is a value's,
   * inside its segment: `/docs/a%2Fb` is not offered for the page `/docs/a/b`, and
   * `/docs/%e8%A8%98%2f1` is for the member `/docs/記%2F1` (the value `記/1`).
   */
  it("offers a rewrite's path written out in full as it is written, where it spells a name", () => {
    const written = '/docs/%e8%A8%98%E4%BA%8B';
    const queried = '/docs/%E8%A8%98%e4%ba%8b';
    const store = storeOf(
      {
        ...manifestOf(false),
        prerenders: [
          {
            id: '/docs/記事',
            pathname: '/docs/記事',
            route: '/docs/[slug]',
            parentOutputId: '/docs/[slug]',
            groupId: 1,
            parentFallbackMode: false,
          },
          {
            id: '/docs/a/b',
            pathname: '/docs/a/b',
            route: '/docs/[...parts]',
            parentOutputId: '/docs/[...parts]',
            groupId: 2,
            parentFallbackMode: false,
          },
          {
            id: '/docs/記%2F1',
            pathname: '/docs/記%2F1',
            route: '/docs/[slug]',
            parentOutputId: '/docs/[slug]',
            groupId: 1,
            parentFallbackMode: false,
          },
        ],
      },
      [
        { sourceRegex: '^/docs/alias(?:/)?$', destination: `${written}?from=alias` },
        { sourceRegex: '^/docs/slash(?:/)?$', destination: '/docs/a%2Fb' },
        { sourceRegex: '^/docs/value(?:/)?$', destination: '/docs/%e8%A8%98%2f1' },
        { sourceRegex: '^/docs/query/(?<slug>[^/]+)$', destination: `${queried}?from=$slug` },
        { sourceRegex: '^/docs/put/(?<rest>.+)$', destination: '/docs/%e8%A8%98$rest' },
        { sourceRegex: '^/docs/part(?:/)?$', destination: `${written}#part` },
        { sourceRegex: '^/docs/other(?:/)?$', destination: '/docs/%e8%A8%98%E4%BA%8Bx' },
        { sourceRegex: '^/docs/away(?:/)?$', destination: `https://other.example${written}x` },
        {
          sourceRegex: '^/docs/moved(?:/)?$',
          destination: '/docs/%E8%a8%98%E4%BA%8B',
          status: 308,
          headers: { Location: '/docs/%E8%a8%98%E4%BA%8B' },
        },
      ],
    );
    const names = pathnamesFor(store, new URL('https://docs.example/docs/hello'));

    expect(names).toContain(written);
    expect(names).toContain(queried);
    expect(
      names.filter((name) => name.startsWith('/docs/%e8%A8') || name.endsWith('x')),
    ).toStrictEqual([written, '/docs/%e8%A8%98%2f1']);
    expect(names).not.toContain('/docs/%E8%a8%98%E4%BA%8B');
    expect(names).not.toContain('/docs/a%2Fb');
    expect(names).toContain('/docs/%e8%A8%98%2f1');
  });

  it('offers the escaped spellings of a store that names a page twice', () => {
    const store = storeOf({
      ...manifestOf(false),
      prerenders: [
        {
          id: '/docs/sticks & stones',
          pathname: '/docs/sticks & stones',
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 1,
          parentFallbackMode: false,
        },
      ],
    });
    // As many names twice as the one name has spellings: a count of the store's own array, taken
    // for the names without them, came out the same with them.
    const twice = { ...store, pathnames: [...store.pathnames, '/docs/hello', '/docs/gssp'] };

    const names = pathnamesFor(twice, new URL('https://docs.example/docs/hello'));

    expect(names).toContain('/docs/sticks%20&%20stones');
    expect(names).toContain('/docs/sticks%20%26%20stones');
  });

  it('offers a page whose value holds a bracket its spellings, and the template none', () => {
    const store = storeOf({
      ...manifestOf(false),
      prerenders: [
        {
          id: '/docs/[post3]',
          pathname: '/docs/[post3]',
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 1,
          parentFallbackMode: false,
        },
      ],
    });
    const names = pathnamesFor(store, new URL('https://docs.example/docs/hello'));

    expect(names).toContain('/docs/%5Bpost3%5D');
    expect(names).not.toContain('/docs/%5Bslug%5D');
  });

  it('offers a page whose value is spelled as its own placeholder its spellings', () => {
    const store = storeOf({
      ...manifestOf(false),
      prerenders: [
        {
          id: '/docs/[slug]',
          pathname: '/docs/[slug]',
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 1,
          parentFallbackMode: false,
        },
      ],
    });

    expect(pathnamesFor(store, new URL('https://docs.example/docs/hello'))).toContain(
      '/docs/%5Bslug%5D',
    );
  });

  it('offers a file of public/, named as a URL spells it, no spelling escaped twice', () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      staticFiles: [
        ...manifest.staticFiles,
        { pathname: '/docs/foo%20bar.txt', blob: NO_BLOB, immutable: false },
      ],
    });

    expect(pathnamesFor(store, new URL('https://docs.example/docs/hello'))).not.toContain(
      '/docs/foo%2520bar.txt',
    );
  });

  it('offers a page the build wrote as a file, a literal escape in its name, its spellings', () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      entrypoints: [
        ...manifest.entrypoints,
        { id: '/docs/%41', kind: 'pages' as const, pathname: '/docs/%41' },
      ],
      staticFiles: [
        ...manifest.staticFiles,
        { pathname: '/docs/%41', blob: NO_BLOB, immutable: false },
      ],
    });

    expect(pathnamesFor(store, new URL('https://docs.example/docs/hello'))).toContain(
      '/docs/%2541',
    );
  });

  it('offers a page written as a file with no entrypoint, as an export writes it, its spellings', () => {
    const manifest = manifestOf(false);
    // `/docs/%41` is what no file of `public/` is named: the adapter would have named `A` so.
    const store = storeOf({
      ...manifest,
      staticFiles: [
        ...manifest.staticFiles,
        { pathname: '/docs/%41', blob: NO_BLOB, immutable: false },
      ],
    });

    expect(pathnamesFor(store, new URL('https://docs.example/docs/hello'))).toContain(
      '/docs/%2541',
    );
  });

  it('offers a narrower class the build named by name no spelling', () => {
    const store = storeOf({
      ...manifestOf(false),
      prerenders: [
        {
          id: '/docs/t1/[item]',
          pathname: '/docs/t1/[item]',
          route: '/docs/[team]/[item]',
          routeType: 'shell' as const,
          parentOutputId: '/docs/[team]/[item]',
          groupId: 1,
        },
      ],
    });
    const names = pathnamesFor(store, new URL('https://docs.example/docs/hello'));

    expect(names).toContain('/docs/t1/[item]');
    expect(names).not.toContain('/docs/t1/%5Bitem%5D');
  });

  it('offers a name no URL can spell as it is, and the others their spellings', () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      staticFiles: [
        ...manifest.staticFiles,
        { pathname: '/docs/\u{D800}', blob: NO_BLOB, immutable: false },
        { pathname: '/docs/about us', blob: NO_BLOB, immutable: false },
      ],
    });
    const names = pathnamesFor(store, new URL('https://docs.example/docs/hello'));

    expect(names).toContain('/docs/\u{D800}');
    expect(names).toContain('/docs/about%20us');
  });

  it('offers the image endpoint, spelled as its configuration spells it, no spelling', () => {
    const manifest = manifestOf(false);
    const path = '/docs/media%20cache/_next/image';
    const images: ImagesConfig = {
      path,
      basePath: BASE_PATH,
      sizes: [64],
      qualities: [75],
      formats: ['image/webp'],
      minimumCacheTTL: 60,
      maximumRedirects: 2,
      maximumResponseBody: 4096,
      remotePatterns: [],
      domains: [],
      localPatterns: [],
      dangerouslyAllowLocalIP: false,
      dangerouslyAllowSVG: false,
      contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
      contentDispositionType: 'attachment',
    };
    const store = storeOf({ ...manifest, config: { ...manifest.config, images } });
    const names = pathnamesFor(store, new URL('https://docs.example/docs/hello'));

    expect(names).toContain(path);
    expect(names).not.toContain('/docs/media%2520cache/_next/image');
  });

  it('takes an escaped spelling of a page kept behind a trailing slash back to the page', () => {
    const manifest = manifestOf(true);
    const store = storeOf({
      ...manifest,
      staticFiles: [
        ...manifest.staticFiles,
        { pathname: '/docs/about us', blob: NO_BLOB, immutable: false },
      ],
    });
    const path = '/docs/about%20us/';

    expect(pathnamesFor(store, new URL('https://docs.example/docs/'))).toContain(path);
    expect(resolvedOf(store, path, { pathname: path, query: {} }, asked(path)).route).toBe(
      '/docs/about us',
    );
  });

  it('offers no spelling that decodes to another name, nor one decoded twice', () => {
    const store = storeOf({
      ...manifestOf(false),
      prerenders: ['/docs/literal%20value', '/docs/what%3F'].map((pathname) => {
        return {
          id: pathname,
          pathname,
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 1,
          parentFallbackMode: false,
        };
      }),
    });
    const names = pathnamesFor(store, new URL('https://docs.example/docs/hello'));

    // A name with an escape in it is spelled with that escape escaped, and not decoded to `literal value`.
    expect(names).toContain('/docs/literal%2520value');
    expect(names).not.toContain('/docs/literal value');
    // A member's `?` is escaped in its name (`escapePathDelimiters`: `/docs/what%3F` for the value
    // `what?`): it is offered in either case of hex, and not with its escape escaped again, which
    // asks for the value `what%3F`.
    expect(names.filter((spelled) => spelled.startsWith('/docs/what'))).toStrictEqual([
      '/docs/what%3F',
      '/docs/what%3f',
    ]);
  });

  /**
   * An escaped slash is a value's, inside its segment, as a dynamic route reads it: `/docs/a%2fb`
   * asks for the member `/docs/a%2Fb` (the value `a/b`), and `/docs/c%2Fd` for no member of another
   * route at `/docs/c/d`, nor `/docs/a%252Fb` (the value `a%2Fb`) for `a/b`.
   */
  it("reads an escaped slash as part of a member's segment", () => {
    const store = escapedSlashStore();

    expect(offeredTo(store, '/docs/a%2fb')).toContain('/docs/a%2fb');
    expect(lookedUpIn(store, '/docs/a%2fb')).toBe('/docs/a%2Fb');
    expect(prerenderedName(store, '/docs/a%2fb')).toBe('/docs/a%2Fb');
    expect(offeredTo(store, '/docs/c%2Fd')).not.toContain('/docs/c%2Fd');
    expect(prerenderedName(store, '/docs/c%2Fd')).toBe('/docs/c%2Fd');
    expect(prerenderedName(store, '/docs/a%252Fb')).toBe('/docs/a%252Fb');
  });

  /**
   * A page of its own and a file are found decoded whole, as Next.js's filesystem check finds them
   * ahead of any dynamic route: `/docs/api%2Fhello` is the route handler `/docs/api/hello`, though
   * `/docs/[slug]` would take it for a member, and `/docs/files%2Frobots.txt` the file
   * `/docs/files/robots.txt`. Behind the base path, which the check reads as written.
   */
  it('finds a page of its own and a file decoded whole', () => {
    const store = escapedSlashStore();
    const filed = storeOf(withFiles(manifestOf(false), ['/docs/files/robots.txt']));

    // `robots.txt`, a file of the build, by a path that escapes the slash before it.
    expect(offeredTo(filed, '/docs/files%2Frobots.txt')).toContain('/docs/files%2Frobots.txt');
    expect(lookedUpIn(filed, '/docs/files%2Frobots.txt')).toBe('/docs/files/robots.txt');
    expect(offeredTo(store, '/docs/api%2Fhello')).toContain('/docs/api%2Fhello');
    expect(lookedUpIn(store, '/docs/api%2Fhello')).toBe('/docs/api/hello');
  });

  /**
   * Next.js's router reads the base path as a path writes it (`pathHasPrefix`), before it decodes
   * anything: `/d%6Fcs/hello`, and `/docs%2Frobots.txt`, whose slash after the base path is
   * escaped, are under no base path, and answered 404 — as `/docs%2Fgssp` is no prerender of
   * `/docs/gssp`. Behind the base path, a path is decoded as ever.
   */
  it('reads the base path as written', () => {
    const store = escapedSlashStore();

    expect(offeredTo(store, '/d%6Fcs/hello')).not.toContain('/d%6Fcs/hello');
    expect(offeredTo(store, '/docs%2Frobots.txt')).not.toContain('/docs%2Frobots.txt');
    expect(lookedUpIn(store, '/docs%2Frobots.txt')).toBe('/docs%2Frobots.txt');
    expect(prerenderedName(store, '/docs%2Fgssp')).toBe('/docs%2Fgssp');
    expect(prerenderedName(store, '/d%6Fcs/gssp')).toBe('/d%6Fcs/gssp');
    expect(offeredTo(store, '/docs/h%65llo')).toContain('/docs/h%65llo');
  });

  /**
   * Where a page of its own and a member are both named by what a path reads as — the page
   * `/docs/a/b`, and the member `/docs/a%2Fb` (the value `a/b`) — Next.js's filesystem check finds
   * the page decoded whole before any dynamic route asks for the member. A file is found without a
   * trailing slash, as the check takes the slash off: one of an application that keeps its pages
   * behind the slash, and one named with an extension, which has no name behind it.
   */
  it('finds a page of its own ahead of a member, and a file behind the slash', () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      entrypoints: [
        ...manifest.entrypoints,
        { id: '/docs/a/b', kind: 'app-page', pathname: '/docs/a/b' },
      ],
      prerenders: [
        {
          id: '/docs/a%2Fb',
          pathname: '/docs/a%2Fb',
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 1,
          parentFallbackMode: false,
        },
        {
          id: '/docs/a/b',
          pathname: '/docs/a/b',
          route: '/docs/a/b',
          parentOutputId: '/docs/a/b',
          groupId: 2,
          parentFallbackMode: false,
        },
      ],
    });
    const files = ['/docs/files/hello', '/docs/files/robots.txt'];
    const slashed = storeOf(withFiles(manifestOf(true), files));
    const filed = storeOf(withFiles(manifest, files));

    expect(lookedUpIn(store, '/docs/a%2Fb')).toBe('/docs/a/b');
    expect(prerenderedName(store, '/docs/a%2Fb')).toBe('/docs/a/b');
    expect(offeredTo(slashed, '/docs/files%2Fhello/')).toContain('/docs/files%2Fhello/');
    expect(lookedUpIn(slashed, '/docs/files%2Fhello/')).toBe('/docs/files/hello');
    // A file named with an extension has no name behind the slash; the check takes the slash off.
    expect(offeredTo(filed, '/docs/files%2Frobots.txt/')).toContain('/docs/files%2Frobots.txt/');
    expect(lookedUpIn(filed, '/docs/files%2Frobots.txt/')).toBe('/docs/files/robots.txt');
  });

  /**
   * A base path past ASCII is asked for as a browser escapes it, in capitals: that spelling is offered
   * to the router, and found as the page. In small letters it writes the base path otherwise than the
   * router reads it, and is offered as nothing, so the router answers it 404, as Next.js answers
   * every escaped spelling of such a base path.
   */
  it('offers a base path past ASCII as a browser spells it, and no other way', () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      config: { ...manifest.config, basePath: '/文書' },
      entrypoints: [],
      staticFiles: [{ pathname: '/文書/about', blob: NO_BLOB, immutable: false }],
    });
    const capitals = '/%E6%96%87%E6%9B%B8/about';
    const small = '/%e6%96%87%e6%9b%b8/about';

    expect(offeredTo(store, capitals)).toContain(capitals);
    expect(lookedUpIn(store, capitals)).toBe('/文書/about');
    expect(offeredTo(store, small)).not.toContain(small);
  });

  /**
   * The router reads a locale as written too — every one it routes, a domain's among them: a path
   * that escapes one (`/docs/%6El/about`) names no prerender behind it. Behind the locale, a path
   * is decoded as ever.
   */
  it('reads a locale as written, a domain’s included', () => {
    const manifest = manifestOf(false);
    const domain = { domain: 'example.nl', defaultLocale: 'nl', locales: ['nl'] };
    const store = storeOf({
      ...manifest,
      config: {
        ...manifest.config,
        i18n: { locales: ['en'], defaultLocale: 'en', domains: [domain] },
      },
      prerenders: [
        {
          id: '/docs/nl/about',
          pathname: '/docs/nl/about',
          route: '/docs/about',
          parentOutputId: '/docs/about',
          groupId: 1,
          parentFallbackMode: false,
        },
      ],
    });

    expect(prerenderedName(store, '/docs/%6El/about')).toBe('/docs/%6El/about');
    expect(prerenderedName(store, '/docs/nl/%61bout')).toBe('/docs/nl/about');
  });

  /**
   * An application with `i18n` names a Pages Router page's entrypoint without a locale and its
   * prerenders with one, behind the base path, and Next.js's filesystem check takes the locale off
   * before it asks for the page: `/docs/en/a%2Fb` is the prerender of the page `/docs/a/b`, ahead of
   * the member `/docs/en/a%2Fb` of a localized dynamic route.
   */
  it('finds a page of its own behind a locale', () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      config: { ...manifest.config, i18n: { locales: ['en', 'ja'], defaultLocale: 'en' } },
      entrypoints: [
        ...manifest.entrypoints,
        { id: '/docs/a/b', kind: 'pages', pathname: '/docs/a/b' },
      ],
      prerenders: [
        {
          id: '/docs/en/a/b',
          pathname: '/docs/en/a/b',
          route: '/docs/a/b',
          parentOutputId: '/docs/a/b',
          groupId: 1,
          parentFallbackMode: false,
        },
        {
          id: '/docs/en/a%2Fb',
          pathname: '/docs/en/a%2Fb',
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 2,
          parentFallbackMode: false,
        },
      ],
    });

    expect(prerenderedName(store, '/docs/en/a%2Fb')).toBe('/docs/en/a/b');
  });

  /**
   * A page of its own whose name holds an escape (`/docs/a%2Fb`, a folder named so) is found decoded
   * whole, as Next.js's filesystem check finds it: its name escaped again (`/docs/a%252Fb`) is
   * offered, for a rewrite that puts it in a destination, and found as the page.
   */
  it('offers a page of its own named with an escape its name escaped again', () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      entrypoints: [
        ...manifest.entrypoints,
        { id: '/docs/a%2Fb', kind: 'app-page', pathname: '/docs/a%2Fb' },
      ],
    });

    expect(offeredTo(store, '/docs/hello')).toContain('/docs/a%252Fb');
    expect(lookedUpIn(store, '/docs/a%252Fb')).toBe('/docs/a%2Fb');
  });

  /**
   * Next.js's filesystem check asks for a file ahead of a page, each as spelled and then decoded
   * whole: where the page of its own `/docs/a%2Fb` and the file `/docs/a/b` are both built, a
   * request for `/docs/a%2Fb` is the file.
   */
  it('finds a file ahead of a page of its own, whichever reading names each', () => {
    const manifest = manifestOf(false);
    const store = storeOf({
      ...manifest,
      entrypoints: [
        ...manifest.entrypoints,
        { id: '/docs/a%2Fb', kind: 'app-page', pathname: '/docs/a%2Fb' },
      ],
      staticFiles: [
        ...manifest.staticFiles,
        { pathname: '/docs/a/b', blob: NO_BLOB, immutable: false },
      ],
    });

    expect(lookedUpIn(store, '/docs/a%2Fb')).toBe('/docs/a/b');
  });

  it('hands the handler the URL as it was asked for, escaped', () => {
    const manifest = manifestOf(false);
    const named = {
      ...manifest,
      prerenders: [
        {
          id: '/docs/sticks & stones',
          pathname: '/docs/sticks & stones',
          route: '/docs/[slug]',
          parentOutputId: '/docs/[slug]',
          groupId: 1,
          parentFallbackMode: false,
        },
      ],
    };
    const path = '/docs/sticks%20%26%20stones';

    const resolved = resolvedOf(
      storeOf(named),
      '/docs/[slug]',
      { pathname: path, query: {} },
      asked(path),
    );

    expect(resolved.url).toBe(path);
  });
});

/**
 * After a `next.config` rewrite, `@next/routing` asks its dynamic routes before the pathnames the
 * build named, where Next.js's router looks in the filesystem first: a rewrite of `/rewrite-1` to
 * `/ssr-page` was answered by `pages/[id].js`, which matches `/ssr-page` as well.
 */
describe('the route a rewrite lands on', () => {
  const ID_ROUTE = {
    sourceRegex: '^/(?<nxtPid>[^/]+?)(?:/)?$',
    destination: '/[id]?nxtPid=$nxtPid',
  };
  const manifest = {
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: true,
    },
    entrypoints: [
      { id: '/ssr-page', kind: 'pages' as const, pathname: '/ssr-page' },
      { id: '/hello world', kind: 'pages' as const, pathname: '/hello world' },
      { id: '/[id]', kind: 'pages' as const, pathname: '/[id]' },
    ],
    prerenders: [],
    staticFiles: [{ pathname: '/about-a', blob: NO_BLOB, immutable: false }],
  };

  async function routedTo(destination: string) {
    // The store holds the rewrite the router is handed, as a deployment's does.
    const rewrite = { sourceRegex: '^/rewrite-1(?:/)?$', destination };
    const store = storeOf(manifest, [rewrite]);
    const { resolvedPathname, invocationTarget } = await resolveRoutes({
      url: new URL('https://app.example/rewrite-1'),
      buildId: 'b',
      basePath: '',
      requestBody: new ReadableStream(),
      headers: new Headers(),
      pathnames: store.pathnames,
      routes: {
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [rewrite],
        dynamicRoutes: [ID_ROUTE],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: true,
      },
      invokeMiddleware: () => Promise.resolve({}),
    });
    if (resolvedPathname === undefined || invocationTarget === undefined) {
      throw new Error('the rewrite resolved to nothing');
    }
    return { store, route: resolvedPathname, target: invocationTarget };
  }

  it.each([
    { destination: '/ssr-page?from=config', page: '/ssr-page', query: { from: 'config' } },
    { destination: '/about-a', page: '/about-a', query: {} },
    // Spelled escaped, as a destination is written: the page the build named `/hello world`.
    { destination: '/hello%20world', page: '/hello world', query: {} },
  ])(
    'is the page the build named for $page, not a dynamic route that also matches it',
    async ({ destination, page, query }) => {
      const { store, route, target } = await routedTo(destination);

      // What `@next/routing` answers on its own.
      expect(route).toBe('/[id]');

      const landed = landedRoute(store, route, target);

      expect(landed.route).toBe(page);
      expect(landed.target.query).toStrictEqual(query);
    },
  );

  it('leaves a member of the dynamic route to the dynamic route', async () => {
    const { store, route, target } = await routedTo('/some-id');

    const landed = landedRoute(store, route, target);

    expect(landed.route).toBe('/[id]');
    expect(landed.target.query).toStrictEqual({ nxtPid: 'some-id' });
  });
});
