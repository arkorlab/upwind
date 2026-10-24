import { type MiddlewareResult, resolveRoutes } from '@next/routing';
import type { Route } from '@stayingupwind/core/bundle';
import { describe, expect, it } from 'vitest';

import { settleRewrittenPath } from '../../src/rewritten-path.ts';
import { routingTables } from '../../src/routing.ts';
import { routerDynamicRoutes, routerPathnames, type Store } from '../../src/store.ts';

/**
 * The path a client router's payload was rendered for, where a rewrite changed it.
 *
 * Next.js says it as `x-nextjs-rewritten-path`, and the client reads its route's parameters off it.
 * A middleware's rewrite says its own; a rewrite of `next.config` after it says the path it ended on,
 * over the middleware's (16.4, `resolve-routes.ts`). Here the intercepting route a middleware's
 * rewrite led to was told of the middleware's path rather than its own
 * (`interception-dynamic-segment-middleware`).
 */

const ORIGIN = 'https://app.example';
const BUILD_ID = 'b';
const PATH_HEADER = 'x-nextjs-rewritten-path';

/** The rewrite an intercepting route `[locale]/@modal/(.)[username]/p/[id]` is reached by. */
const INTERCEPTION: Route = {
  sourceRegex: '^/(?<nxtPlocale>[^/]+?)/(?<nxtPusername>[^/]+?)/p/(?<nxtPid>[^/]+?)(?:/)?$',
  destination: '/$nxtPlocale/(.)$nxtPusername/p/$nxtPid',
  has: [{ type: 'header', key: 'next-url' }],
};
const QUERY_ONLY: Route = { sourceRegex: '^/search$', destination: '/search?from=rule' };
const REDIRECT: Route = {
  sourceRegex: '^/old$',
  destination: '/new',
  headers: { Location: '/new' },
  status: 307,
};
/** Two rules, the second of which takes the path back to where the first found it. */
const THERE: Route = { sourceRegex: '^/a$', destination: '/b' };
const BACK: Route = { sourceRegex: '^/b$', destination: '/a' };
const ELSEWHERE: Route = { sourceRegex: '^/ext$', destination: 'https://other.example/x' };
/** A rule ahead of the middleware, which then rewrites what the rule left. */
const AHEAD: Route = { sourceRegex: '^/pre$', destination: '/foo/pre' };
/** A rule ahead of the middleware, which then rewrites the query alone. */
const AHEAD_OF_QUERY: Route = { sourceRegex: '^/q$', destination: '/foo/query' };
/** A rule ahead of the middleware, which then sends the request to another origin. */
const AHEAD_OF_AWAY: Route = { sourceRegex: '^/off$', destination: '/foo/away' };
/** A destination past ASCII, which no header carries as it is. */
const ABROAD: Route = { sourceRegex: '^/jp$', destination: '/日本' };
/** A destination filled in from the path, of a rule that only asks the query something. */
const PREVIEWED: Route = {
  sourceRegex: '^/old/(?<nxtPslug>[^/]+?)$',
  destination: '/new/$nxtPslug',
  has: [{ type: 'query', key: 'preview' }],
};
/** A destination that takes in a query's value, which can be any character. */
const FOUND: Route = {
  sourceRegex: '^/find$',
  destination: '/found/$q',
  has: [{ type: 'query', key: 'q' }],
};

function storeOf(): Store {
  const manifest = {
    buildId: BUILD_ID,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: true,
      i18n: null,
    },
    routing: {
      beforeMiddleware: [REDIRECT, AHEAD, AHEAD_OF_QUERY, AHEAD_OF_AWAY],
      middlewareMatchers: [{ sourceRegex: '^/foo(?:/.*)?$' }],
      beforeFiles: [INTERCEPTION, QUERY_ONLY, THERE, BACK, ELSEWHERE, ABROAD, FOUND, PREVIEWED],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
    },
    entrypoints: [
      {
        id: '/[locale]/(.)[username]/p/[id]',
        kind: 'app-page' as const,
        pathname: '/en/(.)foo/p/1',
      },
      { id: '/search', kind: 'app-page' as const, pathname: '/search' },
    ],
    prerenders: [],
    staticFiles: [],
  };
  return {
    manifest,
    prerendersByPathname: new Map(),
    staticFiles: new Map(),
    ...routerPathnames(manifest),
    dynamicRoutes: routerDynamicRoutes(manifest),
  } as unknown as Store;
}

/**
 * A middleware that rewrites `/foo/…` behind the `en` locale, and says so as Next.js's does — and
 * `/foo/query` to its own path with a query, of which Next.js's says nothing.
 */
