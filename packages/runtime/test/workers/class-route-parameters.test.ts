import { resolveRoutes } from '@next/routing';
import { describe, expect, it } from 'vitest';

import { resolvedOf } from '../../src/routing.ts';
import { routerPathnames, type Store } from '../../src/store.ts';

/**
 * A member of a dynamic route whose leading parameter `generateStaticParams` lists, handed to the
 * page under a path other than the one routing ended on.
 *
 * Next.js 16.4 routes `/en/docs` to the class the build keeps for `en` (`/en/docs/[[...slug]]`) by a
 * pattern that captures `en` without naming it, so the query routing ends on names `slug` and not
 * `locale`. A request a middleware rewrote from `/docs` is handed `/docs` with that query, and the
 * page found `locale` in neither: "Could not resolve param value for segment: locale", on every
 * page of an application that puts its default locale behind a rewrite.
 *
 * The two routes are the ones `next build` 16.4.0 wrote for `app/[locale]/docs/[[...slug]]` with the
 * locales `en` and `ja` listed, the class's first.
 */

const CLASS_ROUTE = {
  source: '/$1/docs/[[...slug]]',
  sourceRegex: String.raw`^[/]?/(en|ja)/docs(?:/(?<nxtPslug>.+?))?(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`,
  destination: '/$1/docs/[[...slug]]$3?nxtPslug=$nxtPslug',
};
const ROUTE = {
  source: '/[locale]/docs/[[...slug]]',
  sourceRegex: String.raw`^[/]?/(?<nxtPlocale>[^/]+?)/docs(?:/(?<nxtPslug>.+?))?(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`,
  destination: '/[locale]/docs/[[...slug]]$3?nxtPlocale=$nxtPlocale&nxtPslug=$nxtPslug',
};
const PAGE = '/[locale]/docs/[[...slug]]';
const ORIGIN = 'https://site.example';

/** A prerender of `template`: a class the build keeps for some of its values, a member, or its own. */
function prerenderOf(pathname: string, template: string) {
  return {
    id: pathname,
    pathname,
    route: template,
    parentOutputId: template,
    groupId: 1,
    routeType: 'page' as const,
  };
}

function manifestOf(
  template: string,
  prerendered: readonly string[],
): Parameters<typeof routerPathnames>[0] {
  return {
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: true,
    },
    entrypoints: [{ id: template, kind: 'app-page', pathname: template }],
    prerenders: [...prerendered, template].map((pathname) => prerenderOf(pathname, template)),
    staticFiles: [],
  };
}

/** A store as the Worker builds one from its manifest, as much of it as a route is looked up in. */
function storeOf(
  prerendered: readonly string[] = ['/en/docs/[[...slug]]', '/ja/docs/[[...slug]]'],
  template = PAGE,
): Store {
  return storeFrom(manifestOf(template, prerendered));
}

function storeFrom(manifest: Parameters<typeof routerPathnames>[0]): Store {
  return {
    manifest: {
      ...manifest,
      routing: { beforeMiddleware: [], beforeFiles: [], afterFiles: [], fallback: [] },
    },
    prerendersByPathname: new Map(
      manifest.prerenders.map((prerender) => [prerender.pathname, prerender]),
    ),
    staticFiles: new Map(),
    ...routerPathnames(manifest),
  } as unknown as Store;
}

/** Where routing ends for a path, by the routes `next build` 16.4.0 wrote, the class's first. */
async function routed(
  store: Store,
  path: string,
  dynamicRoutes = [CLASS_ROUTE, ROUTE],
): Promise<{
  route: string;
  target: { pathname: string; query: Record<string, string | string[]> };
}> {
  const result = await resolveRoutes({
    url: new URL(path, ORIGIN),
    buildId: 'b',
    basePath: '',
    requestBody: new ReadableStream(),
    headers: new Headers(),
    pathnames: routerPathnames(store.manifest).pathnames,
    routes: {
      beforeMiddleware: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes,
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: true,
    },
    invokeMiddleware: () => Promise.resolve({}),
  });
  return {
    route: result.resolvedPathname ?? '',
    target: result.invocationTarget ?? { pathname: '', query: {} },
  };
}

