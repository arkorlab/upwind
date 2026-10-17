import type { Prerender } from '@stayingupwind/core/bundle';
import { deriveEntry, packBodyDigests, policyFromBuild } from '@stayingupwind/core/cache';
import { CACHE_ROUTE_HEADER } from '@stayingupwind/core/paas';
import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { requestContextFor } from '../src/cache/context.ts';
import type { CacheHost } from '../src/cache/host.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';
import { handleForeground } from '../src/generations.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});
vi.mock(import('../src/cache/regenerate.ts'), () => ({ regenerate: vi.fn() }));
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const NOW = 1_800_000_000_000;
const HOLD_MS = 5000;
const ENTRIES = 64;
const ROUTE = '/[lang]/nested';
const SUBSET = '/[lang]/posts/[id]';
const CATCH_ALL = '/[lang]/posts/[...slug]';
const HOST = 'https://app.test';
const SCOPE = 'root-fallback';
const encoder = new TextEncoder();
const handler: NodeHandler = () => Promise.resolve();

function frozen(): number {
  return NOW;
}

function unasked(): Promise<never> {
  return Promise.reject(new Error('not asked by a root fallback read'));
}

/** Only the cache host and the Next.js bridge are replaced; routing and generation reads run. */
function scenario(allowQuery = ['nxtPlang'], route = ROUTE, kind = 'app-page') {
  const template: Prerender = {
    id: route,
    pathname: route,
    route,
    parentOutputId: route,
    groupId: 1,
    routeType: 'page',
    renderingMode: kind === 'app-page' ? 'PARTIALLY_STATIC' : 'STATIC',
    allowQuery,
    body: { sha256: 'build-html', byteLength: 5, contentType: 'text/html' },
  };
  const payload: Prerender = {
    ...template,
    id: `${route}.rsc`,
    pathname: `${route}.rsc`,
    body: { sha256: 'build-rsc', byteLength: 9, contentType: 'text/x-component' },
  };
  const sourceRegex = `^${route
    .replace('[lang]', '(?<nxtPlang>[^/]+?)')
    .replace('[id]', '(?<nxtPid>[^/]+?)')
    .replace('[...slug]', '(?<nxtPslug>.+?)')}(?:/)?$`;
  const ordinaryPattern =
    route === SUBSET ? /^\/[^/]+\/posts\/[^/]+\/?$/u : /^\/[^/]+\/nested\/?$/u;
  const pattern = route === CATCH_ALL ? /^\/[^/]+\/posts\/.+$/u : ordinaryPattern;
  const dynamic = {
    sourceRegex,
    destination: `${route}?nxtPlang=$nxtPlang${route === SUBSET ? '&nxtPid=$nxtPid' : ''}${route === CATCH_ALL ? '&nxtPslug=$nxtPslug' : ''}`,
  };
  const prerenders = [template, payload];
  const store = {
    manifest: {
      buildId: 'build',
      deploymentId: SCOPE,
      config: { basePath: '', i18n: null, cacheComponents: true },
      entrypoints: [{ id: route, pathname: route, kind }],
      prerenders,
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [dynamic],
        onMatch: [],
        fallback: [],
        rsc: {
          header: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
        },
      },
    },
    pathnames: [route],
    slashSpellings: new Map(),
    dynamicRoutes: [dynamic],
    staticFiles: new Map(),
    shellsByRoute: new Map([
      [
        route,
        {
          pages: new Map(),
          patterns: [
            {
              pattern,
              prerender: template,
            },
          ],
        },
      ],
    ]),
    prerendersById: new Map(prerenders.map((each) => [each.id, each])),
    prerendersByPathname: new Map(prerenders.map((each) => [each.pathname, each])),
    renderedPages: new Set(),
    readBlob: (sha256: string) => encoder.encode(sha256 === 'build-html' ? 'BUILD' : 'BUILD-RSC'),
  } as unknown as Store;
  vi.mocked(getStore).mockReturnValue(store);
  const readRecord = vi.fn<CacheHost['readRecord']>().mockResolvedValue(undefined);
  const host: CacheHost = {
    startAttempt: unasked,
    uploadArtifact: unasked,
    heartbeat: unasked,
    commit: unasked,
    fail: unasked,
    readRecord,
    readArtifact: unasked,
    getData: unasked,
    setData: unasked,
    getTags: unasked,
    tagsDelta: unasked,
    invalidate: unasked,
  };
  const runtime: CacheRuntime = {
    scopeId: SCOPE,
    host,
    tags: new TagState({ holdMs: HOLD_MS }),
    holdMs: HOLD_MS,
    clockOf: frozen,
    dataMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    dataStates: new TtlCache(Infinity, ENTRIES, frozen),
    dataWrites: new Map(),
    entryIds: new TtlCache(Infinity, ENTRIES, frozen),
    recordMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    recordReads: new Map(),
    regenerationMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    publishing: new TtlCache(HOLD_MS, ENTRIES, frozen),
    letGo: new WeakSet(),
    givenBack: new TtlCache(HOLD_MS, ENTRIES, frozen),
    artifactMemo: new TtlCache(Infinity, ENTRIES, frozen),
    log: vi.fn(),
  };
  const app: AppModule = { entries: { [route]: () => ({ handler }) } };
  const tables = { app, edge: { entries: {} } };
  const pending: Promise<unknown>[] = [];
  const waitUntil = (work: Promise<unknown>) => {
    pending.push(work);
  };
  const ask = async (path: string, headers: Record<string, string> = {}, method = 'GET') => {
    const response = await handleRequest({
      ...tables,
      request: new Request(`${HOST}${path}`, { headers, method }),
      cache: runtime,
      waitUntil,
      clock: NOW,
    });
    const body = await response.text();
    await Promise.all(pending.splice(0));
    return body;
  };
  const context = (path: string, headers: Record<string, string> = {}) => {
    return requestContextFor({
      tables,
      runtime,
      request: new Request(`${HOST}${path}`, { headers }),
      startedAt: NOW,
      clock: NOW,
      waitUntil,
    });
  };
  return { store, runtime, ask, context, tables, waitUntil, readRecord };
}

