import type { EntrypointKind } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { appRouteParameters } from '../src/route-parameters.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: vi.fn(() => Promise.resolve(new Response('rendered'))),
  };
});

const ROUTE = '/[lang]/open/[...slug]';
const MIDDLEWARE = '/_middleware';
const DESTINATION = `${ROUTE}?nxtPlang=$nxtPlang&nxtPslug=$nxtPslug`;
const DYNAMIC_ROUTE = {
  sourceRegex: '^/(?<nxtPlang>[^/]+?)/open/(?<nxtPslug>.+?)(?:/)?$',
  destination: DESTINATION,
};
const page: NodeHandler = () => Promise.resolve();

function deployment(
  kind: EntrypointKind = 'app-page',
  rewritten?: string,
  runtime?: 'edge',
): Store {
  const dynamicRoutes = [DYNAMIC_ROUTE];
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [{ sourceRegex: '^/.*$' }],
        beforeFiles:
          rewritten === undefined ? [] : [{ sourceRegex: '^/alias$', destination: rewritten }],
        afterFiles: [],
        dynamicRoutes,
        onMatch: [],
        fallback: [],
      },
      entrypoints: [
        { id: ROUTE, kind, pathname: ROUTE, ...(runtime !== undefined && { runtime }) },
      ],
    },
    pathnames: [ROUTE],
    slashSpellings: new Map(),
    dynamicRoutes,
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    renderedPages: new Set(),
  } as unknown as Store;
}

function handle(
  path: string,
  method = 'GET',
  rewritten?: string,
  edgeRoute?: WebHandler,
): Promise<Response> {
  const middleware: WebHandler = () => {
    return Promise.resolve(
      new Response(null, {
        headers: { 'x-middleware-rewrite': `https://app.test${rewritten}` },
      }),
    );
  };
  const app: AppModule = {
    entries: {
      ...(edgeRoute === undefined && { [ROUTE]: () => ({ handler: page }) }),
      ...(rewritten !== undefined && { [MIDDLEWARE]: () => ({ handler: middleware }) }),
    },
  };
  return handleRequest({
    app,
    edge: { entries: edgeRoute === undefined ? {} : { [ROUTE]: () => ({ handler: edgeRoute }) } },
    request: new Request(`https://app.test${path}`, { method }),
    waitUntil: () => {
      /* No work is scheduled. */
    },
  });
}

describe('an App Router catch-all whose segment contains an escaped slash', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // RouteModule.prepare reads requestMeta.params first. normalizeDynamicRouteParams preserves
  // arrays, including one-element arrays, whereas a prefixed query string is split at every '/'.
  it.each([
    ['/en/open/with%2Fslash', ['with/slash']],
    ['/en/open/with%2Fslash?nxtP=visible&ref=1', ['with/slash']],
    [
      '/en/open/docs/space%20here/with%2Fslash/fallback%25',
      ['docs', 'space here', 'with/slash', 'fallback%'],
    ],
    ['/en/open/literal%252Fslash/with%2fslash', ['literal%2Fslash', 'with/slash']],
  ] as const)(
    'hands %s to a document render with its segment boundaries intact',
    async (path, slug) => {
      await handle(path);

      expect(
        vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => {
          return {
            url: call.url,
            params: call.requestMeta['params'],
          };
        }),
      ).toStrictEqual([{ url: path, params: { lang: 'en', slug } }]);
    },
  );

  it.each(['app-page', 'app-route'] as const)(
    'preserves the same parameters for a POST to an %s',
    async (kind) => {
      vi.mocked(getStore).mockReturnValue(deployment(kind));

      await handle('/en/open/with%2Fslash', 'POST');

      expect(
        vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => {
          return {
            url: call.url,
            params: call.requestMeta['params'],
          };
        }),
      ).toStrictEqual([
        { url: '/en/open/with%2Fslash', params: { lang: 'en', slug: ['with/slash'] } },
      ]);
    },
  );

  it('keeps the values through a middleware rewrite from a path the template does not match', async () => {
    await handle('/alias', 'GET', '/en/open/with%2Fslash');

    expect(
      vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => {
        return {
          url: call.url,
          params: call.requestMeta['params'],
        };
      }),
    ).toStrictEqual([{ url: '/alias', params: { lang: 'en', slug: ['with/slash'] } }]);
  });

  it('keeps them through a configured rewrite and preserves the query the client sent', async () => {
    vi.mocked(getStore).mockReturnValue(deployment('app-page', '/en/open/with%2Fslash'));

    await handle('/alias?ref=1');

    expect(
      vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => {
        return {
          url: call.url,
          params: call.requestMeta['params'],
        };
      }),
    ).toStrictEqual([{ url: '/alias?ref=1', params: { lang: 'en', slug: ['with/slash'] } }]);
  });

  it.each(['app-page', 'app-route'] as const)(
    'uses the parameter protocol the edge %s handler reads after a middleware rewrite',
    async (kind) => {
      vi.mocked(getStore).mockReturnValue(deployment(kind, undefined, 'edge'));
      const handler = vi.fn<WebHandler>(() => Promise.resolve(new Response('edge render')));

      await handle('/alias', 'GET', '/en/open/with%2Fslash', handler);

      expect(
        handler.mock.calls.map(([request, context]) => {
          return {
            url: request.url,
            params: context.requestMeta?.['params'],
          };
        }),
      ).toStrictEqual([
        kind === 'app-page'
          ? { url: 'https://app.test/alias', params: { lang: 'en', slug: ['with/slash'] } }
          : { url: 'https://app.test/alias?nxtPlang=en&nxtPslug=with%2Fslash', params: undefined },
      ]);
      expect(invokeNodeHandler).not.toHaveBeenCalled();
    },
  );

  it('leaves ordinary catch-all parameters on their existing path and refuses malformed escapes', () => {
    const store = deployment();

    expect(appRouteParameters(store, ROUTE, '/en/open/a/b')).toBeUndefined();
    expect(appRouteParameters(store, ROUTE, '/en/open/literal%252Fslash')).toBeUndefined();
    expect(appRouteParameters(store, ROUTE, '/en/open/%E0%A4%A/a%2Fb')).toBeUndefined();
  });
});
