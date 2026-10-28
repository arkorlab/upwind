import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../../src/app-module.ts';
import { handleRequest } from '../../src/handle.ts';
import { getStore, type Store } from '../../src/store.ts';

/**
 * A request whose query held a key Next.js reads a route parameter from, answered on the native
 * target, where the runtime decides what of an answer a shared cache may keep (`native/delivery.ts`).
 *
 * That decision reads the request as the client sent it and as its middleware handed it on
 * (`handedOn`), by the request itself. The key is taken out of the query once, as the request comes
 * in (`withoutRouteParameterKeys`), so the request routing hands the middleware's word on for is the
 * one the answer is delivered for. Taken out further in, on a copy, the middleware's word was kept
 * for the copy, the answer was delivered for the request as it came, and a page the middleware had
 * handed credentials to went out as everyone's.
 */

// What the build swaps in for a target with no edge in front of it.
vi.mock(import('../../src/delivery.ts'), () => import('../../src/native/delivery.ts'));

vi.mock(import('../../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

/** What the page says of its keeping: `public`, for shared caches as well. */
const PUBLIC = 'public, max-age=60, s-maxage=600';

vi.mock(import('../../src/node-bridge.ts'), () => {
  const render = vi.fn(() =>
    Promise.resolve(new Response('page', { headers: { 'cache-control': PUBLIC } })),
  );
  return { invokeNodeHandler: render };
});

const HOST = 'https://app.test';
const MIDDLEWARE = '/_middleware';
/** `pages/admin/[id].js`, with `getServerSideProps`. */
const PAGE = '/admin/[id]';

/** A build whose middleware runs for every path, and whose one page is `PAGE`. */
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
      entrypoints: [{ id: PAGE, kind: 'pages', pathname: PAGE }],
    },
    pathnames: [PAGE],
    slashSpellings: new Map(),
    dynamicRoutes: [
      {
        sourceRegex: '^[/]?/admin/(?<nxtPid>[^/]+?)(?:/)?$',
        destination: `${PAGE}?nxtPid=$nxtPid`,
      },
    ],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    renderedPages: new Set(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

const page: NodeHandler = () => Promise.resolve();

/** A middleware that lets the request on, with the request headers `added` set on it. */
function handingOn(added: Readonly<Record<string, string>>): AppModule {
  const headers = new Headers({ 'x-middleware-next': '1' });
  const names = Object.keys(added);
  if (names.length > 0) {
    headers.set('x-middleware-override-headers', names.join(','));
  }
  for (const [name, value] of Object.entries(added)) {
    headers.set(`x-middleware-request-${name}`, value);
  }
  const middleware: WebHandler = () => Promise.resolve(new Response(null, { headers }));
  return {
    entries: {
      [MIDDLEWARE]: () => ({ handler: middleware }),
      [PAGE]: () => ({ handler: page }),
    },
  };
}

/** What the answer to `path` says of its keeping, once the runtime has delivered it. */
async function keptAs(path: string, app: AppModule): Promise<string | null> {
  const response = await handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`${HOST}${path}`),
    waitUntil: () => {
      // Nothing is scheduled for these renders.
    },
  });
  await response.body?.cancel();
  return response.headers.get('cache-control');
}

describe('a request rid of a route parameter’s key, on the native target', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(['/admin/123?nxtPdummy=x', '/admin/123'])(
    'is answered as the visitor’s at %s where its middleware handed it credentials',
    async (path) => {
      const app = handingOn({ authorization: 'Bearer from-the-middleware' });

      await expect(keptAs(path, app)).resolves.toBe('private, max-age=60');
    },
  );

  it('keeps the page’s word for shared caches where nothing of a visitor’s was handed on', async () => {
    await expect(keptAs('/admin/123?nxtPdummy=x', handingOn({}))).resolves.toBe(PUBLIC);
  });
});