describe('the parameters a class route holds in its path', () => {
  it('lands a member on its class, by a pattern that does not name the locale', async () => {
    const { route, target } = await routed(storeOf(), '/en/docs');

    expect(route).toBe('/en/docs/[[...slug]]');
    expect(target).toStrictEqual({ pathname: '/en/docs', query: { nxtPslug: '' } });
  });

  it('names the locale for a page a middleware rewrote to it', async () => {
    const store = storeOf();
    const { route, target } = await routed(store, '/en/docs');

    const resolved = resolvedOf(store, route, target, {
      url: new URL('/docs', ORIGIN),
      rewrite: new URL('/en/docs', ORIGIN),
    });

    expect(resolved.url).toBe('/docs?nxtPslug=&nxtPlocale=en');
  });

  it('names it beside the rest of the route’s parameters, deeper in', async () => {
    const store = storeOf();
    const { route, target } = await routed(store, '/ja/docs/getting-started/quickstart');

    const resolved = resolvedOf(store, route, target, {
      url: new URL('/docs/getting-started/quickstart?ref=1', ORIGIN),
      rewrite: new URL('/ja/docs/getting-started/quickstart?ref=1', ORIGIN),
    });

    expect(resolved.url).toBe(
      '/docs/getting-started/quickstart?nxtPslug=getting-started%2Fquickstart&nxtPlocale=ja',
    );
  });

  it('names it for a page reached by a rewrite of the application’s own config', async () => {
    const store = storeOf();
    const { route, target } = await routed(store, '/en/docs');

    const resolved = resolvedOf(store, route, target, {
      url: new URL('/manual?ref=1', ORIGIN),
      rewrite: undefined,
    });

    expect(resolved.url).toBe('/manual?ref=1&nxtPslug=&nxtPlocale=en');
  });

  it('hands the path routing ended on as it was, which says the locale itself', async () => {
    const store = storeOf();
    const { route, target } = await routed(store, '/en/docs');

    const resolved = resolvedOf(store, route, target, {
      url: new URL('/en/docs', ORIGIN),
      rewrite: undefined,
    });

    expect(resolved.url).toBe('/en/docs?nxtPslug=');
  });

  it('names it where routing matched the rest of the path in another case', async () => {
    const store = storeOf();
    const { route, target } = await routed(store, '/en/DOCS');

    const resolved = resolvedOf(store, route, target, {
      url: new URL('/DOCS', ORIGIN),
      rewrite: new URL('/en/DOCS', ORIGIN),
    });

    expect(route).toBe('/en/docs/[[...slug]]');
    expect(resolved.url).toBe('/DOCS?nxtPslug=&nxtPlocale=en');
  });

  it('adds nothing where the route’s own pattern named the locale', async () => {
    const store = storeOf();
    const { route, target } = await routed(store, '/en/docs', [ROUTE]);

    const resolved = resolvedOf(store, route, target, {
      url: new URL('/docs', ORIGIN),
      rewrite: new URL('/en/docs', ORIGIN),
    });

    expect(route).toBe(PAGE);
    expect(resolved.url).toBe('/docs?nxtPlocale=en&nxtPslug=');
  });

  it('adds nothing where the path routing ended on holds another value', () => {
    const resolved = resolvedOf(
      storeOf(),
      '/en/docs/[[...slug]]',
      { pathname: '/fr/docs', query: { nxtPslug: '' } },
      { url: new URL('/docs', ORIGIN), rewrite: new URL('/fr/docs', ORIGIN) },
    );

    expect(resolved.url).toBe('/docs?nxtPslug=');
  });

  it('names a value the build spelled in brackets, which is no placeholder', () => {
    const resolved = resolvedOf(
      storeOf(['/[en]/docs/[[...slug]]']),
      '/[en]/docs/[[...slug]]',
      { pathname: '/%5Ben%5D/docs', query: { nxtPslug: '' } },
      { url: new URL('/docs', ORIGIN), rewrite: new URL('/%5Ben%5D/docs', ORIGIN) },
    );

    expect(resolved.url).toBe('/docs?nxtPslug=&nxtPlocale=%5Ben%5D');
  });

  it('names the locale of a routed path that keeps a trailing slash', () => {
    const resolved = resolvedOf(
      storeOf(),
      '/en/docs/[[...slug]]',
      { pathname: '/en/docs/', query: { nxtPslug: '' } },
      { url: new URL('/docs/', ORIGIN), rewrite: new URL('/en/docs/', ORIGIN) },
    );

    expect(resolved.url).toBe('/docs/?nxtPslug=&nxtPlocale=en');
  });
});

