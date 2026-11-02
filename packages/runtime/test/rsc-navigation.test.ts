import type { Prerender } from '@stayingupwind/core/bundle';
import { policyFromCacheControl } from '@stayingupwind/core/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler, WebHandler } from '../src/app-module.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { handleRequest } from '../src/handle.ts';
import { isMetadataOnlyRscRequest } from '../src/incoming.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';
import { fakeAuthority } from './authority.ts';

/**
 * A client router's requests for the payload of a page with dynamic parts, answered from a
 * generation the Worker made.
 *
 * What a regeneration stores of such a page is the payload its prefetch is answered with: the page
 * without its dynamic parts, and — under Cached Navigations — with the byte a prefetch is read by.
 * Handed that for a navigation, the client's router failed to read it, and the page ended on
 * "This page couldn't load" (`segment-cache/vary-params-base-dynamic`). Next.js renders a
 * navigation's payload from the page's state instead (`isDynamicRSCRequest`), and tells the
 * router what a prefetch it answers from its cache is (`x-nextjs-postponed`): without that, the
 * router prefetched a route the Worker had regenerated as one it could not prefetch per segment.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// What the page's render is handed is the question here, not what it answers.
vi.mock(import('../src/node-bridge.ts'), () => {
  const render = vi.fn(() => Promise.resolve(new Response('rendered')));
  return { invokeNodeHandler: render };
});

const SCOPE = 'dpl_rscNavigationTest';
const T0 = 1_800_000_000_000;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const PAGE = '/team';
const CLASS = '/[team]';
const encoder = new TextEncoder();
const BUILD_STATE = 'the postponed state the build wrote';
const GENERATION_STATE = 'the postponed state the last regeneration wrote';
const STORED_PAYLOAD = '0:["the prefetch payload the regeneration stored"]';
const STORED_TREE = '0:{"tree":{}}';
const PRELOAD = '</_next/static/media/geist.woff2>; rel=preload; as=font; crossorigin';
const CONFIG_LINK = '</configured.css>; rel=preload; as=style';
const MIDDLEWARE_LINK = '</middleware.css>; rel=preload; as=style';
const METADATA_ONLY_TREE = encodeURIComponent(JSON.stringify(['', {}, null, 'metadata-only']));
const blobs = new Map([
  ['postponed', encoder.encode(BUILD_STATE)],
  ['shell', encoder.encode('<html>shell</html>')],
]);
const RSC = {
  header: 'rsc',
  varyHeader: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
  prefetchHeader: 'next-router-prefetch',
  prefetchSegmentHeader: 'next-router-segment-prefetch',
  prefetchSegmentSuffix: '.segment.rsc',
  prefetchSegmentDirSuffix: '.segments',
};

function prerender(pathname: string, fields: Partial<Prerender>): Prerender {
  const postponed = { sha256: 'postponed', byteLength: 1, contentType: 'text/plain' };
  return {
    id: pathname,
    pathname,
    route: PAGE,
    parentOutputId: PAGE,
    groupId: 1,
    postponed,
    ...fields,
  };
}

/** A page the build made partially: its shell, and its payload's state beside it. */
function deployment(): Store {
  const shell = prerender(PAGE, {
    body: { sha256: 'shell', byteLength: 18, contentType: 'text/html' },
    renderingMode: 'PARTIALLY_STATIC',
  });
  const payload = prerender(`${PAGE}.rsc`, {});
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '', cacheComponents: true },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc: RSC,
      },
      entrypoints: [{ id: PAGE, kind: 'app-page', pathname: PAGE }],
    },
    pathnames: [PAGE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map([[PAGE, { pages: new Map([[PAGE, shell]]), patterns: [] }]]),
    prerendersById: new Map([
      [PAGE, shell],
      [payload.id, payload],
    ]),
    prerendersByPathname: new Map([
      [PAGE, shell],
      [payload.pathname, payload],
    ]),
    readBlob: (sha256: string) => blobs.get(sha256),
  } as unknown as Store;
}

