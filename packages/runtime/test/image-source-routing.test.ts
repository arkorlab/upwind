import type { StaticFile } from '@stayingupwind/core/bundle';
import type { ImagesConfig } from '@stayingupwind/core/images';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import type { RoutedInput } from '../src/serve.ts';
import { staticFileResponse } from '../src/static-file.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * An image's source, asked for by the image's own request: routed as a request of its own, as the
 * edge asks for one (`fetchImageSource`). What the image request's routing came to — its middleware
 * having run, what that middleware set, a status a rewrite named — is not the source's: a source no
 * middleware ran for answered as one a middleware gated is held for no time, and the image made of
 * it with it (`upstreamMaxAge`).
 */

/** A PNG by its signature: what an optimizer takes for an image. */
const PNG = vi.hoisted(() => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// Nothing here renders.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

// The source's file: what it was asked with is the test's to read.
vi.mock(import('../src/static-file.ts'), () => {
  return {
    staticFileResponse: vi.fn(() =>
      Promise.resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } })),
    ),
    afterRouting: (_input: RoutedInput, response: Response) => response,
  };
});

const IMAGE_PATH = '/_next/image';
const SOURCE = '/a.png';
const MIDDLEWARE = '/_middleware';
const IMAGES: ImagesConfig = {
  path: IMAGE_PATH,
  basePath: '',
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 4096,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const FILE: StaticFile = {
  pathname: SOURCE,
  blob: { sha256: 'a'.repeat(64), byteLength: PNG.byteLength, contentType: 'image/png' },
  immutable: false,
};

/** A build whose middleware runs for the optimizer's path alone, and not for its sources. */
function deployment(): Store {
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '', images: IMAGES },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [{ sourceRegex: `^${IMAGE_PATH}$` }],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [],
    },
    pathnames: [IMAGE_PATH, SOURCE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map([[SOURCE, FILE]]),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

/** A middleware that lets the request on, setting a header and naming nothing of the source's. */
function letThrough(): { readonly app: AppModule; readonly ran: () => number } {
  let runs = 0;
  const middleware: WebHandler = () => {
    runs += 1;
    return Promise.resolve(
      new Response(null, {
        headers: { 'x-middleware-next': '1', 'cache-control': 'private, max-age=1' },
      }),
    );
  };
  return {
    app: { entries: { [MIDDLEWARE]: () => ({ handler: middleware }) } },
    ran: () => runs,
  };
}

describe('an image’s source, asked for by the image’s own request', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is routed as a request of its own, carrying nothing of the image request’s routing', async () => {
    const { app, ran } = letThrough();

    const response = await handleRequest({
      app,
      edge: { entries: {} },
      request: new Request(
        `https://app.test${IMAGE_PATH}?url=${encodeURIComponent(SOURCE)}&w=64&q=75`,
      ),
      waitUntil: () => {
        // Nothing is scheduled.
      },
    });
    await response.body?.cancel();

    expect(ran()).toBe(1);

    const asked = vi.mocked(staticFileResponse).mock.calls.map(([input]) => {
      return {
        url: input.request.url,
        middlewareRan: input.middlewareRan,
        middlewareHeaders: input.middlewareHeaders,
        rewriteStatus: input.rewriteStatus,
      };
    });

    expect(asked).toStrictEqual([
      {
        url: `https://app.test${SOURCE}`,
        middlewareRan: undefined,
        middlewareHeaders: undefined,
        rewriteStatus: undefined,
      },
    ]);
  });
});
