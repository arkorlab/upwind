import type { DeploymentBundle, Prerender } from '../src/bundle/schema.ts';
import { createId } from '../src/util/index.ts';

export const FALLBACK_ROUTE = '/fallback-true/[slug]';
export const FALLBACK_PAGE: Prerender = {
  id: FALLBACK_ROUTE,
  pathname: FALLBACK_ROUTE,
  route: FALLBACK_ROUTE,
  parentOutputId: 'page',
  groupId: 2,
  routeType: 'fallback',
  response: 'initial',
  compute: 'static',
  initialRevalidate: 1,
  allowQuery: ['nxtPslug'],
  body: { sha256: 'a'.repeat(64), byteLength: 100, contentType: 'text/html' },
};
export const FALLBACK_MEMBER: Prerender = {
  ...FALLBACK_PAGE,
  id: '/fallback-true/first',
  pathname: '/fallback-true/first',
  groupId: 1,
  routeType: 'page',
  response: 'complete',
  parentFallbackMode: '/fallback-true/[slug].html',
  initialRevalidate: 2,
  initialExpiration: 31_536_000,
};
export const FALLBACK_DATA: Prerender = {
  ...FALLBACK_MEMBER,
  id: '/_next/data/build/fallback-true/first.json',
  pathname: '/_next/data/build/fallback-true/first.json',
  routeType: undefined,
  response: undefined,
  compute: undefined,
  body: { sha256: 'b'.repeat(64), byteLength: 50, contentType: 'application/json' },
};
export function fallbackBundle(extra: Partial<DeploymentBundle> = {}): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: '2026-10-20T00:00:00.000Z',
    staticPagesPrivacy: 3,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [
        { sourceRegex: '^/fallback-true/([^/]+?)(?:/)?$', destination: FALLBACK_ROUTE },
      ],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc',
        prefetchHeader: 'next-router-prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [{ id: 'page', kind: 'pages', pathname: FALLBACK_ROUTE }],
    prerenders: [FALLBACK_MEMBER, FALLBACK_DATA, FALLBACK_PAGE],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: '2026-10-01',
        compatibilityFlags: [],
      },
    },
    ...extra,
  };
}
