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

interface Deployment {
  readonly buildId?: string;
  readonly basePath?: string;
  /** Whether the router reads a Pages Router data URL as the page it names. */
  readonly normalized?: boolean;
  readonly afterFiles?: readonly { sourceRegex: string; destination: string }[];
}

/** A deployment of a class of posts, a catch-all, and two pages of their own, under `basePath`. */
function deployment(options: Deployment = {}): Store {
  const base = options.basePath ?? '';
  const pathnames = [POST, ALL, '/private', '/private/area'].map((name) => `${base}${name}`);
  const manifest = {
    buildId: options.buildId ?? 'b',
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
      shouldNormalizeNextData: options.normalized ?? false,
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
  it('lands a data URL on the page it names, whether or not it ends in `.json`', async () => {
    const store = deployment({ normalized: true });

    await expect(landing(store, '/_next/data/b/posts/abc.json')).resolves.toBe(POST);
    await expect(landing(store, '/_next/data/b/posts/abc')).resolves.toBe(POST);
  });

  /** It compares the request's path, which a URL escapes, with the build id as written. */
  it('routes a data URL under a build id a URL escapes as the path it is', async () => {
    const store = deployment({ normalized: true, buildId: 'release 1' });

    await expect(landing(store, '/_next/data/release%201/posts/abc.json')).resolves.toBe(ALL);
  });

  it('lands a data URL on a page of its own it names, in place of the class it matched', async () => {
    const store = deployment({ normalized: true });

    await expect(landing(store, '/_next/data/b/private.json')).resolves.toBe('/private');
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

  it('routes a path in Next.js’s namespace under a base path to the class it matches', async () => {
    const store = deployment({ basePath: '/docs' });

    await expect(landing(store, '/docs/_next/missing.js')).resolves.toBe(`/docs${ALL}`);
  });
});
