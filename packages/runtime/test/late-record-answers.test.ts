import type { Prerender } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import type { GenerationSource } from '../src/generation-source.ts';
import { serveFromGeneration } from '../src/generations.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { servePagesData } from '../src/outputs.ts';
import type { RoutedInput } from '../src/serve.ts';
import { getStore, type Store } from '../src/store.ts';
import { fakeAuthority } from './authority.ts';

/**
 * A document whose entry's record did not come in time, where the entry is rendered at a miss: the
 * runtime leaves it to the build's path, which renders it for the request, and that render says so
 * (`x-nextjs-cache: MISS`), as Next.js's own server says of a page it rendered for one. A cold
 * isolate's first read of a record through the read gateway can take longer than the 200 ms a
 * document waits for it (218 ms was seen), and minimal mode leaves the header to the platform.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

vi.mock(import('../src/generations.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, serveFromGeneration: vi.fn() };
});

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_lateRecordAnswersTest0';
const HOST = 'https://app.test';
const T0 = 1_800_000_000_000;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const POSTS = '/posts/[slug]';
const BUILT = '/posts/built';
const RSC = {
  header: 'rsc',
  varyHeader: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
  prefetchHeader: 'next-router-prefetch',
  prefetchSegmentHeader: 'next-router-segment-prefetch',
  prefetchSegmentSuffix: '.segment.rsc',
  prefetchSegmentDirSuffix: '.segments',
};
const encoder = new TextEncoder();
const BUILT_PAGE = encoder.encode('<html><body>built</body></html>');
const blobs = new Map([['built', BUILT_PAGE]]);
const page: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [POSTS]: () => ({ handler: page }) } };

function prerender(pathname: string, fields: Partial<Prerender> = {}): Prerender {
  return { id: pathname, pathname, route: POSTS, parentOutputId: POSTS, groupId: 1, ...fields };
}

/** A route whose class the build wrote no page of, and one member it rendered. */
function deployment(): Store {
  const template = prerender(POSTS);
  const built = prerender(BUILT, {
    body: { sha256: 'built', byteLength: BUILT_PAGE.byteLength, contentType: 'text/html' },
  });
  const route = {
    sourceRegex: '^/posts/(?<nxtPslug>[^/]+?)(?:/)?$',
    destination: `${POSTS}?nxtPslug=$nxtPslug`,
  };
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '', i18n: null },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [route],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc: RSC,
      },
      entrypoints: [{ id: POSTS, kind: 'app-page', pathname: POSTS }],
    },
    pathnames: [POSTS, BUILT],
    slashSpellings: new Map(),
    dynamicRoutes: [route],
    staticFiles: new Map(),
    shellsByRoute: new Map([
      [
        POSTS,
        {
          pages: new Map([[BUILT, built]]),
          patterns: [{ pattern: /^\/posts\/[^/]+$/u, prerender: template }],
        },
      ],
    ]),
    prerendersById: new Map([template, built].map((each) => [each.id, each])),
    prerendersByPathname: new Map([template, built].map((each) => [each.pathname, each])),
    renderedPages: new Set(),
    readBlob: (sha256: string) => blobs.get(sha256),
    tryReadBlob: (sha256: string) => blobs.get(sha256),
  } as unknown as Store;
}

function runtimeOf(): CacheRuntime {
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => T0,
    fetchImpl: fakeAuthority(SCOPE).fetchImpl,
  });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

/** The record of `path`'s entry as late as `tell` says: told to the caller, or not. */
function lateRecord(tell: boolean): void {
  vi.mocked(serveFromGeneration).mockImplementation((_input, _store, source: GenerationSource) => {
    if (tell) {
      source.onRenderLeft?.();
    }
    return Promise.resolve(undefined);
  });
}

async function ask(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`${HOST}${path}`, { headers }),
    waitUntil: () => {
      /* Nothing here is left behind. */
    },
    cache: runtimeOf(),
    clock: T0,
  });
}

