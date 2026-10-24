import { resolveRoutes } from '@next/routing';
import type { Route } from '@stayingupwind/core/bundle';
import { describe, expect, it } from 'vitest';

import { routingTables } from '../../src/routing.ts';
import { routerDynamicRoutes, routerPathnames, type Store } from '../../src/store.ts';

/**
 * A Pages Router data request of an application with `trailingSlash`.
 *
 * `@next/routing` normalizes `/_next/data/<build>/ssr-page.json` to `/ssr-page` before it matches a
 * single rule, and the redirect `next build` writes to give a path its trailing slash matched that:
 * the data request was sent to the page's document, and the client's router, handed HTML where it
 * asked for props, loaded the whole page. Next.js matches those redirects against the data
 * request's own path, which they leave alone.
 */

const BUILD_ID = 'b';
const DATA = `/_next/data/${BUILD_ID}/ssr-page.json`;

/** The rules `next build` writes itself for `trailingSlash`, as the routing it hands an adapter carries them. */
const INTERNAL: Route[] = [
  {
    source: String.raw`/:file((?!\.well-known(?:/.*)?)(?:[^/]+/)*[^/]+\.\w+)/`,
    sourceRegex: String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/]+\.\w+))\/$`,
    headers: { Location: '/$1' },
    missing: [{ type: 'header', key: 'x-nextjs-data' }],
    status: 308,
    priority: true,
  },
  {
    source: String.raw`/:notfile((?!\.well-known(?:/.*)?)(?:[^/]+/)*[^/\.]+)`,
    sourceRegex: String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/\.]+))$`,
    headers: { Location: '/$1/' },
    status: 308,
    priority: true,
  },
];

function storeOf(): Store {
  const manifest = {
    buildId: BUILD_ID,
    config: {
      basePath: '',
      trailingSlash: true,
      skipTrailingSlashRedirect: false,
      poweredByHeader: true,
      i18n: null,
    },
    routing: {
      beforeMiddleware: INTERNAL,
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: true,
    },
    entrypoints: [
      { id: '/ssr-page', kind: 'pages' as const, pathname: '/ssr-page' },
      { id: DATA, kind: 'pages' as const, pathname: DATA },
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

/** What the router makes of a request: where it resolved, or the redirect it answered with. */
async function routed(path: string, headers: Record<string, string> = {}) {
  const store = storeOf();
  const url = new URL(`https://app.example${path}`);
  const result = await resolveRoutes({
    url,
    buildId: BUILD_ID,
    basePath: '',
    requestBody: new ReadableStream(),
    headers: new Headers(headers),
    pathnames: store.pathnames,
    routes: routingTables(store, true, url, false),
    invokeMiddleware: () => Promise.resolve({}),
  });
  return {
    resolved: result.resolvedPathname,
    status: result.status,
    location: result.resolvedHeaders?.get('location') ?? undefined,
  };
}

describe('a data request of an application that keeps its pages under a trailing slash', () => {
  it('resolves to its data route rather than being redirected to the page', async () => {
    await expect(routed(DATA, { 'x-nextjs-data': '1' })).resolves.toStrictEqual({
      resolved: DATA,
      status: undefined,
      location: undefined,
    });
  });

  it('leaves the page asked for without its slash to the redirect', async () => {
    await expect(routed('/ssr-page')).resolves.toStrictEqual({
      resolved: undefined,
      status: 308,
      location: '/ssr-page/',
    });
  });
});
