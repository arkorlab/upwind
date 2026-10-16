import { MIDDLEWARE_DONE_HEADER, MIDDLEWARE_REWRITE_STATUS_HEADER } from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * A middleware's rewrite that gives the response a status of its own, where the edge ran the
 * middleware and names the status (`MIDDLEWARE_REWRITE_STATUS_HEADER`): the route it rewrote to is
 * answered under it, as one is whose middleware the runtime ran, and the middleware is not run
 * again to learn it.
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

/** A deployment whose middleware rewrites to `to` under `status`, counting the times it runs. */
function rewritingWith(status: number, to = NOT_FOUND): { app: AppModule; runs: () => number } {
  let runs = 0;
  const headers = { 'x-middleware-rewrite': `https://app.test${to}` };
  const middleware: WebHandler = () => {
    runs += 1;
    return Promise.resolve(new Response(null, { status, headers }));
  };
  return {
    app: {
      entries: {
        [MIDDLEWARE]: () => ({ handler: middleware }),
        [NOT_FOUND]: () => ({ handler: page }),
        [ROUTE_HANDLER]: () => ({ handler: page }),
      },
    },
    runs: () => runs,
  };
}

/** The request the edge sends on once it has run the middleware itself, rewritten to `to`. */
function fromTheEdge(headers: Record<string, string>, to = NOT_FOUND): Request {
  return new Request(`https://app.test${to}`, { headers });
}

function handle(app: AppModule, request: Request): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request,
    waitUntil: () => {
      // Nothing is scheduled for these renders.
    },
  });
}

describe('a middleware rewrite with a status of its own, which the edge ran', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('answers with the status the edge names what the route rendered, running no middleware', async () => {
    const { app, runs } = rewritingWith(200);
    const request = fromTheEdge({
      [MIDDLEWARE_DONE_HEADER]: '1',
      [MIDDLEWARE_REWRITE_STATUS_HEADER]: '404',
    });

    const response = await handle(app, request);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('custom not found page');
    expect(runs()).toBe(0);
  });

  it('leaves the route its own status where the edge names none', async () => {
    const { app } = rewritingWith(404);

    const response = await handle(app, fromTheEdge({ [MIDDLEWARE_DONE_HEADER]: '1' }));

    expect(response.status).toBe(200);
  });

  /** A status named without the middleware run is no one's: the middleware runs, and says its own. */
  it('takes no status named where the edge did not run the middleware', async () => {
    const { app, runs } = rewritingWith(200);

    const response = await handle(app, fromTheEdge({ [MIDDLEWARE_REWRITE_STATUS_HEADER]: '404' }));

    expect(response.status).toBe(200);
    expect(runs()).toBe(1);
  });

  it.each(['200', '199', '600', '0', '4040', '40 4', 'abc'])(
    'takes no status %j, which no rewrite gives a response',
    async (status) => {
      const { app } = rewritingWith(200);
      const request = fromTheEdge({
        [MIDDLEWARE_DONE_HEADER]: '1',
        [MIDDLEWARE_REWRITE_STATUS_HEADER]: status,
      });

      const response = await handle(app, request);

      expect(response.status).toBe(200);
    },
  );

  /**
   * A route handler's `Response` is sent as it is, its status over whatever the router put on the
   * response before it ran (`sendResponse`): a 200 it answers with stays a 200.
   */
  it("leaves a route handler's answer its own status", async () => {
    const { app } = rewritingWith(200, ROUTE_HANDLER);
    const request = fromTheEdge(
      { [MIDDLEWARE_DONE_HEADER]: '1', [MIDDLEWARE_REWRITE_STATUS_HEADER]: '404' },
      ROUTE_HANDLER,
    );

    const response = await handle(app, request);

    expect(response.status).toBe(200);
  });
});
