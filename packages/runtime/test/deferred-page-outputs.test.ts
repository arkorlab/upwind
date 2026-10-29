import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Prerender } from '@stayingupwind/core/bundle';
import { CAPTURE_HEADER, CACHE_ROUTE_HEADER } from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import type { BundleBlobReader } from '../src/bundle-blobs.ts';
import { serveFromGeneration } from '../src/generations.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler, type InvokeInput } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

vi.mock(import('../src/generations.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, serveFromGeneration: vi.fn() };
});

// The bridge waits for the actual handler before it sends a suffix. It opens no listening port.
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const PAGE = '/page';
const HTML = '<main>built page</main>';
const FLIGHT = 'built flight';
const encoder = new TextEncoder();

/** Routing, output selection, and shell concatenation are real; only the deployment's bytes vary. */
function deployment(postponed = false, route = PAGE): Store {
  const shell = {
    id: 'page',
    route,
    pathname: PAGE,
    body: { sha256: 'html' },
    ...(postponed && { postponed: { sha256: 'state' } }),
  } as Prerender;
  const flight = {
    id: 'flight',
    route,
    pathname: `${PAGE}.rsc`,
    body: { sha256: 'flight' },
  } as Prerender;
  const blobs: Record<string, string> = { html: HTML, flight: FLIGHT, state: 'postponed' };
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      entrypoints: [{ id: route, kind: 'app-page', pathname: route }],
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc: {
          prefetchHeader: 'next-router-prefetch',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
          varyHeader: 'rsc',
        },
      },
    },
    pathnames: [PAGE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map([[route, { pages: new Map([[PAGE, shell]]), patterns: [] }]]),
    prerendersById: new Map([['page', shell]]),
    prerendersByPathname: new Map([
      [`${PAGE}.rsc`, flight],
      [PAGE, shell],
    ]),
    readBlob: (sha256: string) => encoder.encode(blobs[sha256]),
  } as unknown as Store;
}

function missingBuiltBody(): never {
  throw Object.assign(new Error('body was not shipped'), { code: 'ENOENT' });
}

function handle(
  load: AppModule['entries'][string],
  request: Request,
  route = PAGE,
  blobs?: BundleBlobReader,
) {
  return handleRequest({
    app: { entries: { [route]: load } },
    edge: { entries: {} },
    request,
    blobs,
    waitUntil: () => {
      // These requests schedule no background work.
    },
  });
}

async function render(input: InvokeInput): Promise<Response> {
  await input.handler({} as IncomingMessage, {} as ServerResponse, {
    requestMeta: input.requestMeta,
  });
  return new Response('resumed');
}

function readerOf(answer: Response): ReadableStreamDefaultReader<Uint8Array> {
  const reader = answer.body?.getReader();
  if (reader === undefined) throw new Error('the shell has no stream');
  return reader;
}

