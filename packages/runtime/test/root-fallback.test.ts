import type { Prerender } from '@stayingupwind/core/bundle';
import {
  type CachePolicy,
  deriveEntry,
  IMPLICIT_TAG_PREFIX,
  packBodyDigests,
  policyFromBuild,
  policyFromCacheControl,
} from '@stayingupwind/core/cache';
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
/** `client-params-shallow-routing`'s client page, which reads its `id` with `use(params)`. */
const SHELL = '/page-params/[id]';
/** `prefetch-fallback-static`'s page, whose `generateStaticParams` gives two of its slugs. */
const PARTIAL = '/static-for-some-params/[slug]';
/** Each route's members, as its shell's pattern matches them, and the keys its route forwards. */
const MEMBERS = {
  [ROUTE]: { pattern: /^\/[^/]+\/nested\/?$/u, query: 'nxtPlang=$nxtPlang' },
  [SUBSET]: { pattern: /^\/[^/]+\/posts\/[^/]+\/?$/u, query: 'nxtPlang=$nxtPlang&nxtPid=$nxtPid' },
  [CATCH_ALL]: {
    pattern: /^\/[^/]+\/posts\/.+$/u,
    query: 'nxtPlang=$nxtPlang&nxtPslug=$nxtPslug',
  },
  [SHELL]: { pattern: /^\/page-params\/[^/]+\/?$/u, query: 'nxtPid=$nxtPid' },
  [PARTIAL]: { pattern: /^\/static-for-some-params\/[^/]+\/?$/u, query: 'nxtPslug=$nxtPslug' },
} as const;
/** What a build wrote of a class beyond this file's generic shell and payload. */
interface Built {
  readonly shell?: Partial<Prerender>;
  readonly payload?: Partial<Prerender>;
  readonly partialPrefetching?: boolean;
}
const STATE = { sha256: 'build-state', byteLength: 5, contentType: 'text/plain; charset=utf-8' };
/** The bundle's blobs by digest: the build's document, its payload and the state beside them. */
const BLOBS: Readonly<Record<string, string>> = {
  'build-html': 'BUILD',
  'build-rsc': 'BUILD-RSC',
  'build-state': 'STATE',
};
/** A payload as Next.js writes one beside a dynamic route's fallback: unclassified, no body. */
const UNBUILT_PAYLOAD = {
  routeType: undefined,
  response: undefined,
  compute: undefined,
  partialFallback: undefined,
  body: undefined,
};
/**
 * The classes Next.js 16.4.2 builds for three of its own fixtures, as its `onBuildComplete` hands
 * them over, sizes aside. `client-params-shallow-routing`: nothing can prerender `id`, and nothing
 * was postponed, so the shell is the last of its class and keeps every route key.
 */
