import { namesSpelledBy } from '@stayingupwind/core/bundle';
import { describe, expect, it, vi } from 'vitest';

import { escapedNameOf } from '../src/name-spellings.ts';
import { routingOf, untraced } from '../src/resolve-request.ts';
import { landedRoute, pathnamesFor, routedHeaders } from '../src/routing.ts';
import { routerDynamicRoutes, routerPathnames, type Store } from '../src/store.ts';

/**
 * The route the deployment's router lands a request on, for the requests a host asks a route's
 * gate of before it serves them (`gateFor`, in `@stayingupwind/core/manifest`), which the host
 * reads as this router reads them: the router running for real on a deployment of a few pages.
 */

// Nothing is rendered: only where the router lands each request is asked.
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const POST = '/posts/[slug]';
const ALL = '/[...all]';

/** A rewrite of `next.config`, as Next.js compiles one; or a dynamic route, which lands a path. */
interface Rewrite {
  readonly sourceRegex: string;
  readonly destination: string;
  readonly has?: readonly { readonly type: 'query' | 'header'; readonly key: string }[];
}

/** A page the build prerendered, of the route it is a member of; one of a closed route's members. */
interface Prerendered {
  readonly pathname: string;
  readonly route: string;
  readonly parentFallbackMode?: false;
}

interface Deployment {
  readonly basePath?: string;
  readonly trailingSlash?: boolean;
  /** Pages of their own beside the deployment's. */
  readonly pages?: readonly string[];
  /** The files the build ships, by their names. */
  readonly files?: readonly string[];
  /** Dynamic routes ahead of the deployment's own. */
  readonly leading?: readonly Rewrite[];
  readonly afterFiles?: readonly Rewrite[];
  readonly prerenders?: readonly Prerendered[];
}

/** A deployment of a class of posts, a catch-all, and two pages of their own, under `basePath`. */
function deployment(options: Deployment = {}): Store {
  const base = options.basePath ?? '';
  const pathnames = [POST, ALL, '/private', '/private/area', ...(options.pages ?? [])].map(
    (name) => `${base}${name}`,
  );
  const manifest = {
    buildId: 'b',
    config: { basePath: base, trailingSlash: options.trailingSlash ?? false },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: options.afterFiles ?? [],
      dynamicRoutes: [
        ...(options.leading ?? []),
        {
          source: `${base}${POST}`,
          sourceRegex: `^${base}/posts/(?<nxtPslug>[^/]+?)(?:/)?$`,
          destination: `${base}${POST}?nxtPslug=$nxtPslug`,
        },
        {
          source: `${base}${ALL}`,
          sourceRegex: `^${base}/(?<nxtPall>.+?)(?:/)?$`,
          destination: `${base}${ALL}?nxtPall=$nxtPall`,
        },
      ],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
    },
    entrypoints: pathnames.map((pathname) => ({ id: pathname, kind: 'app-page', pathname })),
    prerenders: (options.prerenders ?? []).map((prerender) => {
      return {
        ...prerender,
        id: prerender.pathname,
        parentOutputId: prerender.pathname,
        groupId: 1,
      };
    }),
    staticFiles: (options.files ?? []).map((pathname) => ({ pathname })),
  };
  return {
    manifest,
    prerendersById: new Map(),
    prerendersByPathname: new Map(
      manifest.prerenders.map((prerender) => [prerender.pathname, prerender]),
    ),
    shellsByRoute: new Map(),
    staticFiles: new Map(manifest.staticFiles.map((file) => [file.pathname, file])),
    ...routerPathnames(manifest as never),
    dynamicRoutes: routerDynamicRoutes(manifest as never),
    renderedPages: new Set(),
  } as unknown as Store;
}

/** The route the router lands a request for `path` on, or `undefined` where it finds none. */
async function landing(store: Store, path: string): Promise<string | undefined> {
  const url = new URL(path, 'https://app.test');
  const headers = routedHeaders(new Request(url), url, store.manifest.config.basePath);
  const { resolvedPathname, invocationTarget } = await routingOf({} as never, store, {
    url,
    headers,
    body: undefined,
    skipMiddleware: true,
    trace: untraced(),
  });
  return resolvedPathname === undefined || invocationTarget === undefined
    ? undefined
    : landedRoute(store, resolvedPathname, invocationTarget).route;
}

/**
 * The page the router serves a request for `path` as: the name it resolved, read back as the build
 * named it (`resolvedOf`) — escaped, and then behind a trailing slash.
 */
async function servedPage(store: Store, path: string): Promise<string | undefined> {
  const route = await landing(store, path);
  if (route === undefined) {
    return undefined;
  }
  const unescaped = escapedNameOf(store, route) ?? route;
  return store.slashSpellings.get(unescaped) ?? unescaped;
}