/**
 * The same for the other ways a route holds its parameters: a value the build keeps escaped in its
 * name, or keeps as it is where a request escapes it, a parameter whose name has a period, and a
 * member the build prerendered by name, which lands with no parameter in the query at all — of a
 * catch-all, of an optional one with none, or with a value spelled as its own placeholder (a member
 * of a route that lists every value, `parentFallbackMode: false`, is the one routing lands on by
 * name). A class leaves open every parameter it holds the placeholder of, whatever query its
 * entries vary on (`allowQuery`): Next.js 16.4 leaves out one it resumes for each request. A
 * catch-all is named only where Next.js will read its value back as the segments it is.
 */
describe('the values a prerendered route holds, whatever its parameter', () => {
  it('names a value whose slash the build keeps escaped', () => {
    const resolved = resolvedOf(
      storeOf(['/a%2Fb/docs/[[...slug]]'], '/[team]/docs/[[...slug]]'),
      '/a%2Fb/docs/[[...slug]]',
      { pathname: '/a%2Fb/docs', query: { nxtPslug: '' } },
      { url: new URL('/docs', ORIGIN), rewrite: new URL('/a%2Fb/docs', ORIGIN) },
    );

    expect(resolved.url).toBe('/docs?nxtPslug=&nxtPteam=a%2Fb');
  });

  it('names a value whose percent sign the build keeps as it is, which a request escapes', () => {
    const resolved = resolvedOf(
      storeOf(['/100%/docs/[[...slug]]'], '/[team]/docs/[[...slug]]'),
      '/100%/docs/[[...slug]]',
      { pathname: '/100%25/docs', query: { nxtPslug: '' } },
      { url: new URL('/docs', ORIGIN), rewrite: new URL('/100%25/docs', ORIGIN) },
    );

    expect(resolved.url).toBe('/docs?nxtPslug=&nxtPteam=100%25');
  });

  it('decodes a value once, as routing decodes the values it names', () => {
    const resolved = resolvedOf(
      storeOf(['/%20/docs/[[...slug]]'], '/[team]/docs/[[...slug]]'),
      '/%20/docs/[[...slug]]',
      { pathname: '/%2520/docs', query: { nxtPslug: '' } },
      { url: new URL('/docs', ORIGIN), rewrite: new URL('/%2520/docs', ORIGIN) },
    );

    expect(resolved.url).toBe('/docs?nxtPslug=&nxtPteam=%2520');
  });

  it('names a parameter whose name has a period', () => {
    const resolved = resolvedOf(
      storeOf(['/acme/docs/[[...slug]]'], '/[user.id]/docs/[[...slug]]'),
      '/acme/docs/[[...slug]]',
      { pathname: '/acme/docs', query: { nxtPslug: '' } },
      { url: new URL('/docs', ORIGIN), rewrite: new URL('/acme/docs', ORIGIN) },
    );

    expect(resolved.url).toBe('/docs?nxtPslug=&nxtPuser.id=acme');
  });

  it('names a catch-all’s value, every segment of it, for a member prerendered by name', () => {
    const resolved = resolvedOf(
      storeOf(['/docs/a/b'], '/docs/[...slug]'),
      '/docs/a/b',
      { pathname: '/docs/a/b', query: {} },
      { url: new URL('/alias', ORIGIN), rewrite: new URL('/docs/a/b', ORIGIN) },
    );

    expect(resolved.url).toBe('/alias?nxtPslug=a%2Fb');
  });

  it('names no catch-all one of whose segments holds a slash, which Next.js would read as two', () => {
    const resolved = resolvedOf(
      storeOf(['/docs/x/a%2Fb'], '/docs/[...slug]'),
      '/docs/x/a%2Fb',
      { pathname: '/docs/x/a%2Fb', query: {} },
      { url: new URL('/alias', ORIGIN), rewrite: new URL('/docs/x/a%2Fb', ORIGIN) },
    );

    expect(resolved.url).toBe('/alias');
  });

  it('names an optional catch-all that holds nothing, as routing names one', () => {
    const resolved = resolvedOf(
      storeOf(['/docs'], '/docs/[[...slug]]'),
      '/docs',
      { pathname: '/docs', query: {} },
      { url: new URL('/manual', ORIGIN), rewrite: undefined },
    );

    expect(resolved.url).toBe('/manual?nxtPslug=');
  });

  it('names a member’s value spelled as its own placeholder, which the build says is a page', () => {
    const manifest = manifestOf('/blog/[post]', []);
    const store = storeFrom({
      ...manifest,
      prerenders: [{ ...prerenderOf('/blog/[post]', '/blog/[post]'), parentFallbackMode: false }],
    });

    const resolved = resolvedOf(
      store,
      '/blog/[post]',
      { pathname: '/blog/%5Bpost%5D', query: {} },
      { url: new URL('/alias', ORIGIN), rewrite: new URL('/blog/%5Bpost%5D', ORIGIN) },
    );

    expect(resolved.url).toBe('/alias?nxtPpost=%5Bpost%5D');
  });

  it('names nothing a class holds the placeholder of, though its entries do not vary on it', () => {
    const template = '/[lang]/[region]/posts/[id]';
    const store = storeFrom({
      ...manifestOf(template, []),
      prerenders: [{ ...prerenderOf(template, template), allowQuery: ['nxtPlang', 'nxtPregion'] }],
    });

    const resolved = resolvedOf(
      store,
      template,
      { pathname: '/de/fr/posts/[id]', query: { nxtPlang: 'de', nxtPregion: 'fr' } },
      { url: new URL('/alias', ORIGIN), rewrite: new URL('/de/fr/posts/[id]', ORIGIN) },
    );

    expect(resolved.url).toBe('/alias?nxtPlang=de&nxtPregion=fr');
  });

  it('names nothing of a route whose static segments are not its template’s', () => {
    const resolved = resolvedOf(
      storeOf(['/en/guide/[[...slug]]']),
      '/en/guide/[[...slug]]',
      { pathname: '/en/guide', query: { nxtPslug: '' } },
      { url: new URL('/guide', ORIGIN), rewrite: new URL('/en/guide', ORIGIN) },
    );

    expect(resolved.url).toBe('/guide?nxtPslug=');
  });
});

