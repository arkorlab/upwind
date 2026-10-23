import { describe, expect, it } from 'vitest';

import { cacheablePrerenders } from '../src/bundle/index.ts';
import type { DeploymentBundle, Prerender } from '../src/bundle/schema.ts';

const HTML = { sha256: 'a'.repeat(64), byteLength: 10, contentType: 'text/html' };
const STATE = { sha256: 'b'.repeat(64), byteLength: 5, contentType: 'application/json' };

/** A prerender of `route` at `pathname`, as the build classifies its outputs (16.3 on). */
function prerender(id: string, route: string, fields: Partial<Prerender>): Prerender {
  return {
    id,
    route,
    pathname: route,
    parentOutputId: route,
    groupId: 1,
    renderingMode: 'PARTIALLY_STATIC',
    body: HTML,
    ...fields,
  };
}

/** A complete page, which the edge serves whole. */
const ABOUT = prerender('about', '/about', {
  routeType: 'page',
  response: 'complete',
  compute: 'static',
});
/** A shared resumable shell, which postponed what reads its slug and so keeps no keys. */
const BLOG = prerender('blog', '/blog/[slug]', {
  routeType: 'shell',
  response: 'initial',
  compute: 'resuming',
  postponed: STATE,
  allowQuery: [],
});
/**
 * `client-params-shallow-routing`'s shell as Next.js 16.4.2 builds it: nothing postponed, and
 * so keyed by every route key, though nothing renders `id` into it.
 */
const PAGE_PARAMS = prerender('page-params', '/page-params/[id]', {
  routeType: 'shell',
  response: 'initial',
  compute: 'static',
  allowQuery: ['nxtPid'],
});
/** The same shell, keyed by a query besides its parameter as well: no one entry stands for it. */
const SEARCH = prerender('search', '/search/[id]', {
  routeType: 'shell',
  response: 'initial',
  compute: 'static',
  allowQuery: ['nxtPid', 'q'],
});
/** A root fallback, keyed by the root parameter each of its members is rendered for. */
const NESTED = prerender('nested', '/[lang]/nested', {
  routeType: 'fallback',
  response: 'initial',
  compute: 'resuming',
  postponed: STATE,
  allowQuery: ['nxtPlang'],
});
/** A route handler the build rendered. */
const FEED = prerender('feed', '/api/feed', {
  routeType: 'route',
  response: 'complete',
  compute: 'static',
  renderingMode: 'STATIC',
  body: { ...HTML, contentType: 'text/csv' },
});

function bundleOf(prerenders: readonly Prerender[]): DeploymentBundle {
  return {
    v: 1,
    deploymentId: 'dpl_cacheable',
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: '2026-10-23T00:00:00.000Z',
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
    entrypoints: prerenders.map((each) => {
      return {
        id: each.route,
        kind: each.routeType === 'route' ? 'app-route' : 'app-page',
        pathname: each.route,
      };
    }),
    prerenders: [...prerenders],
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

describe('the prerenders a deployment seeds its runtime cache with', () => {
  it("takes a terminal shell's own entry beside every other it took, and no more", () => {
    const bundle = bundleOf([ABOUT, BLOG, PAGE_PARAMS, SEARCH, NESTED, FEED]);

    // The resumable and complete documents first, as they were, then the terminal shell, whose
    // pathname its members' entry is keyed by alone, then the handler. A shell that also varies on
    // a query of its own, and a fallback keyed by its root, stay out, as they were.
    expect(cacheablePrerenders(bundle).map((each) => each.id)).toStrictEqual([
      'blog',
      'about',
      'page-params',
      'feed',
    ]);
  });

  it('leaves out a terminal shell no generation could be served from', () => {
    const elsewhere = bundleOf([PAGE_PARAMS]);
    const onTheEdge: DeploymentBundle = {
      ...elsewhere,
      entrypoints: elsewhere.entrypoints.map((entry) => ({ ...entry, runtime: 'edge' })),
    };
    const failing = bundleOf([{ ...PAGE_PARAMS, initialStatus: 500 }]);

    expect(cacheablePrerenders(elsewhere).map((each) => each.id)).toStrictEqual(['page-params']);
    expect(cacheablePrerenders(onTheEdge)).toStrictEqual([]);
    expect(cacheablePrerenders(failing)).toStrictEqual([]);
  });
});
