import type { Prerender } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { ownerOfResolved } from '../src/placement.ts';
import type { RoutedInput } from '../src/serve.ts';
import { routerPathnames, type Store } from '../src/store.ts';
import { renderedBy } from '../src/with-body.ts';

/**
 * A class narrower than its route: `/closed-prefix/t1/[bottom]` of `/closed-prefix/[top]/[bottom]`,
 * whose leading parameter the build closed (16.4's `unstable_paramMatching`, or
 * `generateStaticParams` beside `dynamicParams = false`) and whose trailing one it left open. The
 * build gives the class a matcher of its own ahead of the route's — whose conditions, the route
 * being closed, are draft mode's — and the class's destination is its own name. A member of it the
 * build did not render resolved nowhere: a 404 where Next.js renders it
 * (`app-dir/param-matching-ensure-static`).
 */

// Nothing is rendered here; the bridge's own module needs the Workers runtime.
function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const ROUTE = '/closed-prefix/[top]/[bottom]';
const CLASS = '/closed-prefix/t1/[bottom]';
const page: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [ROUTE]: () => ({ handler: page }) } };

function prerender(pathname: string, route: string, fields: Partial<Prerender> = {}): Prerender {
  return { id: pathname, pathname, route, parentOutputId: route, groupId: 1, ...fields };
}

const PRERENDERS = [
  // The route's own entry, which the build closed.
  prerender(ROUTE, ROUTE, { allowQuery: ['nxtPtop', 'nxtPbottom'] }),
  // The class whose leading parameter it resolved: a member's entry of a route that blocks.
  prerender(CLASS, ROUTE, {
    routeType: 'page',
    response: 'empty',
    compute: 'blocking',
    allowQuery: ['nxtPbottom'],
  }),
  // A member the build rendered, which its own route's matchers reach.
  prerender('/closed-prefix/t1/b1', ROUTE, {
    routeType: 'page',
    response: 'complete',
    compute: 'static',
    parentFallbackMode: null,
  }),
];

function manifestOf(
  prerenders: readonly Prerender[],
  entrypoint = ROUTE,
): Parameters<typeof routerPathnames>[0] {
  return {
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: true,
    },
    entrypoints: [{ id: entrypoint, kind: 'app-page', pathname: entrypoint }],
    prerenders: [...prerenders],
    staticFiles: [],
  };
}

describe('a class narrower than its route', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is resolved by its own name, as its matcher names it, and nothing else of the route is', () => {
    expect(routerPathnames(manifestOf(PRERENDERS)).pathnames).toStrictEqual([ROUTE, CLASS]);
  });

  /** A locale's template leads with one more segment than its route: it is the route's own. */
  it('is not a locale’s template', () => {
    const route = '/blog/[slug]';
    const locale = prerender('/en/blog/[slug]', route, { routeType: 'fallback' });

    expect(routerPathnames(manifestOf([locale], route)).pathnames).toStrictEqual([route]);
  });

  /** In a build split across app Functions, the class's member goes where its route's code is. */
  it('is handed to the app Function its route is in', () => {
    const store = {
      manifest: {
        entrypoints: [{ id: ROUTE, kind: 'app-page', pathname: ROUTE, function: 'app-2' }],
      },
      staticFiles: new Map(),
      prerendersByPathname: new Map(PRERENDERS.map((each) => [each.pathname, each])),
    } as unknown as Store;
    const member = { route: CLASS, pathname: '/closed-prefix/t1/b2', url: '/closed-prefix/t1/b2' };

    expect(ownerOfResolved(store, member)).toBe('app-2');
  });

  it('is rendered by its route’s entrypoint, under the route its shell is filed under', async () => {
    const store = {
      prerendersByPathname: new Map(PRERENDERS.map((each) => [each.pathname, each])),
    } as unknown as Store;
    const request = new Request('https://app.test/closed-prefix/t1/b2');
    const input = {
      app,
      edge: { entries: {} },
      request,
      waitUntil: () => {
        // Nothing is rendered here.
      },
      initURL: request.url,
      run: (work: () => unknown) => work(),
    } as unknown as RoutedInput;
    const member = { route: CLASS, pathname: '/closed-prefix/t1/b2', url: '/closed-prefix/t1/b2' };

    const rendered = await renderedBy(input, store, member);

    expect(rendered?.entry.kind).toBe('node');
    expect(rendered?.resolved).toStrictEqual({ ...member, route: ROUTE });
  });
});
