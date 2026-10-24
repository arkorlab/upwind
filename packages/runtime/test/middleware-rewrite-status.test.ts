import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * A middleware's rewrite that gives the response a status of its own.
 *
 * Next.js's router puts the status a middleware answered with on the response before the route
 * it rewrote to renders, and a render that sets none of its own leaves it there. `@next/routing`
 * reads no status off a rewrite: `NextResponse.rewrite(url, { status: 404 })` to the not-found
 * page went out as the page's own 200 (`app-dir/not-found-non-document-dynamic`).
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// The render's own answer is the test's to choose.
vi.mock(import('../src/node-bridge.ts'), () => {
  const render = vi.fn(() => Promise.resolve(new Response('custom not found page')));
  return { invokeNodeHandler: render };
});

const NOT_FOUND = '/_not-found';
const ROUTE_HANDLER = '/api/answer';
const MIDDLEWARE = '/_middleware';

/** The router runs for real; only its immutable deployment bundle is supplied by this test. */
function deployment(): Store {
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [{ sourceRegex: '^/.*$' }],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [
        { id: NOT_FOUND, kind: 'app-page', pathname: NOT_FOUND },
        { id: ROUTE_HANDLER, kind: 'app-route', pathname: ROUTE_HANDLER },
      ],
    },
    pathnames: [NOT_FOUND, ROUTE_HANDLER],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

const page: NodeHandler = () => Promise.resolve();

/** What `NextResponse.rewrite` to `to` — the not-found page, unless named — answers with. */
function rewritingWith(status: number, to = NOT_FOUND): AppModule {
  const headers = { 'x-middleware-rewrite': `https://app.test${to}` };
  const middleware: WebHandler = () => Promise.resolve(new Response(null, { status, headers }));
  return {
    entries: {
      [MIDDLEWARE]: () => ({ handler: middleware }),
      [NOT_FOUND]: () => ({ handler: page }),
      [ROUTE_HANDLER]: () => ({ handler: page }),
    },
  };
}

function handle(app: AppModule): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request('https://app.test/rewritten-not-found'),
    waitUntil: () => {
      // Nothing is scheduled for these renders.
    },
  });
}

describe('a middleware rewrite with a status of its own', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('answers with that status what the route rendered', async () => {
    const response = await handle(rewritingWith(404));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('custom not found page');
  });

  it('leaves the status a render gave itself', async () => {
    vi.mocked(invokeNodeHandler).mockResolvedValueOnce(new Response('failed', { status: 500 }));

    const response = await handle(rewritingWith(404));

    expect(response.status).toBe(500);
  });

  it('leaves the route its own status where the rewrite gave none', async () => {
    const response = await handle(rewritingWith(200));

    expect(response.status).toBe(200);
  });

  /**
   * A route handler's `Response` is sent as it is, its status over whatever the router put on the
   * response before it ran (`sendResponse`): a 200 it answers with stays a 200.
   */
  it("leaves a route handler's answer its own status", async () => {
    const response = await handle(rewritingWith(404, ROUTE_HANDLER));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('custom not found page');
  });

  /**
   * With `trailingSlash`, the router resolves a handler under its spelling with the slash, which
   * names no entrypoint: the route it is served as is the one without (`resolvedOf`).
   */
  it('leaves a route handler reached under its slash spelling its own status', async () => {
    const store = deployment();
    vi.mocked(getStore).mockReturnValue({
      ...store,
      manifest: { ...store.manifest, config: { basePath: '', trailingSlash: true } },
      pathnames: [...store.pathnames, `${ROUTE_HANDLER}/`],
      slashSpellings: new Map([[`${ROUTE_HANDLER}/`, ROUTE_HANDLER]]),
    } as unknown as Store);

    const response = await handle(rewritingWith(404, `${ROUTE_HANDLER}/`));

    expect(response.status).toBe(200);
  });
});
