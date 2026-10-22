import type { DeploymentBundle, EntrypointKind, Prerender } from '@stayingupwind/core/bundle';

export const SHARED_SHELL: Prerender = {
  id: 'shared',
  route: '/prefix/[one]/[two]',
  pathname: '/prefix/b/[two]',
  parentOutputId: 'page',
  groupId: 1,
  routeType: 'shell',
  response: 'initial',
  compute: 'resuming',
  renderingMode: 'PARTIALLY_STATIC',
  body: { sha256: 'a'.repeat(64), byteLength: 10, contentType: 'text/html' },
  postponed: { sha256: 'b'.repeat(64), byteLength: 5, contentType: 'application/json' },
};

export function shellBundle(
  prerender = SHARED_SHELL,
  kind: EntrypointKind = 'app-page',
): DeploymentBundle {
  return {
    v: 1,
    deploymentId: 'dpl_shared',
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: '2026-10-18T00:00:00.000Z',
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
      cacheComponents: true,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
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
    entrypoints: [{ id: 'page', kind, pathname: prerender.route }],
    prerenders: [prerender],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: '2026-09-11',
        compatibilityFlags: [],
      },
    },
  };
}