describe('where the router lands a request a gate is asked of', () => {
  /**
   * A member the build prerendered is no name the router resolves, but for the few it does
   * (`resolvedByName`): it is reached through the dynamic routes, the first that holds of it
   * winning, a class ahead of the member's own among them.
   */
  it('lands a member the build prerendered on the first dynamic route that holds of it', async () => {
    const store = deployment({ prerenders: [{ pathname: '/posts/demo', route: ALL }] });

    await expect(landing(store, '/posts/demo')).resolves.toBe(POST);
  });

  it('matches a class without regard to case', async () => {
    await expect(landing(deployment(), '/POSTS/abc')).resolves.toBe(POST);
  });

  it('lands a rewrite to a page of its own written escaped on that page', async () => {
    const store = deployment({
      afterFiles: [{ sourceRegex: '^/alias$', destination: '/private%2Farea' }],
    });

    await expect(landing(store, '/alias')).resolves.toBe('/private/area');
  });

  /**
   * What a rewrite puts in the path is resolved with it: a value of the query may hold `/` and `..`,
   * and part of a segment may be `..` — while a whole segment of the request's path never is, the
   * path's dot segments resolved before any rule is matched against it.
   */
  it('resolves the dot segments a rewrite puts in, whatever it writes ahead of them', async () => {
    const store = deployment({
      afterFiles: [
        {
          sourceRegex: String.raw`^\/alias(?:\/)?$`,
          has: [{ type: 'query', key: 'target' }],
          destination: '/public/$target',
        },
        {
          sourceRegex: String.raw`^\/img(?:\/([^\/]+?))\.png(?:\/)?$`,
          destination: '/public/$1/private',
        },
        { sourceRegex: String.raw`^\/p(?:\/([^\/]+?))(?:\/)?$`, destination: '/public/$1/area' },
      ],
    });

    await expect(landing(store, '/alias?target=../private')).resolves.toBe('/private');
    await expect(landing(store, '/img/...png')).resolves.toBe('/private');
    // The request's own `..` is resolved before the rule is asked: `/p/..` is `/`.
    await expect(landing(store, '/p/%2e%2e')).resolves.toBeUndefined();
  });

  /**
   * The router is handed more names than the build's own: each page's spelling behind the trailing
   * slash an application keeps its pages behind, and the escaped spellings of a page of its own. A
   * dynamic route whose destination is one of them lands a request on the page it spells, ahead of
   * the catch-all after it — as the checks a build's gates are held to read it (`namesSpelledBy`).
   */
  it.each([
    ['behind a trailing slash', '/private/', '/private', true],
    ['escaped', '/sticks%20%26%20stones', '/sticks & stones', false],
  ])(
    'lands a dynamic route on a page it names spelled %s',
    async (_, destination, page, trailingSlash) => {
      const store = deployment({
        trailingSlash,
        pages: ['/sticks & stones'],
        leading: [{ sourceRegex: '^/door(?:/)?$', destination }],
      });

      await expect(servedPage(store, '/door')).resolves.toBe(page);
    },
  );

  /**
   * Every name the runtime hands the router beyond the build's own (`routerPathnames`) — the escaped
   * spellings of each, a rewrite's path written out in full among them (`namesWithSpellings`), and a
   * request's own (`pathnamesFor`) — is one the checks a build's gates are held to read back as a
   * name (`namesSpelledBy`): they follow the router to every name it lands a path on.
   */
  it('hands the router no name the checks of a build’s gates cannot read back', () => {
    const store = deployment({
      trailingSlash: true,
      pages: ['/café', '/sticks & stones', "/rock'n"],
      files: ['/files/read%20me.txt', '/files/menü.txt'],
      prerenders: [
        { pathname: '/posts/記事', route: POST, parentFallbackMode: false },
        { pathname: '/posts/a%2Fb', route: POST, parentFallbackMode: false },
      ],
      afterFiles: [{ sourceRegex: '^/alias$', destination: '/caf%c3%A9' }],
    });
    const named = new Set(store.pathnames);
    const handed = [
      '/door',
      '/caf%c3%a9',
      '/caf%C3%A9/',
      '/sticks%20%26%20stones',
      '/rock%27n',
      '/posts/%E8%A8%98%E4%BA%8B',
      '/posts/a%2fb',
      '/files/men%C3%BC.txt',
    ].flatMap((path) => pathnamesFor(store, new URL(path, 'https://app.test')));
    const beyond = handed.filter((name) => !named.has(name));

    expect(beyond).toContain('/caf%c3%A9');
    expect(beyond.filter((name) => namesSpelledBy(name, named).length === 0)).toStrictEqual([]);
  });

  it('routes a path in Next.js’s namespace that names nothing to the class it matches', async () => {
    await expect(landing(deployment(), '/_next/missing.js')).resolves.toBe(ALL);
    await expect(landing(deployment(), '/_next/static/chunks/missing.js')).resolves.toBe(ALL);
  });

  it('routes a path in Next.js’s namespace under a base path to the class it matches', async () => {
    const store = deployment({ basePath: '/docs' });

    await expect(landing(store, '/docs/_next/missing.js')).resolves.toBe(`/docs${ALL}`);
  });
});
