import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * A middleware's rewrite on a site reached at a loopback address.
 *
 * Next.js's `NextURL` spells every loopback host `localhost` (`server/web/next-url.ts`), so a
 * middleware on a site reached at `127.0.0.1` that rewrites to `new URL('/b', request.url)` answers
 * `x-middleware-rewrite: http://localhost:<port>/b`: the same server, which Next.js's own router
 * compares in that spelling too. `@next/routing` compares it with the request's own origin, and the
 * rewrite was proxied back to the same server by name (`upwind start --hostname 127.0.0.1`).
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

/** What `NextResponse.rewrite` to `to` answers with. */
function rewritingTo(to: string): AppModule {
  const headers = { 'x-middleware-rewrite': to };
  const middleware: WebHandler = () => Promise.resolve(new Response(null, { headers }));
  return {
    entries: {
      [MIDDLEWARE]: () => ({ handler: middleware }),
      [NOT_FOUND]: () => ({ handler: page }),
      [ROUTE_HANDLER]: () => ({ handler: page }),
    },
  };
}

/** The site as reached at an IPv4 loopback address, as `upwind start --hostname 127.0.0.1` serves it. */
const REQUESTED = 'http://127.0.0.1:3000/a';

function handle(app: AppModule): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(REQUESTED),
    waitUntil: () => {
      // Nothing is scheduled for these renders.
    },
  });
}

describe('a middleware rewrite on a loopback address', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the route it names as the same rewrite on the request’s own origin', async () => {
    const proxied = vi.fn(() => Promise.reject(new Error('proxied')));
    vi.stubGlobal('fetch', proxied);
    const own = await handle(rewritingTo(`http://127.0.0.1:3000${ROUTE_HANDLER}?x=1`));
    const ownCall = vi.mocked(invokeNodeHandler).mock.calls[0]?.[0];
    vi.mocked(invokeNodeHandler).mockClear();

    const spelled = await handle(rewritingTo(`http://localhost:3000${ROUTE_HANDLER}?x=1`));

    expect(proxied).not.toHaveBeenCalled();
    expect(spelled.status).toBe(own.status);
    await expect(spelled.text()).resolves.toBe(await own.text());
    expect(spelled.headers.get('x-middleware-rewrite')).toBe(`${ROUTE_HANDLER}?x=1`);
    expect(spelled.headers.get('x-middleware-rewrite')).toBe(
      own.headers.get('x-middleware-rewrite'),
    );
    expect(vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].url).toBe(ownCall?.url);
    expect(vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].request.headers.get('host')).toBe(
      ownCall?.request.headers.get('host') ?? null,
    );
  });

  it('says a path that reads as another host whole, and keeps it on the same server', async () => {
    const proxied = vi.fn(() => Promise.reject(new Error('proxied')));
    vi.stubGlobal('fetch', proxied);

    const response = await handle(rewritingTo(`http://localhost:3000//elsewhere${ROUTE_HANDLER}`));

    expect(proxied).not.toHaveBeenCalled();
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      `http://127.0.0.1:3000//elsewhere${ROUTE_HANDLER}`,
    );
  });

  it('still proxies a rewrite to another port of the same address', async () => {
    const proxied = vi.fn(() => Promise.resolve(new Response('from elsewhere')));
    vi.stubGlobal('fetch', proxied);

    const response = await handle(rewritingTo(`http://localhost:3001${ROUTE_HANDLER}`));

    expect(proxied).toHaveBeenCalledExactlyOnceWith(
      new URL(`http://localhost:3001${ROUTE_HANDLER}`),
      expect.anything(),
    );
    await expect(response.text()).resolves.toBe('from elsewhere');
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });
});