/** An unbuilt member with a reusable PPR shell, including a shell whose static HTML exists. */
function coldDeployment(
  fields: Partial<Prerender> = {},
  cacheComponents = true,
  prefetchHeader = RSC.prefetchHeader,
): Store {
  const store = deployment();
  const shell = prerender(CLASS, {
    route: CLASS,
    parentOutputId: CLASS,
    renderingMode: 'PARTIALLY_STATIC',
    body: { sha256: 'shell', byteLength: 18, contentType: 'text/html' },
    ...fields,
  });
  const payload = prerender(`${CLASS}.rsc`, {
    route: CLASS,
    parentOutputId: CLASS,
    postponed: shell.postponed,
  });
  const route = {
    sourceRegex: '^/(?<nxtPteam>[^/]+?)(?:/)?$',
    destination: `${CLASS}?nxtPteam=$nxtPteam`,
  };
  const prerenders = [shell, payload];
  return {
    ...store,
    manifest: {
      ...store.manifest,
      config: { ...store.manifest.config, cacheComponents },
      routing: {
        ...store.manifest.routing,
        dynamicRoutes: [route],
        rsc: { ...RSC, prefetchHeader },
      },
      entrypoints: [{ id: CLASS, kind: 'app-page', pathname: CLASS }],
    },
    pathnames: [CLASS],
    dynamicRoutes: [route],
    shellsByRoute: new Map([
      [CLASS, { pages: new Map(), patterns: [{ pattern: /^\/[^/]+$/u, prerender: shell }] }],
    ]),
    prerendersById: new Map(prerenders.map((item) => [item.id, item])),
    prerendersByPathname: new Map(prerenders.map((item) => [item.pathname, item])),
  } as unknown as Store;
}

const page: NodeHandler = () => Promise.resolve();
const middleware: WebHandler = () => {
  return Promise.resolve(
    new Response(null, { headers: { 'x-middleware-next': '1', Link: MIDDLEWARE_LINK } }),
  );
};

function middlewareEntry() {
  return { handler: middleware };
}

const app: AppModule = {
  entries: {
    [PAGE]: () => ({ handler: page }),
    [CLASS]: () => ({ handler: page }),
    '/_middleware': middlewareEntry,
  },
};

/** A deployment whose cache holds a generation of the page a regeneration made. */
async function regenerated(partial = true) {
  const authority = fakeAuthority(SCOPE);
  await authority.record(
    { kind: 'app-page', route: PAGE, pathname: PAGE },
    {
      cacheTimestamp: T0,
      policy: policyFromCacheControl({ revalidate: 900, expire: 31_536_000 }),
      status: 200,
      headers: { LiNk: PRELOAD, 'x-recorded': 'kept' },
      tags: [],
      ...(partial && { postponed: encoder.encode(GENERATION_STATE) }),
      stored: new Map([
        ['rsc', encoder.encode(STORED_PAYLOAD)],
        ['segment:/_tree', encoder.encode(STORED_TREE)],
      ]),
    },
    encoder.encode('<html>regenerated</html>'),
    'runtime',
  );
  return createCacheRuntime({ env: ENV, now: () => T0, fetchImpl: authority.fetchImpl });
}

async function ask(
  headers: Record<string, string>,
  cache?: CacheRuntime | null,
): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`https://app.test${PAGE}?_rsc=abc`, { headers: { rsc: '1', ...headers } }),
    waitUntil: () => {
      // Nothing is scheduled for these answers.
    },
    cache: cache === null ? undefined : (cache ?? (await regenerated())),
    clock: T0 + 1000,
  });
}

/** A render of the page resumed from `postponed`. */
function resumedFrom(postponed: string): unknown {
  const requestMeta: unknown = expect.objectContaining({ postponed });
  return expect.objectContaining({ requestMeta });
}

