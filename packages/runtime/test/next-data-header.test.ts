import { MIDDLEWARE_ONLY_HEADER } from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { servePagesData } from '../src/outputs.ts';
import type { RoutedInput } from '../src/serve.ts';
import {
  deploymentConfig,
  getStore,
  routerDynamicRoutes,
  routerPathnames,
  type Store,
} from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, deploymentConfig: vi.fn(), getStore: vi.fn() };
});

// The bridge is Cloudflare's alone, and nothing here renders through it: the middleware answers.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

/**
 * What the middleware is told about a Pages Router data request.
 *
 * A client navigation fetches `/_next/data/<build>/<page>.json`, and the middleware answers one
 * with `x-nextjs-redirect` or `x-nextjs-rewrite` for the client's router to follow — which it does
 * only when the request carries `x-nextjs-data`. A client cannot send that header: the edge strips
 * it, as Next.js strips it from what a client sends. So the router sets it from the path, as
 * Next.js's does (`server/lib/router-utils/resolve-routes.ts`). Without it, a redirect in the
 * middleware of a Pages Router application sent the client back a `Location` its data fetch could
 * not use, and the navigation became a full page load.
 */

const MIDDLEWARE = '/_middleware';
const DATA_HEADER = 'x-nextjs-data';
const BUILD_ID = 'build';

function deployment(basePath = '', skipProxyUrlNormalize?: boolean, trailingSlash = false): Store {
  return {
    manifest: {
      buildId: BUILD_ID,
      config: { basePath, skipProxyUrlNormalize, trailingSlash },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [{ sourceRegex: '^/.*$' }],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: true,
      },
      entrypoints: [],
    },
    pathnames: [],
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersByPathname: new Map(),
  } as unknown as Store;
}

/** A middleware that answers with what it was told: the header's value, or `absent`. */
const middleware: WebHandler = (request) =>
  Promise.resolve(new Response(request.headers.get(DATA_HEADER) ?? 'absent'));
const app: AppModule = { entries: { [MIDDLEWARE]: () => ({ handler: middleware }) } };

/** A middleware that answers with the URL it was handed, less its origin. */
const echoing: WebHandler = (request) => {
  const url = new URL(request.url);
  return Promise.resolve(new Response(`${url.pathname}${url.search}`));
};

/** A middleware that lets every request through, as `NextResponse.next()` does. */
const continuing: WebHandler = () =>
  Promise.resolve(new Response(null, { headers: { 'x-middleware-next': '1' } }));

/** An entry nothing here may render: each request is answered before a render. */
const unrendered = () => ({ handler: () => Promise.reject(new Error('rendered')) });

async function toldTheMiddleware(
  path: string,
  headers: Record<string, string> = {},
  module: AppModule = app,
) {
  const response = await handleRequest({
    app: module,
    edge: { entries: {} },
    request: new Request(`https://app.test${path}`, { headers }),
    waitUntil: () => {
      // Nothing here schedules background work.
    },
  });
  return response.text();
}

