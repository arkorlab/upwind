import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

vi.mock(import('../src/node-bridge.ts'), () => ({
  invokeNodeHandler: vi.fn(() => Promise.resolve(new Response('<!DOCTYPE html>'))),
}));

const PATH = '/test-location-header';
const LOCATION = 'https://api.example.test/random';
const page: NodeHandler = () => Promise.resolve();

/** The real router has both a middleware and a page it must never render for this response. */
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
      },
      entrypoints: [{ id: PATH, kind: 'app-page', pathname: PATH }],
    },
    pathnames: [PATH],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
  } as unknown as Store;
}

function handle(response: Response): Promise<Response> {
  const middleware: WebHandler = () => Promise.resolve(response);
  const app: AppModule = {
    entries: { '/_middleware': () => ({ handler: middleware }), [PATH]: () => ({ handler: page }) },
  };
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`https://app.test${PATH}`),
    waitUntil: () => {
      /* No work is scheduled. */
    },
  });
}

describe('a middleware or proxy response with a non-redirect Location', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([200, 401, 403])('returns the JSON body and Location under status %s', async (status) => {
    const original = Response.json({ foo: 'bar' }, { status, headers: { location: LOCATION } });
    const response = await handle(original);

    expect(response.status).toBe(status);
    expect(response.headers.get('location')).toBe(LOCATION);
    await expect(response.json()).resolves.toStrictEqual({ foo: 'bar' });
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['x-middleware-next', '1'],
    ['x-middleware-rewrite', 'https://app.test/another-page'],
  ] as const)('finishes before %s without consuming its body', async (key, value) => {
    const body = new ReadableStream<Uint8Array>();
    const original = new Response(body, { headers: { [key]: value, location: LOCATION } });

    const response = await handle(original);

    expect(response.body).toBe(original.body);
    expect(response.bodyUsed).toBe(false);
    expect(invokeNodeHandler).not.toHaveBeenCalled();
    await response.body?.cancel();
  });
});
