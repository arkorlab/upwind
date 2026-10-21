import { readFileSync } from 'node:fs';

import { packPrerenders } from '@stayingupwind/core/bundle';
import { type DecodedGenerationPack, policyFromCacheControl } from '@stayingupwind/core/cache';
import { CACHE_ROUTE_HEADER, GENERATION_HEADER } from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FALLBACK_MEMBER,
  FALLBACK_PAGE,
  FALLBACK_ROUTE,
  fallbackBundle,
} from '../../core/test/fallback-pages-fixtures.ts';
import type { NodeHandler } from '../src/app-module.ts';
import { currentGeneration } from '../src/cache/current.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import { nodeHandlerOf } from '../src/entries.ts';
import { handleDetached, handleForeground, serveFromGeneration } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import type { RoutedInput } from '../src/serve.ts';
import { findShell, getStore, type Store } from '../src/store.ts';
import { NOW, runtimeOf, SCOPE } from './pages-isr-fixtures.ts';

vi.mock(import('node:fs'), async (original) => ({ ...(await original()), readFileSync: vi.fn() }));

vi.mock(import('../src/cache/current.ts'), () => ({ currentGeneration: vi.fn() }));
vi.mock(import('../src/cache/regenerate.ts'), () => ({ regenerate: vi.fn() }));
vi.mock(import('../src/entries.ts'), async (original) => {
  return {
    ...(await original()),
    nodeHandlerOf: vi.fn(),
  };
});
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const encoder = new TextEncoder();
const handler: NodeHandler = () => Promise.resolve();
const LOADING = '<p>hi fallback</p>';
const COMPLETE = '<p>Post: second</p>';
const DATA = '{"pageProps":{"post":"second"}}';
const RENDER = {
  html: encoder.encode(COMPLETE),
  data: encoder.encode(DATA),
  postponed: undefined,
  rscData: undefined,
  segments: new Map<string, Uint8Array>(),
  headers: { 'content-type': 'text/html' },
  status: 200,
  cacheControl: { revalidate: 2 },
};

function storeOf(): Store {
  const manifest = fallbackBundle({ deploymentId: SCOPE });
  return {
    manifest,
    prerendersById: new Map(manifest.prerenders.map((page) => [page.id, page])),
    prerendersByPathname: new Map(manifest.prerenders.map((page) => [page.pathname, page])),
    shellsByRoute: new Map([
      [
        FALLBACK_ROUTE,
        {
          pages: new Map([[FALLBACK_MEMBER.pathname, FALLBACK_MEMBER]]),
          patterns: [{ pattern: /^\/fallback-true\/[^/]+$/u, prerender: FALLBACK_PAGE }],
        },
      ],
    ]),
    staticFiles: new Map(),
    pathnames: [],
    slashSpellings: new Map(),
    dynamicRoutes: manifest.routing.dynamicRoutes,
    renderedPages: new Set([FALLBACK_ROUTE]),
    readBlob: () => encoder.encode(LOADING),
    tryReadBlob: () => encoder.encode(LOADING),
  };
}

function inputOf(pathname = '/fallback-true/second', generation?: string) {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers({ [CACHE_ROUTE_HEADER]: FALLBACK_ROUTE });
  if (generation !== undefined) headers.set(GENERATION_HEADER, generation);
  const request = new Request(`https://app.test${pathname}`, { headers });
  const runtime = runtimeOf([]);
  const input: RoutedInput = {
    app: { entries: {} },
    edge: { entries: {} },
    request,
    initURL: request.url,
    cache: runtime,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    run: (work) => work(),
  };
  return { input, runtime, pending };
}

