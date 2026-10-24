import type { Prerender } from '@stayingupwind/core/bundle';
import { MIDDLEWARE_DONE_HEADER } from '@stayingupwind/core/paas';
import { releaseStream, withDeadline } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, WebHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { splitBody } from '../src/request-body.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

vi.mock(import('../src/request-body.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, splitBody: vi.fn(original.splitBody) };
});

// These responses never enter the Cloudflare-only Node bridge; a dynamic fallback uses Web APIs.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

const DEADLINE_MS = 1000;
const encoder = new TextEncoder();
const NOT_FOUND = '/_not-found';
const MIDDLEWARE = '/_middleware';
const staticBody = { sha256: 'static', byteLength: 9, contentType: 'text/html' };
const shell: Prerender = {
  id: NOT_FOUND,
  route: NOT_FOUND,
  pathname: NOT_FOUND,
  parentOutputId: NOT_FOUND,
  groupId: 1,
  initialStatus: 404,
  body: staticBody,
};

/** The router runs for real; only its immutable deployment bundle is supplied by this test. */
function deployment(
  kind: 'file' | 'shell' | 'plain' = 'file',
  config: { readonly proxyClientMaxBodySize?: number } = {},
): Store {
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '', ...config },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [{ sourceRegex: '^/.*$' }],
        beforeFiles: [{ sourceRegex: '^/external$', destination: 'https://upstream.test/upload' }],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [],
    },
    pathnames: [],
    dynamicRoutes: [],
    staticFiles: new Map(
      kind === 'file' ? [['/404', { pathname: '/404', blob: staticBody, immutable: false }]] : [],
    ),
    shellsByRoute: new Map(
      kind === 'shell' ? [[NOT_FOUND, { pages: new Map([[NOT_FOUND, shell]]), patterns: [] }]] : [],
    ),
    // The not-found a Pages Router build wrote with `getStaticProps`; none of these builds has one.
    prerendersByPathname: new Map<string, Prerender>(),
    readBlob: () => encoder.encode('NOT FOUND'),
    tryReadBlob: () => encoder.encode('NOT FOUND'),
  } as unknown as Store;
}

/** Middleware declines the upload; the handler's other tee branch must still be accounted for. */
const middleware: WebHandler = (request) => {
  releaseStream(request.body, 'middleware does not use the body');
  return Promise.resolve(new Response(null, { headers: { 'x-middleware-next': '1' } }));
};
const app: AppModule = {
  entries: { [MIDDLEWARE]: () => ({ handler: middleware }) },
};

function handle(request: Request, application = app, handler?: WebHandler) {
  return handleRequest({
    app: application,
    edge: { entries: handler === undefined ? {} : { [NOT_FOUND]: () => ({ handler }) } },
    request,
    waitUntil: () => {
      // These routes schedule no background work.
    },
  });
}

/** Cancellation itself stalls, so awaiting it would delay an otherwise complete response. */
function upload(path: string) {
  const gate = Promise.withResolvers<undefined>();
  const cancelled = vi.fn<(reason: unknown) => Promise<undefined>>(() => gate.promise);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('unread upload'));
    },
    cancel: cancelled,
  });
  const init = { method: 'POST', body, duplex: 'half' };
  const request = new Request(`https://app.test${path}`, init);
  return {
    request,
    cancelled,
    finishCancellation: () => {
      gate.resolve(undefined);
    },
  };
}

describe('request bodies no response handler will read', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('releases a failed external rewrite upload without awaiting its cancellation', async () => {
    const source = upload('/external');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused')),
    );
    try {
      const response = await withDeadline(handle(source.request), DEADLINE_MS, 'rewrite response');

      expect(response.status).toBe(502);
      await expect(response.text()).resolves.toBe('rewrite target unavailable');
      expect(source.cancelled).toHaveBeenCalledExactlyOnceWith([
        'middleware does not use the body',
        'rewrite failed: handler body unused',
      ]);
    } finally {
      source.finishCancellation();
    }
  });

  it.each(['file', 'shell', 'plain'] as const)(
    'releases an upload answered by a %s 404 without awaiting cancellation',
    async (kind) => {
      vi.mocked(getStore).mockReturnValue(deployment(kind));
      const source = upload('/missing');
      const application: AppModule = {
        entries: {
          ...app.entries,
          ...(kind === 'shell' && {
            [NOT_FOUND]: () => {
              return {
                handler: () => {
                  throw new Error('the completed shell does not render');
                },
              };
            },
          }),
        },
      };
      try {
        const response = await withDeadline(
          handle(source.request, application),
          DEADLINE_MS,
          'not-found response',
        );

        const reasons = {
          file: 'static not found: handler body unused',
          shell: 'static document: handler body unused',
          plain: 'not found: handler body unused',
        };

        expect(response.status).toBe(404);
        await expect(response.text()).resolves.toBe(kind === 'plain' ? 'Not Found' : 'NOT FOUND');
        expect(source.cancelled).toHaveBeenCalledExactlyOnceWith([
          'middleware does not use the body',
          reasons[kind],
        ]);
      } finally {
        source.finishCancellation();
      }
    },
  );

  it("releases an upload answered by a data request's 404 without awaiting cancellation", async () => {
    const source = upload('/_next/data/build/missing.json');
    try {
      const response = await withDeadline(
        handle(source.request),
        DEADLINE_MS,
        'data not-found response',
      );

      expect(response.status).toBe(404);
      expect(source.cancelled).toHaveBeenCalledExactlyOnceWith([
        'middleware does not use the body',
        'pages data not found: handler body unused',
      ]);
    } finally {
      source.finishCancellation();
    }
  });

  it('keeps the upload available when a not-found handler renders the response', async () => {
    vi.mocked(getStore).mockReturnValue(deployment('plain'));
    const response = await handle(
      new Request('https://app.test/missing', { method: 'POST', body: 'upload' }),
      app,
      async (request) => new Response(`received:${await request.text()}`, { status: 404 }),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('received:upload');
  });
});