describe('a document whose record did not come in time', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('rendered for the request'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(serveFromGeneration).mockReset();
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('is a render at a miss where the build made no page of the member', async () => {
    lateRecord(true);

    const response = await ask('/posts/late');

    await expect(response.text()).resolves.toBe('rendered for the request');
    expect(response.headers.get('x-nextjs-cache')).toBe('MISS');
  });

  it("is one for a navigation's payload too", async () => {
    lateRecord(true);

    const response = await ask('/posts/late', { rsc: '1' });

    await expect(response.text()).resolves.toBe('rendered for the request');
    expect(response.headers.get('x-nextjs-cache')).toBe('MISS');
  });

  it('says nothing of a render the cache was not asked about in time for', async () => {
    lateRecord(false);

    const response = await ask('/posts/late');

    await expect(response.text()).resolves.toBe('rendered for the request');
    expect(response.headers.get('x-nextjs-cache')).toBeNull();
  });

  it("keeps the build's own page what it is, a hit", async () => {
    lateRecord(true);

    const response = await ask(BUILT);

    await expect(response.text()).resolves.toBe('<html><body>built</body></html>');
    expect(response.headers.get('x-nextjs-cache')).toBe('HIT');
    expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
  });
});

const ITEMS = '/items/[id]';
const DATA = '/_next/data/build/items';
const BUILT_DATA = encoder.encode('{"pageProps":{"built":true}}');

/** A Pages Router route whose data the build wrote for one member, and none for the rest. */
function pagesDeployment(): Store {
  const template = prerender(`${DATA}/[id].json`, { route: ITEMS, parentOutputId: ITEMS });
  const built = prerender(`${DATA}/built.json`, {
    route: ITEMS,
    parentOutputId: ITEMS,
    body: {
      sha256: 'built-data',
      byteLength: BUILT_DATA.byteLength,
      contentType: 'application/json',
    },
  });
  const shell = prerender(ITEMS, { route: ITEMS, parentOutputId: ITEMS });
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      entrypoints: [{ id: ITEMS, kind: 'pages', pathname: ITEMS }],
      routing: { rsc: RSC },
    },
    prerendersByPathname: new Map([template, built].map((each) => [each.pathname, each])),
    shellsByRoute: new Map([
      [ITEMS, { pages: new Map(), patterns: [{ pattern: /^\/items\/[^/]+$/u, prerender: shell }] }],
    ]),
    pathnames: [ITEMS],
    slashSpellings: new Map(),
    readBlob: () => BUILT_DATA,
  } as unknown as Store;
}

/** A data request for `pathname`, under the route's data template. */
function askData(pathname: string): Promise<Response> {
  const request = new Request(`${HOST}${pathname}`);
  const input: RoutedInput = {
    app: { entries: { [ITEMS]: () => ({ handler: page }) } },
    edge: { entries: {} },
    request,
    initURL: request.url,
    cache: runtimeOf(),
    run: (work) => work(),
    waitUntil: () => {
      /* Nothing here is left behind. */
    },
  };
  return servePagesData(input, pagesDeployment(), {
    route: `${DATA}/[id].json`,
    pathname,
    url: pathname,
  });
}

describe('a Pages data request whose record did not come in time', () => {
  beforeEach(() => {
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('{"pageProps":{"rendered":true}}'));
  });

  afterEach(() => {
    vi.mocked(serveFromGeneration).mockReset();
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('is a render at a miss where the build wrote no data of the member', async () => {
    lateRecord(true);

    const response = await askData(`${DATA}/late.json`);

    await expect(response.text()).resolves.toBe('{"pageProps":{"rendered":true}}');
    expect(response.headers.get('x-nextjs-cache')).toBe('MISS');
  });

  it('says nothing of a render the cache was not asked about in time for', async () => {
    lateRecord(false);

    const response = await askData(`${DATA}/late.json`);

    expect(response.headers.get('x-nextjs-cache')).toBeNull();
  });

  it("keeps the build's own data what it is, a hit", async () => {
    lateRecord(true);

    const response = await askData(`${DATA}/built.json`);

    await expect(response.text()).resolves.toBe('{"pageProps":{"built":true}}');
    expect(response.headers.get('x-nextjs-cache')).toBe('HIT');
    expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
  });
});