describe('page outputs before the Node.js renderer is needed', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    vi.mocked(serveFromGeneration).mockResolvedValue(undefined);
    vi.mocked(invokeNodeHandler).mockImplementation(render);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('invokes a WebSocket GET despite a prerender, leaving ordinary GET on the built output', async () => {
    const store = deployment();
    vi.mocked(getStore).mockReturnValue({
      ...store,
      manifest: {
        ...store.manifest,
        entrypoints: [{ id: PAGE, pathname: PAGE, kind: 'app-route' }],
      },
    });
    const load = vi.fn(() => ({ handler: () => Promise.resolve() }));
    const ordinary = await handle(load, new Request(`https://app.test${PAGE}`));

    await expect(ordinary.text()).resolves.toBe(HTML);
    expect(invokeNodeHandler).not.toHaveBeenCalled();

    vi.mocked(serveFromGeneration).mockClear();
    const upgrade = await handle(
      load,
      new Request(`https://app.test${PAGE}`, {
        headers: {
          upgrade: 'WebSocket',
          // Even trusted HTTP artifact modes cannot replace an upgrade's route invocation.
          [CAPTURE_HEADER]: '1',
          [CACHE_ROUTE_HEADER]: '/another-route',
        },
      }),
    );

    await expect(upgrade.text()).resolves.toBe('resumed');
    expect(invokeNodeHandler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: PAGE }),
    );

    const invoked = vi.mocked(invokeNodeHandler).mock.calls[0]?.[0];

    expect(invoked?.request).toBeInstanceOf(Request);
    expect(invoked?.request.headers.get('upgrade')).toBe('WebSocket');
    expect(serveFromGeneration).not.toHaveBeenCalled();
  });

  it.each([PAGE, '/[slug]'])(
    'serves a built document rendered by %s without evaluating its module',
    async (route) => {
      vi.mocked(getStore).mockReturnValue(deployment(false, route));
      const load = vi.fn(() => {
        throw new Error('the renderer must stay unloaded');
      });

      const answer = await handle(load, new Request(`https://app.test${PAGE}`), route);

      await expect(answer.text()).resolves.toBe(HTML);
      expect(load).not.toHaveBeenCalled();
      expect(invokeNodeHandler).not.toHaveBeenCalled();
    },
  );

  it('answers HEAD of a partial shell without evaluating its module', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const load = vi.fn(() => {
      throw new Error('the renderer must stay unloaded');
    });

    const answer = await handle(load, new Request(`https://app.test${PAGE}`, { method: 'HEAD' }));

    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(answer.body).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('serves a complete built Flight payload without evaluating its module', async () => {
    const load = vi.fn(() => {
      throw new Error('the renderer must stay unloaded');
    });

    const answer = await handle(
      load,
      new Request(`https://app.test${PAGE}`, { headers: { rsc: '1' } }),
    );

    await expect(answer.text()).resolves.toBe(FLIGHT);
    expect(load).not.toHaveBeenCalled();
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'serves a complete generation with RSC=%s without evaluating its module',
    async (rsc) => {
      const readBlob = vi.fn<Store['readBlob']>(missingBuiltBody);
      const blobs = vi.fn<BundleBlobReader>().mockResolvedValue(undefined);
      vi.mocked(getStore).mockReturnValue({ ...deployment(), readBlob });
      vi.mocked(serveFromGeneration).mockResolvedValue(new Response('cached generation'));
      const load = vi.fn(() => {
        throw new Error('the renderer must stay unloaded');
      });
      const request = new Request(`https://app.test${PAGE}`, { headers: rsc ? { rsc: '1' } : {} });

      const answer = await handle(load, request, PAGE, blobs);

      await expect(answer.text()).resolves.toBe('cached generation');
      expect(blobs).not.toHaveBeenCalled();
      expect(readBlob).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(invokeNodeHandler).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'renders a draft with RSC=%s without reading an omitted body',
    async (rsc) => {
      const readBlob = vi.fn<Store['readBlob']>(missingBuiltBody);
      const blobs = vi.fn<BundleBlobReader>().mockResolvedValue(undefined);
      const store = deployment();
      vi.mocked(getStore).mockReturnValue({
        ...store,
        readBlob,
        manifest: { ...store.manifest, bypassToken: 'draft-token' },
      });
      const handler = vi.fn<NodeHandler>().mockResolvedValue(undefined);
      const load = vi.fn(() => Promise.resolve({ handler }));
      const headers = { cookie: '__prerender_bypass=draft-token', ...(rsc && { rsc: '1' }) };

      const answer = await handle(
        load,
        new Request(`https://app.test${PAGE}`, { headers }),
        PAGE,
        blobs,
      );

      await expect(answer.text()).resolves.toBe('resumed');
      expect(blobs).not.toHaveBeenCalled();
      expect(readBlob).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledExactlyOnceWith();
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

  it('sends the partial shell while the renderer awaits its module', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const module = Promise.withResolvers<{ handler: NodeHandler }>();
    const load = vi.fn(() => module.promise);
    const handler = vi.fn(() => Promise.resolve());

    try {
      const answer = await handle(load, new Request(`https://app.test${PAGE}`));
      const reader = readerOf(answer);
      const first = await reader.read();

      expect(new TextDecoder().decode(first.value)).toBe(HTML);
      expect(handler).not.toHaveBeenCalled();

      module.resolve({ handler });
      const second = await reader.read();

      expect(new TextDecoder().decode(second.value)).toBe('resumed');
      await expect(reader.read()).resolves.toHaveProperty('done', true);
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      module.resolve({ handler });
    }
  });

  it('errors an already-started shell when its deferred module rejects', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    // The real bridge catches a failed handler and answers 500 before committing any suffix.
    vi.mocked(invokeNodeHandler).mockImplementation(async (input) => {
      try {
        return await render(input);
      } catch {
        return new Response(null, { status: 500 });
      }
    });
    const module = Promise.withResolvers<{ handler: NodeHandler }>();
    const answer = await handle(() => module.promise, new Request(`https://app.test${PAGE}`));
    const reader = readerOf(answer);
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe(HTML);

    const rest = reader.read();
    module.reject(new Error('the renderer failed to load'));

    await expect(rest).rejects.toThrow('next-runtime: resume answered 500');
  });
});
