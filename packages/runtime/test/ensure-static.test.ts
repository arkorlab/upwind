import type { Prerender } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { handleRequest } from '../src/handle.ts';
import { type InvokeInput, invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

/**
 * A client navigation to a member the build did not render, of a route whose every navigation is
 * static (Next.js 16.4's `ensureStatic = 'navigation'`). Next.js answers it with a blocking render
 * rather than a dynamic one (`isDynamicRSCRequest`, in the page's handler); resumed from the class
 * shell's state here, it was answered with nothing at all: a 404 with no body
 * (`app-dir/ensure-static-navigation-runtime`). It is rendered once and kept, as its document is.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_ensureStaticTest000000';
const HOST = 'https://app.test';
const T0 = 1_800_000_000_000;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const DOCS = '/docs/[slug]';
const RSC = {
  header: 'rsc',
  varyHeader: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
  prefetchHeader: 'next-router-prefetch',
  prefetchSegmentHeader: 'next-router-segment-prefetch',
  prefetchSegmentSuffix: '.segment.rsc',
  prefetchSegmentDirSuffix: '.segments',
};
const CLASS_STATE = 'the class shell, its slug held up';
const MEMBER_STATE = 'the member, rendered for its own slug';
const encoder = new TextEncoder();
const blobs = new Map([
  ['postponed', encoder.encode(CLASS_STATE)],
  ['shell', encoder.encode('<html>the class shell')],
]);
const page: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [DOCS]: () => ({ handler: page }) } };

function prerender(pathname: string, fields: Partial<Prerender> = {}): Prerender {
  return { id: pathname, pathname, route: DOCS, parentOutputId: DOCS, groupId: 3, ...fields };
}

/** The route's class shell, and its payload, as the build made them; `ensureStatic` as it says. */
function deployment(ensureStatic: boolean): Store {
  const postponed = { sha256: 'postponed', byteLength: 1, contentType: 'application/json' };
  const shell = prerender(DOCS, {
    routeType: 'fallback',
    renderingMode: 'PARTIALLY_STATIC',
    body: { sha256: 'shell', byteLength: 1, contentType: 'text/html' },
    postponed,
    ...(ensureStatic && { ensureStatic: 'navigation' as const }),
  });
  const payload = prerender(`${DOCS}.rsc`, { renderingMode: 'PARTIALLY_STATIC', postponed });
  const route = {
    sourceRegex: '^/docs/(?<nxtPslug>[^/]+?)(?:/)?$',
    destination: `${DOCS}?nxtPslug=$nxtPslug`,
  };
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '', i18n: null, cacheComponents: true },
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
      entrypoints: [{ id: DOCS, kind: 'app-page', pathname: DOCS }],
    },
    pathnames: [DOCS],
    slashSpellings: new Map(),
    dynamicRoutes: [route],
    staticFiles: new Map(),
    shellsByRoute: new Map([
      [DOCS, { pages: new Map(), patterns: [{ pattern: /^\/docs\/[^/]+$/u, prerender: shell }] }],
    ]),
    prerendersById: new Map([
      [payload.id, payload],
      [shell.id, shell],
    ]),
    prerendersByPathname: new Map([
      [payload.pathname, payload],
      [shell.pathname, shell],
    ]),
    renderedPages: new Set(),
    readBlob: (sha256: string) => blobs.get(sha256),
    tryReadBlob: (sha256: string) => blobs.get(sha256),
  } as unknown as Store;
}

type CacheEntryCallback = (entry: unknown, meta: { url: string | undefined }) => unknown;

/** Next.js in minimal mode: a render captured where one is asked for; a resume says what it resumed. */
async function rendering(call: InvokeInput): Promise<Response> {
  const meta = call.requestMeta;
  const onCacheEntry = meta['onCacheEntry'] as CacheEntryCallback | undefined;
  if (onCacheEntry !== undefined) {
    await onCacheEntry(
      {
        value: {
          kind: 'APP_PAGE',
          html: { toUnchunkedString: () => '<html>the member' },
          rscData: encoder.encode('0:["the member"]'),
          headers: { 'content-type': 'text/html' },
          status: 200,
          postponed: MEMBER_STATE,
          segmentData: new Map(),
        },
        cacheControl: { revalidate: 60, expire: 3600 },
      },
      { url: call.url },
    );
    return new Response(null);
  }
  const postponed = meta['postponed'];
  return new Response(
    typeof postponed === 'string' ? `resumed from ${postponed}` : 'rendered as it came',
  );
}

/** The pathnames the page was rendered from to be kept. */
function kept(): (string | undefined)[] {
  return vi
    .mocked(invokeNodeHandler)
    .mock.calls.filter(([call]) => call.requestMeta['onCacheEntry'] !== undefined)
    .map(([call]) => call.url);
}

function leases(authority: FakeAuthority): number {
  return authority.calls.filter((call) => call === 'POST /attempts').length;
}

async function settle(pending: readonly Promise<unknown>[]): Promise<void> {
  for (let settled = 0; settled < pending.length;) {
    const batch = pending.slice(settled);
    settled = pending.length;
    await Promise.all(batch);
  }
}

interface Cache {
  readonly authority: FakeAuthority;
  readonly runtime: CacheRuntime;
}

function cache(): Cache {
  const authority = fakeAuthority(SCOPE, { keepOutputs: true });
  const runtime = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl: authority.fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return { authority, runtime };
}

/** A client navigation's payload request for `/docs/new`, read to its end, its work settled. */
async function navigate(cached: Cache | undefined): Promise<string> {
  const pending: Promise<unknown>[] = [];
  const response = await handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`${HOST}/docs/new?_rsc=n`, { headers: { rsc: '1' } }),
    waitUntil: (promise) => {
      pending.push(promise);
    },
    cache: cached?.runtime,
    clock: T0,
  });
  const body = await response.text();
  await settle(pending);
  return body;
}

describe('a navigation to a member the build did not render', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(invokeNodeHandler).mockReset().mockImplementation(rendering);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is rendered for the member and kept, where every navigation of its route is static', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const shared = cache();

    const first = await navigate(shared);
    const again = await navigate(shared);

    expect(first).toBe(`resumed from ${MEMBER_STATE}`);
    expect(again).toBe(`resumed from ${MEMBER_STATE}`);
    expect(kept()).toStrictEqual(['/docs/new']);
    expect(leases(shared.authority)).toBe(1);
  });

  /** A deployment may have no cache: the member is rendered for the request, not resumed. */
  it('is rendered for the request where no cache keeps a render', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));

    const answer = await navigate(undefined);

    expect(answer).toBe('rendered as it came');
  });

  it('is resumed from its class shell’s state, as before, where its route says nothing of it', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(false));
    const shared = cache();

    const answer = await navigate(shared);

    expect(answer).toBe(`resumed from ${CLASS_STATE}`);
    expect(kept()).toStrictEqual([]);
  });
});