describe('a data request, as the middleware is told of it', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    // What a request for the middleware alone reads instead of the store.
    vi.mocked(deploymentConfig).mockReturnValue(deployment().manifest.config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is marked from its path, though the client sent nothing', async () => {
    await expect(toldTheMiddleware(`/_next/data/${BUILD_ID}/en/old-home.json`)).resolves.toBe('1');
  });

  it('is not marked for a page, whatever the client sent', async () => {
    await expect(toldTheMiddleware('/en/old-home', { [DATA_HEADER]: '1' })).resolves.toBe('absent');
  });

  it('is marked beneath the base path', async () => {
    vi.mocked(getStore).mockReturnValue(deployment('/docs'));

    await expect(toldTheMiddleware(`/docs/_next/data/${BUILD_ID}/page.json`)).resolves.toBe('1');
  });

  /**
   * Next.js hands a middleware the page a data request is for (`runMiddleware`), and the
   * middleware's adapter writes `x-nextjs-redirect` and `x-nextjs-rewrite` in the form of the URL it
   * was handed: handed the data URL, it sent the client's router a data URL back for a page.
   */
  it.each([
    {
      path: `/_next/data/${BUILD_ID}/es/old-home.json?override=internal`,
      basePath: '',
      handed: '/es/old-home?override=internal',
    },
    { path: `/_next/data/${BUILD_ID}/index.json`, basePath: '', handed: '/' },
    { path: `/docs/_next/data/${BUILD_ID}/page.json`, basePath: '/docs', handed: '/docs/page' },
    { path: `/docs/_next/data/${BUILD_ID}/index.json`, basePath: '/docs', handed: '/docs' },
    {
      path: '/_next/data/another/page.json',
      basePath: '',
      handed: '/_next/data/another/page.json',
    },
  ])('is handed the page it is for: $path', async ({ path, basePath, handed }) => {
    vi.mocked(getStore).mockReturnValue(deployment(basePath));
    const module = { entries: { [MIDDLEWARE]: () => ({ handler: echoing }) } };

    await expect(toldTheMiddleware(path, {}, module)).resolves.toBe(handed);
  });

  /**
   * Where the application keeps its pages under a trailing slash, the page is handed with it, as
   * Next.js hands it (`maybeAddTrailingSlash`): a middleware that asks for `/ssr-page/` did not
   * recognize the data request for it (`middleware-trailing-slash`).
   */
  it.each([
    { path: `/_next/data/${BUILD_ID}/ssr-page.json?x=1`, basePath: '', handed: '/ssr-page/?x=1' },
    { path: `/_next/data/${BUILD_ID}/index.json`, basePath: '', handed: '/' },
    { path: `/docs/_next/data/${BUILD_ID}/index.json`, basePath: '/docs', handed: '/docs/' },
  ])('is handed the page with its trailing slash: $path', async ({ path, basePath, handed }) => {
    vi.mocked(getStore).mockReturnValue(deployment(basePath, undefined, true));
    const module = { entries: { [MIDDLEWARE]: () => ({ handler: echoing }) } };

    await expect(toldTheMiddleware(path, {}, module)).resolves.toBe(handed);
  });

  it('is handed as it came where the application asks for that', async () => {
    vi.mocked(getStore).mockReturnValue(deployment('', true));
    const module = { entries: { [MIDDLEWARE]: () => ({ handler: echoing }) } };
    const path = `/_next/data/${BUILD_ID}/page.json`;

    await expect(toldTheMiddleware(path, {}, module)).resolves.toBe(path);
  });

  /**
   * A prefetch the client's router makes through a middleware (`x-middleware-prefetch`), of a page
   * whose props come from `getServerSideProps`, is answered as Next.js answers it: `{}`, marked
   * `x-middleware-skip`, with nothing rendered. Answered with the props, it stood in for the
   * navigation that followed, which never asked for them again.
   */
  it('is answered without rendering when it is a middleware prefetch of server-side props', async () => {
    let rendered = 0;
    const store = deployment();
    const data = `/_next/data/${BUILD_ID}/sha.json`;
    vi.mocked(getStore).mockReturnValue({
      ...store,
      manifest: {
        ...store.manifest,
        routing: { ...store.manifest.routing, middlewareMatchers: [] },
        entrypoints: [{ id: data, kind: 'pages', pathname: data }],
      },
      pathnames: [data],
      slashSpellings: new Map(),
    } as unknown as Store);
    const module: AppModule = {
      entries: {
        [data]: () => {
          return {
            handler: () => {
              rendered += 1;
              return Promise.reject(new Error('rendered'));
            },
          };
        },
      },
    };

    const response = await handleRequest({
      app: module,
      edge: { entries: {} },
      request: new Request(`https://app.test${data}`, {
        headers: { 'x-middleware-prefetch': '1' },
      }),
      waitUntil: () => {
        // Nothing here schedules background work.
      },
    });

    await expect(response.text()).resolves.toBe('{}');
    expect(response.headers.get('x-middleware-skip')).toBe('1');
    expect(response.headers.get('x-nextjs-matched-path')).toBe('/sha');
    expect(rendered).toBe(0);
  });

  /**
   * The page such a prefetch names to the client's router is the one Next.js names
   * (`route-modules/route-module.ts`): the page the build defines, a dynamic route's pattern rather
   * than the member, without the base path. The client reads what it is given through the base path
   * twice, and a member under `/docs` came back as another: `/docs/first` as `/t`, and a catch-all's
   * query as `["t"]` (`middleware-dynamic-basepath-matcher-rewrites`).
   */
  it.each([
    { basePath: '/docs', route: 'sha', asked: 'sha', matched: '/sha' },
    { basePath: '/docs', route: '[...path]', asked: 'first', matched: '/[...path]' },
    { basePath: '/docs', route: 'index', asked: 'index', matched: '/' },
    { basePath: '', route: '[slug]', asked: 'first', matched: '/[slug]' },
    { basePath: '', route: 'en/[slug]', asked: 'en/first', matched: '/en/[slug]' },
  ])(
    'names the page a skipped prefetch is for as Next.js does: $basePath $asked',
    async ({ basePath, route, asked, matched }) => {
      const data = `${basePath}/_next/data/${BUILD_ID}/${route}.json`;
      const pathname = `${basePath}/_next/data/${BUILD_ID}/${asked}.json`;
      const input = {
        app: { entries: { [data]: unrendered } },
        edge: { entries: {} },
        request: new Request(`https://app.test${pathname}`, {
          headers: { 'x-middleware-prefetch': '1' },
        }),
      } as unknown as RoutedInput;

      const response = await servePagesData(input, deployment(basePath), {
        route: data,
        pathname,
        url: pathname,
      });

      expect(response.headers.get('x-middleware-skip')).toBe('1');
      expect(response.headers.get('x-nextjs-matched-path')).toBe(matched);
    },
  );

  /**
   * The same through routing, with the tables `next build` hands an adapter for a catch-all under a
   * base path and a middleware: the router reads the data URL as its page (`shouldNormalizeNextData`),
   * the catch-all's own pattern matches `/docs/first`, and the request resolves to the page's route,
   * `/docs/[...path]` — never to the member's name, which no entrypoint has.
   */
  it('names the pattern a routed prefetch of a catch-all member resolves to', async () => {
    const page = '/docs/[...path]';
    const data = `/docs/_next/data/${BUILD_ID}/[...path].json`;
    const store = deployment('/docs');
    const manifest = {
      ...store.manifest,
      routing: {
        ...store.manifest.routing,
        dynamicRoutes: [
          {
            source: '/[...path]',
            sourceRegex: '^/docs[/]?/(?<nxtPpath>.+?)(?:/)?$',
            destination: '/docs/[...path]?nxtPpath=$nxtPpath',
          },
        ],
      },
      entrypoints: [
        { id: page, kind: 'pages' as const, pathname: page },
        { id: data, kind: 'pages' as const, pathname: data },
      ],
      prerenders: [],
      staticFiles: [],
    };
    vi.mocked(getStore).mockReturnValue({
      ...store,
      manifest,
      ...routerPathnames(manifest),
      dynamicRoutes: routerDynamicRoutes(manifest),
    });
    const module: AppModule = {
      entries: {
        [MIDDLEWARE]: () => ({ handler: continuing }),
        [page]: unrendered,
        [data]: unrendered,
      },
    };

    const response = await handleRequest({
      app: module,
      edge: { entries: {} },
      request: new Request(`https://app.test/docs/_next/data/${BUILD_ID}/first.json`, {
        headers: { 'x-middleware-prefetch': '1' },
      }),
      waitUntil: () => {
        // Nothing here schedules background work.
      },
    });

    await expect(response.text()).resolves.toBe('{}');
    expect(response.headers.get('x-middleware-skip')).toBe('1');
    expect(response.headers.get('x-nextjs-matched-path')).toBe('/[...path]');
  });

  it('is marked the same when the edge asks for the middleware alone', async () => {
    const alone = { [MIDDLEWARE_ONLY_HEADER]: '1' };

    await expect(toldTheMiddleware(`/_next/data/${BUILD_ID}/page.json`, alone)).resolves.toBe('1');

    await expect(toldTheMiddleware('/page', { ...alone, [DATA_HEADER]: '1' })).resolves.toBe(
      'absent',
    );
  });
});