/** A complete runtime generation with both representations, keyed by the pathname it was made for. */
async function remember(
  runtime: CacheRuntime,
  route: string,
  pathname: string,
  { text, postponed }: { readonly text: string; readonly postponed?: string },
) {
  const descriptor = { kind: 'app-page' as const, route, pathname };
  const { entryId } = await deriveEntry(SCOPE, descriptor);
  const html = encoder.encode(text);
  const artifactId = `rsc:${pathname}`;
  runtime.artifactMemo.set(artifactId, encoder.encode(`RSC:${text}`));
  runtime.recordMemo.set(entryId, {
    header: {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: `generation:${pathname}`,
      seq: 1,
      source: 'runtime',
      ...descriptor,
      cacheTimestamp: NOW - 1,
      producedAt: NOW - 1,
      policy: policyFromBuild({ initialRevalidate: false }),
      status: 200,
      headers: {},
      tags: [{ kind: 'next-explicit', value: pathname }],
      artifacts: [
        {
          artifactId,
          role: 'rsc',
          representationKey: 'rsc',
          sha256: '0'.repeat(64),
          byteLength: text.length + 4,
          contentType: 'text/x-component',
          encoding: 'identity',
        },
      ],
      revision: 1,
      ...(await packBodyDigests(
        html,
        postponed === undefined ? undefined : encoder.encode(postponed),
      )),
    },
    html,
    postponed: postponed === undefined ? undefined : encoder.encode(postponed),
  });
}

function accepted(text: string): ReturnType<typeof regenerate> {
  return Promise.resolve({
    kind: 'accepted',
    render: {
      html: encoder.encode(text),
      rscData: encoder.encode(`RSC:${text}`),
      postponed: undefined,
      segments: new Map(),
      headers: {},
      status: 200,
      cacheControl: { revalidate: 60, expire: undefined },
      data: undefined,
    },
    published: Promise.resolve({ kind: 'published', generationId: 'new' }),
  });
}