function middleware(url: URL): Promise<MiddlewareResult> {
  if (url.pathname === '/foo/query') {
    return Promise.resolve({ rewrite: new URL(`${url.pathname}?x=1`, url) });
  }
  if (url.pathname === '/foo/away') {
    return Promise.resolve({ rewrite: new URL(`https://other.example${url.pathname}`) });
  }
  const rewrite = new URL(`/en${url.pathname}`, url);
  return Promise.resolve({
    rewrite,
    responseHeaders: new Headers({ [PATH_HEADER]: rewrite.pathname }),
  });
}

/** Whether a header of the host's own is among a response's. */
function carriesMark(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (name.startsWith('x-arkor-')) {
      return true;
    }
  }
  return false;
}

/** The response headers routing settles on for a request, and whether the host's mark is left. */
async function headersFor(path: string, headers: Record<string, string>) {
  const store = storeOf();
  const url = new URL(path, ORIGIN);
  const request = new Headers(headers);
  let rewrite: URL | undefined;
  const result = await resolveRoutes({
    url,
    buildId: BUILD_ID,
    basePath: '',
    requestBody: new ReadableStream(),
    headers: request,
    pathnames: store.pathnames,
    routes: routingTables(store, false, url, false),
    invokeMiddleware: async (context) => {
      const answer = await middleware(context.url);
      ({ rewrite } = answer);
      return answer;
    },
  });
  settleRewrittenPath(result.resolvedHeaders, request, url, rewrite);
  const settled = result.resolvedHeaders ?? new Headers();
  return {
    path: settled.get(PATH_HEADER) ?? undefined,
    marked: carriesMark(settled),
  };
}

describe('the path a rewritten payload was rendered for', () => {
  it("is the intercepting route's, over the path of the middleware's rewrite before it", async () => {
    await expect(headersFor('/foo/p/1', { rsc: '1', 'next-url': '/' })).resolves.toStrictEqual({
      path: '/en/(.)foo/p/1',
      marked: false,
    });
  });

  it("is left as the middleware said it to a request that is not a client router's", async () => {
    await expect(headersFor('/foo/p/1', { 'next-url': '/' })).resolves.toStrictEqual({
      path: '/en/foo/p/1',
      marked: false,
    });
  });

  it('is said for a rewrite that changes the path back, as each rewrite is compared with its own', async () => {
    await expect(headersFor('/a', { rsc: '1' })).resolves.toStrictEqual({
      path: '/a',
      marked: false,
    });
  });

  it("is the middleware's over a rule's ahead of the middleware", async () => {
    await expect(headersFor('/pre', { rsc: '1' })).resolves.toStrictEqual({
      path: '/en/foo/pre',
      marked: false,
    });
  });

  it("is a rule's ahead of a middleware that rewrites the query alone", async () => {
    await expect(headersFor('/q', { rsc: '1' })).resolves.toStrictEqual({
      path: '/foo/query',
      marked: false,
    });
  });

  it("is not said where a middleware sends the request to another origin, a rule's ahead of it either", async () => {
    await expect(headersFor('/off', { rsc: '1' })).resolves.toStrictEqual({
      path: undefined,
      marked: false,
    });
  });

  it('is said, escaped, for a destination past ASCII', async () => {
    await expect(headersFor('/jp', { rsc: '1' })).resolves.toStrictEqual({
      path: '/%E6%97%A5%E6%9C%AC',
      marked: false,
    });
  });

  it('is said for a destination filled in from the path, though the rule asks the query something', async () => {
    await expect(headersFor('/old/x?preview=1', { rsc: '1' })).resolves.toStrictEqual({
      path: '/new/x',
      marked: false,
    });
  });

  it("is not said, and routing goes on, for a destination that takes in a query's value", async () => {
    await expect(headersFor('/find?q=日本', { rsc: '1' })).resolves.toStrictEqual({
      path: undefined,
      marked: false,
    });
  });

  it('is not said of a request rewritten to another origin', async () => {
    await expect(headersFor('/ext', { rsc: '1' })).resolves.toStrictEqual({
      path: undefined,
      marked: false,
    });
  });

  it('is not said where a rewrite changed the query alone, nor where a rule redirected', async () => {
    await expect(headersFor('/search', { rsc: '1' })).resolves.toStrictEqual({
      path: undefined,
      marked: false,
    });
    await expect(headersFor('/old', { rsc: '1' })).resolves.toStrictEqual({
      path: undefined,
      marked: false,
    });
  });
});
