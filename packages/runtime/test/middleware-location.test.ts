import type { Route } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: vi.fn(() => Promise.resolve(new Response('<!DOCTYPE html>'))),
  };
});

const PATH = '/test-location-header';
const MIDDLEWARE = '/_middleware';
const LOCATION = 'https://api.example.test/random';
const page: NodeHandler = () => Promise.resolve();

/** The real router has both a middleware and a page it must never render for this response. */
function deployment(beforeMiddleware: Route[] = []): Store {
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware,
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

function handle(
  response: Response,
  headers: Record<string, string> = {},
  search = '',
): Promise<Response> {
  const middleware: WebHandler = () => Promise.resolve(response);
  const app: AppModule = {
    entries: { [MIDDLEWARE]: () => ({ handler: middleware }), [PATH]: () => ({ handler: page }) },
  };
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`https://app.test${PATH}${search}`, { headers }),
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

  it('continues to the page when a next response has an empty Location', async () => {
    const original = new Response(null, { headers: { 'x-middleware-next': '1', location: '' } });

    const response = await handle(original);

    await expect(response.text()).resolves.toBe('<!DOCTYPE html>');
    expect(response.headers.get('location')).toBe('');
    expect(invokeNodeHandler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: PATH }),
    );
  });

  it('retains configured headers, middleware overrides, and every response cookie', async () => {
    vi.mocked(getStore).mockReturnValue(
      deployment([
        {
          sourceRegex: '^/(test-location-header)$',
          headers: {
            'access-control-allow-origin': '*',
            'x-collision': 'configured',
            'x-path': '$1',
            'set-cookie': 'configured=1; Path=/',
          },
        },
      ]),
    );
    const original = Response.json(
      { foo: 'bar' },
      {
        headers: { location: LOCATION, 'x-collision': 'middleware' },
      },
    );
    original.headers.append('set-cookie', 'first=1; Path=/');
    original.headers.append('set-cookie', 'second=2; Path=/');

    const response = await handle(original);

    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-collision')).toBe('middleware');
    expect(response.headers.get('x-path')).toBe('test-location-header');
    expect(response.headers.getSetCookie()).toStrictEqual([
      'configured=1; Path=/',
      'first=1; Path=/',
      'second=2; Path=/',
    ]);
    await expect(response.json()).resolves.toStrictEqual({ foo: 'bar' });
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('judges configured conditions before middleware overrides or rewrites the request', async () => {
    vi.mocked(getStore).mockReturnValue(
      deployment([
        {
          sourceRegex: '^/test-location-header$',
          has: [
            { type: 'header', key: 'x-flag', value: 'before' },
            { type: 'query', key: 'token', value: 'before' },
          ],
          headers: { 'x-conditioned': 'present' },
        },
      ]),
    );
    const original = new Response('kept', {
      headers: {
        location: LOCATION,
        'x-middleware-override-headers': 'x-flag',
        'x-middleware-request-x-flag': 'after',
        'x-middleware-rewrite': 'https://app.test/other?token=after',
      },
    });

    const response = await handle(original, { 'x-flag': 'before' }, '?token=before');

    expect(response.headers.get('x-conditioned')).toBe('present');
    await expect(response.text()).resolves.toBe('kept');
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('strips middleware transport headers while preserving the original stream and status', async () => {
    const body = new ReadableStream<Uint8Array>();
    const original = new Response(body, {
      status: 207,
      statusText: 'Original status',
      headers: {
        location: LOCATION,
        'x-middleware-next': '1',
        'x-middleware-set-cookie': 'internal=secret',
        'x-middleware-override-headers': 'authorization',
        'x-middleware-request-authorization': 'internal-token',
        'x-middleware-custom': 'internal',
      },
    });
    original.headers.append('set-cookie', 'first=1; Path=/');
    original.headers.append('set-cookie', 'second=2; Path=/');

    const response = await handle(original);

    expect(response.body).toBe(body);
    expect(response.bodyUsed).toBe(false);
    expect(response.status).toBe(207);
    expect(response.statusText).toBe('Original status');
    expect(
      [...response.headers.keys()].filter((name) => name.startsWith('x-middleware-')),
    ).toStrictEqual([]);
    expect(response.headers.getSetCookie()).toStrictEqual(['first=1; Path=/', 'second=2; Path=/']);

    await response.body?.cancel();
  });
});