/** A middleware that lets the request through, having done `seen` with it first. */
function passing(seen: (request: Request) => Promise<void> | void): AppModule {
  const handler: WebHandler = async (request) => {
    await seen(request);
    return new Response(null, { headers: { 'x-middleware-next': '1' } });
  };
  return { entries: { [MIDDLEWARE]: () => ({ handler }) } };
}

/** The not-found the request ends at, answering with what it read of the upload. */
const received: WebHandler = async (request) =>
  new Response(`received:${await request.text()}`, { status: 404 });

/** The same, answering with how much of it that was. */
const measured: WebHandler = async (request) =>
  new Response(`received:${(await request.text()).length}`, { status: 404 });

/** A middleware that answers the request itself, with the body it was handed. */
const echo: WebHandler = (request) => Promise.resolve(new Response(request.body));

/** An upload of 100 chunks of 4 bytes, made as it is read, that says how much was. */
function counted() {
  const count = 100;
  const size = 4;
  const seen = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled === count * size) {
          controller.close();
          return;
        }
        seen.pulled += size;
        controller.enqueue(encoder.encode('x'.repeat(size)));
      },
    },
    { highWaterMark: 0 },
  );
  return { seen, body };
}

describe('what of an upload routing holds', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment('plain'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['the edge already ran the middleware', app, { [MIDDLEWARE_DONE_HEADER]: '1' }],
    ['the deployment has none', { entries: {} }, {}],
  ] as const)('does not split an upload when %s', async (_why, application, headers) => {
    const response = await handle(
      new Request('https://app.test/missing', { method: 'POST', body: 'upload', headers }),
      application,
      received,
    );

    await expect(response.text()).resolves.toBe('received:upload');
    expect(vi.mocked(splitBody)).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  /**
   * A middleware may leave reading its body to `waitUntil`, which outlives its answer: its side is
   * still there once routing is done and the handler has read the whole upload.
   */
  it("keeps the middleware's side for work it left behind", async () => {
    let kept: ReadableStream<Uint8Array> | null = null;

    const response = await handle(
      new Request('https://app.test/missing', { method: 'POST', body: 'upload' }),
      passing((request) => {
        kept = request.body;
      }),
      received,
    );

    await expect(response.text()).resolves.toBe('received:upload');
    await expect(new Response(kept).text()).resolves.toBe('upload');
  });

  it('keeps no more of it than a proxy may read, however late it is read', async () => {
    vi.mocked(getStore).mockReturnValue(deployment('plain', { proxyClientMaxBodySize: 8 }));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said once, and checked below.
    });
    const large = counted();
    let kept: ReadableStream<Uint8Array> | null = null;

    const init = { method: 'POST', body: large.body, duplex: 'half' };

    const response = await handle(
      new Request('https://app.test/missing', init),
      passing((request) => {
        kept = request.body;
      }),
      measured,
    );

    await expect(response.text()).resolves.toBe('received:400');
    await expect(new Response(kept).text()).resolves.toBe('x'.repeat(8));
    expect(warned).toHaveBeenCalledTimes(1);
  });

  /** With no middleware run for the path, nothing will read a copy, and none is made. */
  it('copies nothing once routing ran no middleware', async () => {
    const quiet = deployment('plain', { proxyClientMaxBodySize: 8 });
    const unmatched = {
      ...quiet.manifest.routing,
      middlewareMatchers: [{ sourceRegex: '^/only$' }],
    };
    vi.mocked(getStore).mockReturnValue({
      ...quiet,
      manifest: { ...quiet.manifest, routing: unmatched },
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Must stay silent: a copy past the limit is what would say so.
    });
    const large = counted();

    const init = { method: 'POST', body: large.body, duplex: 'half' };

    const response = await handle(new Request('https://app.test/missing', init), app, measured);

    await expect(response.text()).resolves.toBe('received:400');
    expect(warned).not.toHaveBeenCalled();
  });

  it('hands the middleware no more than a proxy may read, and the handler all of it', async () => {
    vi.mocked(getStore).mockReturnValue(deployment('plain', { proxyClientMaxBodySize: 8 }));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said once, and checked below.
    });
    const large = counted();
    const proxy = { read: '', pulled: 0 };
    const init = { method: 'POST', body: large.body, duplex: 'half' };

    const response = await handle(
      new Request('https://app.test/missing', init),
      passing(async (request) => {
        proxy.read = await request.text();
        proxy.pulled = large.seen.pulled;
      }),
      measured,
    );

    expect(proxy.read).toBe('x'.repeat(8));
    // No more of the upload was read, and so queued for the handler, than the proxy's share.
    expect(proxy.pulled).toBeLessThanOrEqual(16);
    await expect(response.text()).resolves.toBe('received:400');
    expect(warned).toHaveBeenCalledTimes(1);
  });

  it("keeps the middleware's side while its own answer streams it back", async () => {
    const response = await handle(
      new Request('https://app.test/missing', { method: 'POST', body: 'upload' }),
      { entries: { [MIDDLEWARE]: () => ({ handler: echo }) } },
    );

    await expect(response.text()).resolves.toBe('upload');
  });
});