function packOf(): DecodedGenerationPack {
  return {
    header: {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId: 'member',
      generationId: 'runtime-1',
      seq: 1,
      source: 'runtime',
      staticPagePrivacy: 3,
      kind: 'pages',
      route: FALLBACK_ROUTE,
      pathname: '/fallback-true/second',
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromCacheControl({ revalidate: 2, expire: 60 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: 'a'.repeat(64),
      htmlLength: RENDER.html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [
        {
          artifactId: 'json',
          sha256: 'b'.repeat(64),
          byteLength: RENDER.data.byteLength,
          contentType: 'application/json',
          encoding: 'identity',
          role: 'pages-data',
          representationKey: 'pages-data',
        },
      ],
      revision: 1,
    },
    html: RENDER.html,
    postponed: undefined,
  };
}

describe('version3 Pages fallback generation callers', () => {
  beforeEach(() => {
    vi.mocked(nodeHandlerOf).mockResolvedValue(handler);
    vi.mocked(currentGeneration).mockResolvedValue({ kind: 'none', entryId: 'member' });
    vi.mocked(regenerate).mockResolvedValue({
      kind: 'accepted',
      render: RENDER,
      published: Promise.resolve({ kind: 'published', generationId: 'runtime-1' }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('the packed native manifest retains built members and independent loading classes in the real Store', () => {
    const manifest = fallbackBundle({ deploymentId: SCOPE });
    const packed = { ...manifest, prerenders: packPrerenders(manifest.prerenders) };
    const manifestBytes = Buffer.from(JSON.stringify(packed));
    vi.mocked(readFileSync).mockReturnValue(manifestBytes);

    const store = getStore();

    expect(findShell(store, FALLBACK_ROUTE, FALLBACK_MEMBER.pathname)).toStrictEqual(
      FALLBACK_MEMBER,
    );
    expect(findShell(store, FALLBACK_ROUTE, '/fallback-true/second')).toStrictEqual(FALLBACK_PAGE);
    expect(store.manifest.prerenders.map(({ id }) => id)).toStrictEqual(
      manifest.prerenders.map(({ id }) => id),
    );
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith('/bundle/runtime.json');
  });

  it('serves the loading shell before starting its concrete background member', async () => {
    const { input, pending } = inputOf();
    const response = await serveFromGeneration(
      input,
      storeOf(),
      {
        route: FALLBACK_ROUTE,
        pathname: '/fallback-true/second',
        url: '/fallback-true/second',
        representation: 'html',
        onMiss: 'behind',
        pagesFallback: true,
      },
      handler,
    );

    expect(regenerate).not.toHaveBeenCalled();
    await expect(response?.text()).resolves.toBe(LOADING);

    await Promise.all(pending);

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target).toMatchObject({
      descriptor: { kind: 'pages', route: FALLBACK_ROUTE, pathname: '/fallback-true/second' },
      reason: 'miss',
      replaces: null,
      dataPathname: '/_next/data/build/fallback-true/second.json',
    });
  });

  it('a trusted detached first render uses a concrete miss without inventing a class generation', async () => {
    const { input, pending } = inputOf();
    const response = await handleDetached(input, storeOf());
    await Promise.all(pending);

    expect(response.status).toBe(202);
    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target).toMatchObject({
      descriptor: { kind: 'pages', route: FALLBACK_ROUTE, pathname: '/fallback-true/second' },
      reason: 'miss',
      replaces: null,
    });
  });

  it.each([undefined, 'runtime-1'])(
    'cold/expired data waits beyond the ordinary EOF bound for its own publication: %s',
    async (generation) => {
      vi.useFakeTimers();
      const publication = Promise.withResolvers<{
        readonly kind: 'published';
        readonly generationId: string;
      }>();
      vi.mocked(regenerate).mockResolvedValue({
        kind: 'accepted',
        render: RENDER,
        published: publication.promise,
      });
      const { input } = inputOf('/_next/data/build/fallback-true/second.json', generation);
      let returned = false;
      const result = (async () => {
        const answer = await handleForeground(input, storeOf());
        returned = true;
        return answer;
      })();

      await vi.advanceTimersByTimeAsync(2500);

      expect(returned).toBe(false);
      expect(vi.mocked(regenerate).mock.calls[0]?.[0].target).toMatchObject({
        descriptor: { kind: 'pages', route: FALLBACK_ROUTE, pathname: '/fallback-true/second' },
        replaces: generation ?? null,
      });

      publication.resolve({ kind: 'published', generationId: 'runtime-2' });
      const answer = await result;

      await expect(answer.response?.text()).resolves.toBe(DATA);
      expect(answer.response?.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(answer.response?.headers.get('cache-control')).toBe('private, no-store');
      expect(answer.regenerated?.pathname).toBe('/fallback-true/second');
    },
  );

  it('joins its slow local background publication before answering the immediate data request', async () => {
    vi.useFakeTimers();
    const publication = Promise.withResolvers<unknown>();
    vi.mocked(regenerate).mockResolvedValue({
      kind: 'busy',
      publishing: RENDER,
      published: publication.promise,
    });
    const { input } = inputOf('/_next/data/build/fallback-true/second.json');
    let returned = false;
    const result = (async () => {
      const answer = await handleForeground(input, storeOf());
      returned = true;
      return answer;
    })();

    await vi.advanceTimersByTimeAsync(2500);

    expect(returned).toBe(false);

    publication.resolve({ kind: 'published' });

    await expect((await result).response?.text()).resolves.toBe(DATA);
  });

  it('returns an intact private response when publication exceeds the cold-only bound', async () => {
    vi.useFakeTimers();
    const publication = Promise.withResolvers<{
      readonly kind: 'published';
      readonly generationId: string;
    }>();
    vi.mocked(regenerate).mockResolvedValue({
      kind: 'accepted',
      render: RENDER,
      published: publication.promise,
    });
    const { input } = inputOf('/_next/data/build/fallback-true/second.json');
    const result = handleForeground(input, storeOf());
    await vi.advanceTimersByTimeAsync(10_000);
    const answer = await result;

    expect(answer.response?.headers.get('cache-control')).toBe('private, no-store');
    await expect(answer.response?.text()).resolves.toBe(DATA);

    publication.resolve({ kind: 'published', generationId: 'late' });
  });

  it('keeps a foreign busy render private without inventing a publication ACK', async () => {
    vi.mocked(regenerate).mockResolvedValue({ kind: 'busy' });
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      new Response(DATA, {
        headers: {
          'content-type': 'application/json',
          'cache-control': 's-maxage=2, stale-while-revalidate=58',
        },
      }),
    );
    const { input } = inputOf('/_next/data/build/fallback-true/second.json');
    const answer = await handleForeground(input, storeOf());

    expect(answer.outcome).toBe('busy');
    expect(answer.response?.headers.get('cache-control')).toBe('private, no-store');
    await expect(answer.response?.text()).resolves.toBe(DATA);
  });

  it('keeps refused publication private while preserving the captured JSON body', async () => {
    vi.mocked(regenerate).mockResolvedValue({
      kind: 'accepted',
      render: RENDER,
      published: Promise.resolve({ kind: 'refused', reason: 'generation changed' }),
    });
    const { input } = inputOf('/_next/data/build/fallback-true/second.json');
    const answer = await handleForeground(input, storeOf());

    expect(answer.response?.headers.get('cache-control')).toBe('private, no-store');
    await expect(answer.response?.text()).resolves.toBe(DATA);
  });

  it('does not wait for a publish before returning foreground HTML', async () => {
    const publication = Promise.withResolvers<{
      readonly kind: 'published';
      readonly generationId: string;
    }>();
    vi.mocked(regenerate).mockResolvedValue({
      kind: 'accepted',
      render: RENDER,
      published: publication.promise,
    });
    const { input } = inputOf();
    const answer = await handleForeground(input, storeOf());

    await expect(answer.response?.text()).resolves.toBe(COMPLETE);

    publication.resolve({ kind: 'published', generationId: 'later' });
  });

  it('adopts an existing concrete runtime generation without another render or loading shell', async () => {
    const current = { entryId: 'member', pack: packOf(), validity: 'fresh' as const };
    vi.mocked(currentGeneration).mockResolvedValue({ kind: 'generation', current });
    const { input, runtime } = inputOf();
    const read = vi.spyOn(runtime.host, 'readArtifact').mockResolvedValue(RENDER.data);
    const source = {
      route: FALLBACK_ROUTE,
      pathname: '/fallback-true/second',
      url: '/fallback-true/second',
      representation: 'html' as const,
      onMiss: 'behind' as const,
      pagesFallback: true,
    };
    const html = await serveFromGeneration(input, storeOf(), source, handler);
    const data = await serveFromGeneration(
      input,
      storeOf(),
      {
        ...source,
        representation: 'pages-data',
        dataPathname: '/_next/data/build/fallback-true/second.json',
      },
      handler,
    );

    await expect(html?.text()).resolves.toBe(COMPLETE);
    await expect(data?.text()).resolves.toBe(DATA);
    expect(regenerate).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps stale member regeneration behind the response body', async () => {
    vi.mocked(currentGeneration).mockResolvedValue({
      kind: 'generation',
      current: { entryId: 'member', pack: packOf(), validity: 'stale' },
    });
    const { input, pending } = inputOf();
    const response = await serveFromGeneration(
      input,
      storeOf(),
      {
        route: FALLBACK_ROUTE,
        pathname: '/fallback-true/second',
        url: '/fallback-true/second',
        representation: 'html',
        onMiss: 'behind',
        pagesFallback: true,
      },
      handler,
    );

    expect(regenerate).not.toHaveBeenCalled();
    await expect(response?.text()).resolves.toBe(COMPLETE);

    await Promise.all(pending);

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target).toMatchObject({
      reason: 'stale',
      replaces: 'runtime-1',
    });
  });

  it.each([
    '/_next/data/other/fallback-true/second.json',
    '/_next/data/build/fallback-true/second.json/extra',
    '/_next/data/build/fallback-true/a%2Fb.json',
  ])('does not manufacture a member from an unproved data pathname: %s', async (pathname) => {
    const { input } = inputOf(pathname);
    const answer = await handleForeground(input, storeOf());

    expect(answer.response).toBeUndefined();
    expect(regenerate).not.toHaveBeenCalled();
  });
});