describe('a built root fallback keyed by route parameters', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('DYNAMIC'));
    vi.mocked(regenerate).mockImplementation(() => accepted('NEW-IT'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([{}, { rsc: '1' }])(
    'uses the same root-specific generation for headers %j',
    async (headers) => {
      const { runtime, ask, readRecord } = scenario();
      await remember(runtime, ROUTE, '/it/nested', { text: 'CURRENT-IT' });
      await remember(runtime, ROUTE, '/en/nested', { text: 'CURRENT-EN' });
      const prefix = 'rsc' in headers ? 'RSC:' : '';

      await expect(ask('/it/nested', headers)).resolves.toBe(`${prefix}CURRENT-IT`);
      await expect(ask('/en/nested', headers)).resolves.toBe(`${prefix}CURRENT-EN`);
      expect(readRecord).not.toHaveBeenCalled();
      expect(regenerate).not.toHaveBeenCalled();
    },
  );

  it('regenerates an invalidated root without replacing an unrelated root', async () => {
    const { runtime, ask } = scenario();
    await remember(runtime, ROUTE, '/it/nested', { text: 'OLD-IT' });
    await remember(runtime, ROUTE, '/en/nested', { text: 'CURRENT-EN' });
    runtime.tags.applyLocal(['/it/nested'], { staleAt: NOW, hardExpireAt: NOW });

    await expect(ask('/it/nested')).resolves.toBe('NEW-IT');
    await expect(ask('/en/nested')).resolves.toBe('CURRENT-EN');
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual({
      kind: 'app-page',
      route: ROUTE,
      pathname: '/it/nested',
    });
    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.reason).toBe('expired');
  });

  it('renders a novel root on a miss rather than returning the generic build body', async () => {
    const { ask } = scenario();

    await expect(ask('/it/nested')).resolves.toBe('NEW-IT');
    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual({
      kind: 'app-page',
      route: ROUTE,
      pathname: '/it/nested',
    });
    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.reason).toBe('miss');
  });

  it('uses a completed subset key for document, payload, foreground and manual regeneration', async () => {
    const { runtime, ask, context, store, tables, waitUntil } = scenario(['nxtPlang'], SUBSET);
    const pathname = '/it/posts/[id]';
    await remember(runtime, SUBSET, pathname, { text: 'CURRENT-IT' });

    await expect(ask('/it/posts/1')).resolves.toBe('CURRENT-IT');
    await expect(ask('/it/posts/2', { rsc: '1' })).resolves.toBe('RSC:CURRENT-IT');

    const foreground = context('/it/posts/1', { [CACHE_ROUTE_HEADER]: SUBSET });
    await foreground.run(() => {
      return handleForeground(
        {
          ...tables,
          request: foreground.request,
          initURL: foreground.request.url,
          cache: runtime,
          waitUntil,
          run: foreground.run,
        },
        store,
      );
    });
    const manual = context('/api/revalidate');
    await manual.run(() => platformRevalidate({ urlPath: '/it/posts/2' }));

    expect(regenerate).toHaveBeenCalledTimes(2);

    for (const [call] of vi.mocked(regenerate).mock.calls) {
      expect(call.target.descriptor).toStrictEqual({ kind: 'app-page', route: SUBSET, pathname });
    }
  });

  it('passes the completed subset generation state to a server action', async () => {
    const { runtime, ask } = scenario(['nxtPlang'], SUBSET);
    await remember(runtime, SUBSET, '/it/posts/[id]', {
      text: 'CURRENT-IT',
      postponed: 'CURRENT-IT-STATE',
    });

    await ask(
      '/it/posts/1',
      { 'next-action': 'an-action', 'content-type': 'text/plain;charset=UTF-8' },
      'POST',
    );

    expect(vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta['postponed']).toBe(
      'CURRENT-IT-STATE',
    );
  });

  it('keeps an unkeyed built shell shared while manual regeneration remains concrete', async () => {
    const { runtime, ask, context, readRecord } = scenario([]);
    await remember(runtime, ROUTE, ROUTE, { text: 'SHARED' });

    await expect(ask('/it/nested')).resolves.toBe('SHARED');
    await expect(ask('/en/nested')).resolves.toBe('SHARED');
    expect(readRecord).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();

    const manual = context('/api/revalidate');
    await manual.run(() => platformRevalidate({ urlPath: '/it/nested' }));

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual({
      kind: 'app-page',
      route: ROUTE,
      pathname: '/it/nested',
    });
  });

  it('does not read a generation for a build body varying on an unrelated query', async () => {
    const { ask, readRecord } = scenario(['preview']);

    await expect(ask('/it/nested')).resolves.toBe('BUILD');
    expect(readRecord).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('keeps a Pages Router loading fallback rather than generating a blocking member', async () => {
    const { ask, readRecord } = scenario(['nxtPlang'], ROUTE, 'pages');

    await expect(ask('/it/nested')).resolves.toBe('BUILD');
    expect(readRecord).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('keeps an unsupported root-keyed catch-all on the build path without per-member records', async () => {
    const { ask, readRecord } = scenario(['nxtPlang'], CATCH_ALL);

    await expect(ask('/it/posts/one/two')).resolves.toBe('BUILD');
    expect(readRecord).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });
});
