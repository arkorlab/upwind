import { sha256Hex } from '@stayingupwind/core/artifact';
import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import { encodeUtf8 } from '@stayingupwind/core/util';

import { shellBundle } from './shared-shell-fixture.ts';

export const FALLBACK_ROUTE = '/fallback-true/[slug]';
export const BUILT_PATH = '/fallback-true/first';
export const LAZY_PATH = '/fallback-true/second';
export const FALLBACK_NOW = 1_800_000_000_000;

async function body(
  bytes: Uint8Array,
  contentType: string,
): Promise<NonNullable<Prerender['body']>> {
  return {
    sha256: await sha256Hex(bytes),
    byteLength: bytes.byteLength,
    contentType,
  };
}

/** Native descriptor shapes: the JSON twin has no compute/response and the class is only initial. */
export async function fallbackPageFixture(): Promise<{
  bundle: DeploymentBundle;
  page: Prerender;
  twin: Prerender;
  fallback: Prerender;
  html: Uint8Array;
  data: Uint8Array;
  loading: Uint8Array;
}> {
  const html = encodeUtf8('<!doctype html><p>built first</p>');
  const data = encodeUtf8('{"pageProps":{"slug":"first"},"__N_SSG":true}');
  const loading = encodeUtf8('<!doctype html><p>hi fallback</p>');
  const page: Prerender = {
    id: 'first',
    route: FALLBACK_ROUTE,
    pathname: BUILT_PATH,
    parentOutputId: 'page',
    groupId: 1,
    routeType: 'page',
    compute: 'static',
    response: 'complete',
    initialStatus: 200,
    parentFallbackMode: `${FALLBACK_ROUTE}.html`,
    initialRevalidate: 2,
    initialExpiration: 60,
    allowQuery: ['nxtPslug'],
    allowHeader: ['host', 'x-prerender-revalidate'],
    initialHeaders: { 'content-type': 'text/html; charset=utf-8' },
    body: await body(html, 'text/html; charset=utf-8'),
  };
  const twin: Prerender = {
    ...page,
    id: 'first-data',
    pathname: '/_next/data/build/fallback-true/first.json',
    routeType: undefined,
    compute: undefined,
    response: undefined,
    initialHeaders: { 'content-type': 'application/json' },
    body: await body(data, 'application/json'),
  };
  const fallback: Prerender = {
    ...page,
    id: 'fallback',
    pathname: FALLBACK_ROUTE,
    groupId: 2,
    routeType: 'fallback',
    response: 'initial',
    parentFallbackMode: undefined,
    initialRevalidate: 1,
    initialExpiration: undefined,
    body: await body(loading, 'text/html'),
  };
  const base = shellBundle(page, 'pages');
  const bundle: DeploymentBundle = {
    ...base,
    staticPagesPrivacy: 3,
    config: { ...base.config, cacheComponents: false },
    routing: {
      ...base.routing,
      dynamicRoutes: [
        { sourceRegex: '^/fallback-true/([^/]+?)(?:/)?$', destination: FALLBACK_ROUTE },
      ],
    },
    prerenders: [page, twin, fallback],
  };
  return { bundle, page, twin, fallback, html, data, loading };
}