/** A store of an application with `i18n`, whose page is named without a locale. */
function localizedStore(template: string, prerendered: readonly string[]): Store {
  const manifest = manifestOf(template, prerendered);
  return storeFrom({
    ...manifest,
    config: { ...manifest.config, i18n: { defaultLocale: 'en', locales: ['en', 'fr'] } },
    entrypoints: [{ id: template, kind: 'pages', pathname: template }],
  });
}

/**
 * An application with `i18n` names a locale's prerender with the locale in front (`/fr/blog/post` of
 * `/blog/[slug]`), and the path routing ended on leads with it too. Read from the front as they
 * are, the locale was taken for the template's first value: `slug` named `en` for `/en/hello`.
 */
describe('a locale’s prerender, in an application with i18n', () => {
  it('names the value after the locale, never the locale', () => {
    const resolved = resolvedOf(
      localizedStore('/[slug]', ['/en/hello']),
      '/en/hello',
      { pathname: '/en/hello', query: {} },
      { url: new URL('/alias', ORIGIN), rewrite: new URL('/en/hello', ORIGIN) },
    );

    expect(resolved.url).toBe('/en/alias?nxtPslug=hello');
  });

  it('names it under a static segment, for another locale', () => {
    const resolved = resolvedOf(
      localizedStore('/blog/[slug]', ['/fr/blog/post']),
      '/fr/blog/post',
      { pathname: '/fr/blog/post', query: {} },
      { url: new URL('/alias', ORIGIN), rewrite: new URL('/fr/blog/post', ORIGIN) },
    );

    expect(resolved.url).toBe('/fr/alias?nxtPslug=post');
  });

  /**
   * `i18n` puts no locale in front of an App Router route, and an application part way from one
   * router to the other has both: its `[locale]` segment is the App Router's own, and read without
   * `en` the class lined up with nothing, and the locale was named nowhere again.
   */
  it('reads an App Router class as it is, beside it', () => {
    const manifest = manifestOf(PAGE, ['/en/docs/[[...slug]]']);
    const store = storeFrom({
      ...manifest,
      config: { ...manifest.config, i18n: { defaultLocale: 'en', locales: ['en', 'fr'] } },
    });

    const resolved = resolvedOf(
      store,
      '/en/docs/[[...slug]]',
      { pathname: '/en/docs', query: { nxtPslug: '' } },
      { url: new URL('/docs', ORIGIN), rewrite: new URL('/en/docs', ORIGIN) },
    );

    expect(resolved.url).toBe('/en/docs?nxtPslug=&nxtPlocale=en');
  });
});
