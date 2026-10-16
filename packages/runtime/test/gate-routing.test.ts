import { describe, expect, it, vi } from 'vitest';

import { routingOf, untraced } from '../src/resolve-request.ts';
import { landedRoute, routedHeaders } from '../src/routing.ts';
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

/** A rewrite of `next.config`, as Next.js compiles one. */
interface Rewrite {
  readonly sourceRegex: string;
  readonly destination: string;
  readonly has?: readonly { readonly type: 'query' | 'header'; readonly key: string }[];
}

interface Deployment {
  readonly basePath?: string;
  readonly afterFiles?: readonly Rewrite[];
}

/** A deployment of a class of posts, a catch-all, and two pages of their own, under `basePath`. */
function deployment(options: Deployment = {}): Store {
  const base = options.basePath ?? '';
  const pathnames = [POST, ALL, '/private', '/private/area'].map((name) => `${base}${name}`);
  const manifest = {
    buildId: 'b',
    config: { basePath: base },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: options.afterFiles ?? [],
      dynamicRoutes: [
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
    prerenders: [],
    staticFiles: [],
  };
  return {
    manifest,
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    shellsByRoute: new Map(),
    staticFiles: new Map(),
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

describe('where the router lands a request a gate is asked of', () => {
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

  it('routes a path in Next.js’s namespace that names nothing to the class it matches', async () => {
    await expect(landing(deployment(), '/_next/missing.js')).resolves.toBe(ALL);
    await expect(landing(deployment(), '/_next/static/chunks/missing.js')).resolves.toBe(ALL);
  });

  it('routes a path in Next.js’s namespace under a base path to the class it matches', async () => {
    const store = deployment({ basePath: '/docs' });

    await expect(landing(store, '/docs/_next/missing.js')).resolves.toBe(`/docs${ALL}`);
  });
});