describe("a client router's request for the payload of a page with dynamic parts", () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("is rendered from the current generation's state for a navigation", async () => {
    const response = await ask({ 'next-router-state-tree': '[]' });

    await expect(response.text()).resolves.toBe('rendered');
    expect(vi.mocked(invokeNodeHandler)).toHaveBeenCalledExactlyOnceWith(
      resumedFrom(GENERATION_STATE),
    );
  });

  it('renders only the head without reading the shared generation or capturing a full page', async () => {
    vi.mocked(getStore).mockReturnValue(coldDeployment());
    const fetchImpl = vi.fn(() => Promise.reject(new Error('no cache read is needed')));
    const cache = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl });

    const response = await ask({ 'next-router-state-tree': METADATA_ONLY_TREE }, cache);

    await expect(response.text()).resolves.toBe('rendered');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);

    const call = vi.mocked(invokeNodeHandler).mock.calls[0]?.[0];

    expect(call?.requestMeta['minimalMode']).toBe(true);
    expect(call?.requestMeta['postponed']).toBe('');
    expect(call?.request.headers.get('next-router-state-tree')).toBe(METADATA_ONLY_TREE);
    expect(call?.url).toContain('_rsc=abc');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a concrete prerender on its stored RSC path for a metadata-only request', async () => {
    const response = await ask(
      { 'next-router-state-tree': METADATA_ONLY_TREE },
      await regenerated(false),
    );

    await expect(response.text()).resolves.toBe(STORED_PAYLOAD);
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['a route without PPR', { renderingMode: 'STATIC', postponed: undefined }, false],
    ['an ensureStatic navigation', { ensureStatic: 'navigation' }, true],
  ] as const)('keeps %s on its original render path', async (_label, fields, cacheComponents) => {
    vi.mocked(getStore).mockReturnValue(coldDeployment(fields, cacheComponents));

    const response = await ask({ 'next-router-state-tree': METADATA_ONLY_TREE }, null);

    await expect(response.text()).resolves.toBe('rendered');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta).not.toHaveProperty(
      'postponed',
    );
  });

  it.each(['next-router-prefetch', 'x-router-prefetch'])(
    'keeps a static prefetch on the build state with the configured %s header',
    async (prefetchHeader) => {
      vi.mocked(getStore).mockReturnValue(coldDeployment({}, true, prefetchHeader));

      const response = await ask(
        { 'next-router-state-tree': METADATA_ONLY_TREE, [prefetchHeader]: '1' },
        null,
      );

      await expect(response.text()).resolves.toBe('rendered');
      expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
      expect(vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta['postponed']).toBe(
        BUILD_STATE,
      );
    },
  );

  it('is the stored payload for a prefetch, said to leave parts out', async () => {
    const response = await ask({ 'next-router-prefetch': '1' });

    expect(response.headers.get('x-nextjs-postponed')).toBe('1');
    expect(response.headers.has('link')).toBe(false);
    expect(response.headers.get('x-recorded')).toBe('kept');
    await expect(response.text()).resolves.toBe(STORED_PAYLOAD);
    expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
  });

  it('is the stored segment for a segment prefetch, said to be one', async () => {
    const response = await ask({
      'next-router-prefetch': '1',
      'next-router-segment-prefetch': '/_tree',
    });

    expect(response.headers.get('x-nextjs-postponed')).toBe('2');
    expect(response.headers.has('link')).toBe(false);
    expect(response.headers.get('x-recorded')).toBe('kept');
    await expect(response.text()).resolves.toBe(STORED_TREE);
    expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
  });

  it.each(['config', 'middleware'] as const)(
    'keeps explicit %s Link on stored payloads and segments',
    async (source) => {
      const store = deployment();
      vi.mocked(getStore).mockReturnValue({
        ...store,
        manifest: {
          ...store.manifest,
          routing: {
            ...store.manifest.routing,
            beforeMiddleware:
              source === 'config'
                ? [{ sourceRegex: '^/team$', headers: { Link: CONFIG_LINK } }]
                : [],
            middlewareMatchers: source === 'middleware' ? [{ sourceRegex: '^/team$' }] : [],
          },
        },
      });

      for (const segment of [undefined, '/_tree']) {
        const response = await ask({
          'next-router-prefetch': '1',
          ...(segment !== undefined && { 'next-router-segment-prefetch': segment }),
        });

        expect(response.headers.get('link')).toBe(
          source === 'config' ? CONFIG_LINK : MIDDLEWARE_LINK,
        );
        expect(response.headers.get('x-recorded')).toBe('kept');
        await expect(response.text()).resolves.toBe(
          segment === undefined ? STORED_PAYLOAD : STORED_TREE,
        );
      }

      expect(vi.mocked(invokeNodeHandler)).not.toHaveBeenCalled();
    },
  );
});

describe('a metadata-only navigation request', () => {
  it.each([
    [
      'the head-only router state',
      { rsc: '1', 'next-router-state-tree': METADATA_ONLY_TREE },
      true,
    ],
    [
      'a static prefetch',
      { rsc: '1', 'next-router-prefetch': '1', 'next-router-state-tree': METADATA_ONLY_TREE },
      false,
    ],
    ['a document request', { 'next-router-state-tree': METADATA_ONLY_TREE }, false],
    [
      'an ordinary navigation',
      { rsc: '1', 'next-router-state-tree': encodeURIComponent('["",{},null,"refetch"]') },
      false,
    ],
    [
      'a segment named metadata-only',
      { rsc: '1', 'next-router-state-tree': encodeURIComponent('["metadata-only",{}]') },
      false,
    ],
    ['malformed JSON', { rsc: '1', 'next-router-state-tree': 'metadata-only' }, false],
    ['malformed encoding', { rsc: '1', 'next-router-state-tree': '%metadata-only' }, false],
  ] as const)('recognizes %s', (_label, headers, expected) => {
    expect(isMetadataOnlyRscRequest(new Request('https://app.test', { headers }))).toBe(expected);
  });
});