const CLIENT_PARAMS: Built = {
  shell: { routeType: 'shell', response: 'initial', compute: 'static' },
  payload: UNBUILT_PAYLOAD,
};
/** The one entry every member of that shell is answered from: the shell's own. */
const SHELL_ENTRY = { kind: 'app-page', route: SHELL, pathname: SHELL } as const;
/** A generation's lifetime, as its render gave it, and how long before now it was made. */
interface Lifetime {
  readonly policy: CachePolicy;
  readonly age: number;
}
/** Kept for a minute and served stale for an hour, as a shell's `cacheLife` would have it. */
const MINUTE_SHELL = policyFromCacheControl({ revalidate: 60, expire: 3600 });
/** Past its minute: answered, and regenerated behind the answer. */
const STALE: Lifetime = { policy: MINUTE_SHELL, age: 120_000 };
/** Past its hour: regenerated in front of the answer. */
const EXPIRED: Lifetime = { policy: MINUTE_SHELL, age: 7_200_000 };
/** `param-matching-root-params`: `lang`, a root parameter, can still be prerendered; reads postpone. */
const ROOT_PARAMS: Built = {
  shell: { routeType: 'fallback', response: 'initial', compute: 'resuming', postponed: STATE },
  payload: { ...UNBUILT_PAYLOAD, postponed: STATE },
};
/** `prefetch-fallback-static`: a partial fallback, which each member's own entry upgrades. */
const PREFETCH_FALLBACK: Built = {
  shell: { ...ROOT_PARAMS.shell, partialFallback: true },
  payload: { ...UNBUILT_PAYLOAD, postponed: STATE },
  partialPrefetching: true,
};
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
function scenario(
  allowQuery = ['nxtPlang'],
  route: keyof typeof MEMBERS = ROUTE,
  kind = 'app-page',
  built: Built = {},
) {
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
    ...built.shell,
  };
  const payload: Prerender = {
    ...template,
    id: `${route}.rsc`,
    pathname: `${route}.rsc`,
    body: { sha256: 'build-rsc', byteLength: 9, contentType: 'text/x-component' },
    ...built.payload,
  };
  const sourceRegex = `^${route
    .replace('[lang]', '(?<nxtPlang>[^/]+?)')
    .replace('[id]', '(?<nxtPid>[^/]+?)')
    .replace('[...slug]', '(?<nxtPslug>.+?)')
    .replace('[slug]', '(?<nxtPslug>[^/]+?)')}(?:/)?$`;
  const { pattern, query } = MEMBERS[route];
  const dynamic = { sourceRegex, destination: `${route}?${query}` };
  const prerenders = [template, payload];
  const store = {
    manifest: {
      buildId: 'build',
      deploymentId: SCOPE,
      config: {
        basePath: '',
        i18n: null,
        cacheComponents: true,
        partialPrefetching: built.partialPrefetching === true,
      },
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
    readBlob: (sha256: string) => encoder.encode(BLOBS[sha256] ?? ''),
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
    // What a response's end begins can begin more: a partial fallback's upgrade is one.
    while (pending.length > 0) {
      await Promise.all(pending.splice(0));
    }
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
  return { store, runtime, host, ask, context, tables, waitUntil, readRecord };
}

/**
 * A complete runtime generation with both representations, keyed by the pathname it was made for:
 * made a moment ago and kept until an invalidation, unless its `lifetime` says otherwise.
 */
async function remember(
  runtime: CacheRuntime,
  route: string,
  pathname: string,
  {
    text,
    postponed,
    lifetime,
  }: { readonly text: string; readonly postponed?: string; readonly lifetime?: Lifetime },
) {
  const descriptor = { kind: 'app-page' as const, route, pathname };
  const { entryId } = await deriveEntry(SCOPE, descriptor);
  const html = encoder.encode(text);
  const artifactId = `rsc:${pathname}`;
  const madeAt = NOW - (lifetime?.age ?? 1);
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
      cacheTimestamp: madeAt,
      producedAt: madeAt,
      policy: lifetime?.policy ?? policyFromBuild({ initialRevalidate: false }),
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

describe('the classes Next.js 16.4.2 builds for three of its own fixtures', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('DYNAMIC'));
    vi.mocked(regenerate).mockImplementation(() => accepted('RENDERED'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("answers every member of client-params-shallow-routing's shell with the build body", async () => {
    const { ask, readRecord } = scenario(['nxtPid'], SHELL, 'app-page', CLIENT_PARAMS);
    const { entryId } = await deriveEntry(SCOPE, SHELL_ENTRY);

    await expect(ask('/page-params/1')).resolves.toBe('BUILD');
    await expect(ask('/page-params/2')).resolves.toBe('BUILD');
    // The record of the shell both are answered from, which holds no generation yet, and none of
    // a member's own.
    expect(readRecord).toHaveBeenCalledExactlyOnceWith(entryId, expect.any(AbortSignal));
    expect(regenerate).not.toHaveBeenCalled();
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it("renders a payload of that shell's member for the request, regenerating nothing", async () => {
    const { ask, readRecord } = scenario(['nxtPid'], SHELL, 'app-page', CLIENT_PARAMS);
    const { entryId } = await deriveEntry(SCOPE, SHELL_ENTRY);

    // Nothing postponed to resume and no payload of the class's own: the request is rendered as it
    // came, as Next.js renders a navigation's payload of a member it did not build.
    await expect(ask('/page-params/1', { rsc: '1' })).resolves.toBe('DYNAMIC');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(readRecord).toHaveBeenCalledExactlyOnceWith(entryId, expect.any(AbortSignal));
    expect(regenerate).not.toHaveBeenCalled();
  });

  it.each([{}, { rsc: '1' }])(
    "answers that shell's members from its stale generation, regenerated behind, for headers %j",
    async (headers) => {
      const { runtime, ask } = scenario(['nxtPid'], SHELL, 'app-page', CLIENT_PARAMS);
      await remember(runtime, SHELL, SHELL, { text: 'SHELL', lifetime: STALE });
      const prefix = 'rsc' in headers ? 'RSC:' : '';

      await expect(ask('/page-params/1', headers)).resolves.toBe(`${prefix}SHELL`);
      await expect(ask('/page-params/2', headers)).resolves.toBe(`${prefix}SHELL`);
      // Once, for the generation both were answered from, as the shell: `next start` regenerates a
      // stale fallback shell behind its answer, with its open parameters deferred.
      expect(vi.mocked(regenerate).mock.calls.map(([call]) => call.target)).toMatchObject([
        { descriptor: SHELL_ENTRY, isClass: true, reason: 'stale' },
      ]);
    },
  );

  it('keeps that shell on the build path where it varies on a query besides its parameters', async () => {
    const { runtime, ask, readRecord } = scenario(
      ['nxtPid', 'preview'],
      SHELL,
      'app-page',
      CLIENT_PARAMS,
    );
    await remember(runtime, SHELL, SHELL, { text: 'SHELL' });

    // The build's body answered one value of the query, and no one generation stands for them all.
    await expect(ask('/page-params/1')).resolves.toBe('BUILD');
    expect(readRecord).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it.each([{}, { rsc: '1' }])(
    "regenerates that shell in front of a member's answer once it has expired, for headers %j",
    async (headers) => {
      const { runtime, ask } = scenario(['nxtPid'], SHELL, 'app-page', CLIENT_PARAMS);
      await remember(runtime, SHELL, SHELL, { text: 'SHELL', lifetime: EXPIRED });
      const prefix = 'rsc' in headers ? 'RSC:' : '';

      await expect(ask('/page-params/1', headers)).resolves.toBe(`${prefix}RENDERED`);
      expect(vi.mocked(regenerate).mock.calls.map(([call]) => call.target)).toMatchObject([
        { descriptor: SHELL_ENTRY, isClass: true, reason: 'expired' },
      ]);
    },
  );

  it.each([{}, { rsc: '1' }])(
    "renders param-matching-root-params' roots for themselves for headers %j",
    async (headers) => {
      const { runtime, ask } = scenario(['nxtPlang'], ROUTE, 'app-page', ROOT_PARAMS);
      await remember(runtime, ROUTE, '/fr/nested', { text: 'CURRENT-FR' });
      await remember(runtime, ROUTE, '/it/nested', { text: 'OLD-IT' });
      runtime.tags.applyLocal(['/it/nested'], { staleAt: NOW, hardExpireAt: NOW });
      const prefix = 'rsc' in headers ? 'RSC:' : '';

      await expect(ask('/fr/nested', headers)).resolves.toBe(`${prefix}CURRENT-FR`);
      // Neither a root an invalidation expired nor one never asked for is answered with the shell
      // the build rendered before either: each is rendered for its own root.
      await expect(ask('/it/nested', headers)).resolves.toBe(`${prefix}RENDERED`);
      await expect(ask('/nl/nested', headers)).resolves.toBe(`${prefix}RENDERED`);
      expect(
        vi.mocked(regenerate).mock.calls.map(([call]) => call.target.descriptor.pathname),
      ).toStrictEqual(['/it/nested', '/nl/nested']);
    },
  );

  it.each([{}, { rsc: '1' }])(
    "upgrades prefetch-fallback-static's unbuilt member behind its fallback for headers %j",
    async (headers) => {
      const { ask } = scenario(['nxtPslug'], PARTIAL, 'app-page', PREFETCH_FALLBACK);
      const member = '/static-for-some-params/not-prerendered_no-cookies_prefetch-auto';

      // The partial fallback first, resumed for the member, and the member's own entry rendered
      // behind it: what the client's retry of its static request is answered from.
      await expect(ask(member, headers)).resolves.toBe(
        'rsc' in headers ? 'DYNAMIC' : 'BUILDDYNAMIC',
      );
      expect(
        vi.mocked(regenerate).mock.calls.map(([call]) => call.target.descriptor),
      ).toStrictEqual([{ kind: 'app-page', route: PARTIAL, pathname: member }]);
    },
  );

  it('regenerates that shell, never the member, for a foreground regeneration of a member', async () => {
    const { runtime, context, store, tables, waitUntil } = scenario(
      ['nxtPid'],
      SHELL,
      'app-page',
      CLIENT_PARAMS,
    );
    const foreground = context('/page-params/1', { [CACHE_ROUTE_HEADER]: SHELL });

    const answer = await foreground.run(() => {
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

    expect(answer.outcome).toBe('accepted');
    expect(vi.mocked(regenerate).mock.calls.map(([call]) => call.target)).toMatchObject([
      { descriptor: SHELL_ENTRY, isClass: true },
    ]);
  });

  it('revalidates a member as that shell, whose new generation every member is answered from', async () => {
    const { runtime, host, ask, context } = scenario(['nxtPid'], SHELL, 'app-page', CLIENT_PARAMS);
    const invalidate = vi.spyOn(host, 'invalidate').mockResolvedValue({ invalidations: [] });
    // What the host holds once the regeneration is published: a generation of the entry it named.
    vi.mocked(regenerate).mockImplementation(async ({ target }) => {
      const { route, pathname } = target.descriptor;
      await remember(runtime, route, pathname, { text: 'REVALIDATED' });
      return accepted('REVALIDATED');
    });

    const manual = context('/api/revalidate');
    await manual.run(() => platformRevalidate({ urlPath: '/page-params/1' }));

    // As `next start` writes a member's explicit revalidation to the shell's own entry, its open
    // parameters deferred, and not to one of the member's that nothing reads.
    expect(vi.mocked(regenerate).mock.calls.map(([call]) => call.target)).toMatchObject([
      { descriptor: SHELL_ENTRY, isClass: true, reason: 'manual' },
    ]);
    await expect(ask('/page-params/1')).resolves.toBe('REVALIDATED');
    await expect(ask('/page-params/2')).resolves.toBe('REVALIDATED');
    // Once it is published, a member's own entry is invalidated by the member's tag, as under any
    // shell a class shares, and the shell's new generation by nothing.
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tags: [`${IMPLICIT_TAG_PREFIX}/page-params/1`] }),
    );
  });
});
