import type { Prerender } from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  MAX_PACK_BYTES,
  packBodyDigests,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import {
  CACHE_ROUTE_HEADER,
  GENERATION_HEADER,
  RESUME_STATE_LENGTH_HEADER,
} from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import * as regeneration from '../src/cache/regenerate.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { documentFromBuild, rscFromBuild } from '../src/documents.ts';
import { handleForeground, serveFromGeneration } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { servePagesData, serveRouteHandler } from '../src/outputs.ts';
import { handleRuntimeResume } from '../src/runtime-resume.ts';
import { type RoutedInput, staticResponse } from '../src/serve.ts';
import * as stores from '../src/store.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const encoder = new TextEncoder();
const ROUTE = '/items/[id]';
const PATH = '/items/new';
const handler: NodeHandler = () => Promise.resolve();
const source = {
  route: ROUTE,
  pathname: PATH,
  url: PATH,
  representation: 'html' as const,
  onMiss: 'build' as const,
};
const shell: Prerender = {
  id: ROUTE,
  pathname: ROUTE,
  route: ROUTE,
  parentOutputId: ROUTE,
  groupId: 1,
  routeType: 'page',
  body: { sha256: 'build', byteLength: 5, contentType: 'text/html' },
};

function storeFor(prerender: Prerender = shell, kind = 'app-page'): stores.Store {
  return {
    manifest: {
      buildId: 'build-id',
      config: { basePath: '' },
      bypassToken: 'valid-draft-token',
      entrypoints: [{ pathname: ROUTE, kind }],
      routing: { rsc: { prefetchSegmentHeader: 'next-router-segment-prefetch' } },
    },
    prerendersByPathname: new Map([[prerender.pathname, prerender]]),
    shellsByRoute: new Map([
      [ROUTE, { pages: new Map(), patterns: [{ pattern: /^\/items\/.+$/u, prerender }] }],
    ]),
    pathnames: [ROUTE],
    slashSpellings: new Map(),
    readBlob: () => encoder.encode('BUILD'),
  } as unknown as stores.Store;
}

function inputFor(request = new Request(`https://fixture.test${PATH}`)): RoutedInput {
  const cache = createCacheRuntime({
    env: {
      NEXT_DEPLOYMENT_ID: 'scope-test',
      ARKOR_CACHE_GATEWAY_URL: 'https://cache.test',
      ARKOR_CACHE_TOKEN: 'test-token',
    },
    now: Date.now,
    fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })),
  });
  return {
    app: { entries: { [ROUTE]: () => ({ handler }) } },
    edge: { entries: {} },
    request,
    initURL: request.url,
    cache,
    run: (work) => work(),
    waitUntil: () => {
      /* No background tasks in this test. */
    },
  };
}

async function remember(
  input: RoutedInput,
  options: {
    status?: number;
    kind?: 'app-page' | 'app-route' | 'pages';
    headers?: Record<string, string>;
    artifact?: 'rsc' | 'pages-data';
    revalidate?: number | false;
    cacheTimestamp?: number;
  } = {},
) {
  const runtime = input.cache!;
  const descriptor = { kind: options.kind ?? 'app-page', route: ROUTE, pathname: PATH };
  const { entryId } = await deriveEntry(runtime.scopeId, descriptor);
  const html = encoder.encode('CURRENT');
  const cacheTimestamp = options.cacheTimestamp ?? Date.now();
  runtime.recordMemo.set(entryId, {
    header: {
      schemaVersion: 1,
      scopeId: runtime.scopeId,
      entryId,
      generationId: 'generation',
      seq: 1,
      source: 'runtime',
      ...descriptor,
      cacheTimestamp,
      producedAt: cacheTimestamp,
      policy: policyFromBuild({ initialRevalidate: options.revalidate ?? false }),
      status: options.status ?? 200,
      headers: options.headers ?? {},
      tags: [],
      artifacts:
        options.artifact === undefined
          ? []
          : [
              {
                artifactId: 'missing',
                role: options.artifact,
                representationKey: options.artifact,
                sha256: '0'.repeat(64),
                byteLength: 4,
                contentType: 'text/x-component',
                encoding: 'identity',
              },
            ],
      revision: 1,
      ...(await packBodyDigests(html, undefined)),
    },
    html,
    postponed: undefined,
  });
}

function renderedResponse(): Promise<Response> {
  return Promise.resolve(new Response('RENDERED'));
}

describe('runtime generation safeguards', () => {
  beforeEach(() => {
    vi.mocked(invokeNodeHandler).mockReset().mockImplementation(renderedResponse);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('runtime generation response safety', () => {
    it('reads the current Pages data when routing normalized an unbuilt data URL to its page', async () => {
      const store = storeFor({ ...shell, body: undefined, allowQuery: ['nxtPid'] }, 'pages');
      const input = inputFor(
        new Request('https://fixture.test/_next/data/build-id/items/new.json'),
      );
      await remember(input, { kind: 'pages', artifact: 'pages-data' });
      input.cache!.artifactMemo.set('missing', encoder.encode('DATA'));
      const readRecord = vi.spyOn(input.cache!.host, 'readRecord');
      const readArtifact = vi.spyOn(input.cache!.host, 'readArtifact');
      const readBuild = vi.spyOn(store, 'readBlob');

      const response = await servePagesData(input, store, source);

      await expect(response.text()).resolves.toBe('DATA');
      expect(readRecord).not.toHaveBeenCalled();
      expect(readArtifact).not.toHaveBeenCalled();
      expect(readBuild).not.toHaveBeenCalled();
      expect(invokeNodeHandler).not.toHaveBeenCalled();
    });

    it('renders normalized SSR data through its entrypoint with the data URL intact', async () => {
      const store = { ...storeFor(), prerendersByPathname: new Map<string, Prerender>() };
      const input = inputFor(
        new Request('https://fixture.test/_next/data/build-id/items/new.json?q=1'),
      );
      const readRecord = vi.spyOn(input.cache!.host, 'readRecord');

      const response = await servePagesData(input, store, { ...source, url: `${PATH}?q=1` });

      await expect(response.text()).resolves.toBe('RENDERED');
      expect(invokeNodeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/_next/data/build-id/items/new.json?q=1',
        }),
      );
      expect(readRecord).not.toHaveBeenCalled();
    });

    it.each([
      { token: 'valid-draft-token', body: 'RENDERED', renders: 1 },
      { token: 'forged-draft-token', body: 'CURRENT', renders: 0 },
    ])(
      'validates the draft token before bypassing a generation: $token',
      async ({ token, body, renders }) => {
        const store = storeFor({ ...shell, pathname: PATH, routeType: 'route' }, 'app-route');
        const input = inputFor(
          new Request(`https://fixture.test${PATH}`, {
            headers: { cookie: `__prerender_bypass=${token}` },
          }),
        );
        await remember(input, { kind: 'app-route' });

        const response = await serveRouteHandler(input, store, source);

        await expect(response.text()).resolves.toBe(body);
        expect(invokeNodeHandler).toHaveBeenCalledTimes(renders);
      },
    );

    it.each([
      { validity: 'fresh', revalidate: false, reasons: [] },
      { validity: 'stale', revalidate: 0, reasons: ['stale'] },
    ] as const)(
      'serves a $validity concrete route-handler generation with path-param query aliases',
      async ({ revalidate, reasons }) => {
        const store = storeFor(
          { ...shell, pathname: PATH, routeType: 'route', allowQuery: ['nxtPid'] },
          'app-route',
        );
        const background = vi.fn();
        const input = { ...inputFor(), waitUntil: background };
        const pending = Promise.withResolvers<regeneration.RegenerationOutcome>();
        const render = vi.spyOn(regeneration, 'regenerate').mockReturnValue(pending.promise);
        const readRecord = vi.spyOn(input.cache!.host, 'readRecord');
        const readArtifact = vi.spyOn(input.cache!.host, 'readArtifact');
        const readBuild = vi.spyOn(store, 'readBlob');
        const cacheTimestamp = 1_800_000_000_000;
        await remember(input, { kind: 'app-route', revalidate, cacheTimestamp });

        // Time-based staleness starts strictly after its deadline, including revalidate: 0.
        // A stale response must finish while its background regeneration is still pending.
        const response = await withClock(cacheTimestamp + 1, () =>
          serveRouteHandler(input, store, source),
        );

        await expect(response.text()).resolves.toBe('CURRENT');
        expect(render.mock.calls.map(([job]) => job.target.reason)).toStrictEqual(reasons);
        expect(background).toHaveBeenCalledTimes(reasons.length);
        expect(background.mock.calls.flat()).toStrictEqual(reasons.map(() => pending.promise));
        expect(readRecord).not.toHaveBeenCalled();
        expect(readArtifact).not.toHaveBeenCalled();
        expect(readBuild).not.toHaveBeenCalled();
        expect(invokeNodeHandler).not.toHaveBeenCalled();

        pending.resolve({ kind: 'busy' });
      },
    );

    it.each([204, 205, 304])(
      'serves a bodyless %s from build and runtime route outputs',
      async (status) => {
        const store = storeFor({ ...shell, pathname: PATH, routeType: 'route' }, 'app-route');
        const built = staticResponse(store, shell, 'text/plain', status);
        const input = inputFor();
        await remember(input, { status, kind: 'app-route' });
        const response = await serveFromGeneration(
          input,
          store,
          { ...source, representation: 'route-body' },
          handler,
        );

        expect(built.status).toBe(status);
        expect(built.body).toBeNull();
        expect(response?.status).toBe(status);
        expect(response?.body).toBeNull();
      },
    );

    it('preserves safe route headers from the current generation', async () => {
      const input = inputFor();
      await remember(input, {
        kind: 'app-route',
        headers: {
          'content-disposition': 'attachment; filename="data.csv"',
          'access-control-allow-origin': '*',
          'x-app-version': '2',
          'set-cookie': 'private=1',
          'content-length': '2000',
          'x-arkor-private': 'secret',
        },
      });
      const response = await serveFromGeneration(
        input,
        storeFor(shell, 'app-route'),
        { ...source, representation: 'route-body' },
        handler,
      );

      expect(response?.headers.get('content-disposition')).toBe('attachment; filename="data.csv"');
      expect(response?.headers.get('access-control-allow-origin')).toBe('*');
      expect(response?.headers.get('x-app-version')).toBe('2');
      expect(response?.headers.has('set-cookie')).toBe(false);
      expect(response?.headers.has('content-length')).toBe(false);
      expect(response?.headers.has('x-arkor-private')).toBe(false);
    });

    it.each([307, 500])(
      'renders the original request instead of replaying a record-only %s page',
      async (status) => {
        const input = inputFor();
        await remember(input, { status });
        const response = await serveFromGeneration(input, storeFor(), source, handler);

        await expect(response?.text()).resolves.toBe('RENDERED');
        expect(invokeNodeHandler).toHaveBeenCalledWith(expect.objectContaining({ url: PATH }));
      },
    );

    it.each(['rsc', 'segment:/page', 'pages-data'] as const)(
      'renders a missing current %s instead of using the build twin',
      async (representation) => {
        const input = inputFor();
        await remember(input);
        const response = await serveFromGeneration(
          input,
          storeFor(),
          { ...source, representation },
          handler,
        );

        await expect(response?.text()).resolves.toBe('RENDERED');
      },
    );

    it('renders when a current side-artifact fetch fails', async () => {
      const input = inputFor();
      await remember(input, { artifact: 'rsc' });
      vi.spyOn(input.cache!.host, 'readArtifact').mockRejectedValue(new Error('temporary failure'));
      vi.spyOn(input.cache!, 'log').mockImplementation(() => {
        /* Expected artifact-read failure. */
      });
      const response = await serveFromGeneration(
        input,
        storeFor(),
        { ...source, representation: 'rsc' },
        handler,
      );

      await expect(response?.text()).resolves.toBe('RENDERED');
    });
  });

  describe('prerender cache conditions', () => {
    it.each([
      {
        condition: { type: 'cookie' as const, key: 'draft', value: 'yes' },
        headers: { cookie: 'draft=yes' },
        query: '',
      },
      {
        condition: { type: 'header' as const, key: 'x-preview', value: 'yes' },
        headers: { 'x-preview': 'yes' },
        query: '',
      },
      {
        condition: { type: 'header' as const, key: 'user-agent', value: '.*bot.*' },
        headers: { 'user-agent': 'testbot' },
        query: '',
      },
      {
        condition: { type: 'query' as const, key: 'preview', value: 'yes' },
        headers: {},
        query: '?preview=yes',
      },
    ])(
      'honors $condition.type bypass in runtime, document and RSC reads',
      async ({ condition, headers, query }) => {
        const store = storeFor({ ...shell, bypassFor: [condition] });
        const input = inputFor(new Request(`https://fixture.test${PATH}${query}`, { headers }));
        const current = vi.spyOn(input.cache!.host, 'readRecord');
        const resolved = { ...source, url: `${PATH}${query}` };

        await expect(serveFromGeneration(input, store, resolved, handler)).resolves.toBeUndefined();
        expect(current).not.toHaveBeenCalled();
        await expect(
          (
            await documentFromBuild(input, store, resolved, {
              entry: { kind: 'node', handler },
              status: 200,
            })
          ).text(),
        ).resolves.toBe('RENDERED');
        await expect(
          (await rscFromBuild(input, store, { kind: 'node', handler }, resolved)).text(),
        ).resolves.toBe('RENDERED');
      },
    );

    /**
     * A prerender whose answer depends on a query its route does not name answered one query at the
     * build: a request is answered by its handler, never by the build's body.
     */
    it('renders Pages data and route handlers whose output depends on a query', async () => {
      const built = {
        ...shell,
        pathname: PATH,
        routeType: 'route' as const,
        allowQuery: ['page'],
      };
      const input = inputFor(new Request(`https://fixture.test${PATH}?page=2`));

      await expect(
        (
          await serveRouteHandler(input, storeFor(built, 'app-route'), {
            ...source,
            url: `${PATH}?page=2`,
          })
        ).text(),
      ).resolves.toBe('RENDERED');

      const data = {
        ...built,
        pathname: '/_next/data/build-id/items/new.json',
        routeType: 'page' as const,
      };
      const resolved = {
        route: data.pathname,
        pathname: data.pathname,
        url: `${data.pathname}?page=2`,
      };

      await expect(
        (await servePagesData(input, storeFor(data, 'pages'), resolved)).text(),
      ).resolves.toBe('RENDERED');
    });

    it('honors bypass conditions for Pages data and route handlers', async () => {
      const built = {
        ...shell,
        pathname: PATH,
        routeType: 'route' as const,
        bypassFor: [{ type: 'header' as const, key: 'x-preview' }],
      };
      const input = inputFor(
        new Request(`https://fixture.test${PATH}`, { headers: { 'x-preview': '1' } }),
      );

      await expect(
        (await serveRouteHandler(input, storeFor(built, 'app-route'), source)).text(),
      ).resolves.toBe('RENDERED');

      const data = {
        ...built,
        pathname: '/_next/data/build-id/items/new.json',
        routeType: 'page' as const,
      };
      const resolved = { route: data.pathname, pathname: data.pathname, url: data.pathname };

      await expect(
        (await servePagesData(input, storeFor(data, 'pages'), resolved)).text(),
      ).resolves.toBe('RENDERED');
    });

    it.each([['variant'], ['nxtPother'], ['nxtPid', 'variant']])(
      'never creates pathname-only entries for query-dependent fallback routes: %j',
      async (...allowQuery) => {
        const store = storeFor({ ...shell, body: undefined, allowQuery }, 'pages');
        const input = inputFor(new Request(`https://fixture.test${PATH}?variant=red`));
        const read = vi.spyOn(input.cache!.host, 'readRecord');
        const response = await serveFromGeneration(
          input,
          store,
          { ...source, onMiss: 'render' },
          handler,
        );

        expect(response).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
      },
    );

    it.each(['app-page', 'pages'])(
      'regenerates a concrete %s with exact route-param aliases',
      async (kind) => {
        const store = storeFor({ ...shell, body: undefined, allowQuery: ['nxtPid'] }, kind);
        const input = inputFor(
          new Request(`https://fixture.test${PATH}`, {
            headers: { [CACHE_ROUTE_HEADER]: ROUTE },
          }),
        );
        const render = vi.spyOn(regeneration, 'regenerate').mockResolvedValue({ kind: 'busy' });

        await serveFromGeneration(input, store, { ...source, onMiss: 'render' }, handler);
        await handleForeground(input, store);

        expect(render).toHaveBeenCalledTimes(2);

        const target: unknown = expect.objectContaining({
          descriptor: { kind, route: ROUTE, pathname: PATH },
        });

        expect(render).toHaveBeenCalledWith(expect.objectContaining({ target }));
      },
    );

    it('keeps a query-dependent class shell excluded even for matching route-param aliases', async () => {
      const store = storeFor({ ...shell, allowQuery: ['nxtPid'] });
      const input = inputFor();
      const read = vi.spyOn(input.cache!.host, 'readRecord');

      const response = await serveFromGeneration(
        input,
        store,
        { ...source, pathname: ROUTE },
        handler,
      );

      expect(response).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    });

    it('passes dynamic template allowed headers to a miss regeneration', async () => {
      const store = storeFor({ ...shell, body: undefined, allowHeader: ['x-locale'] }, 'pages');
      const input = inputFor();
      const render = vi.spyOn(regeneration, 'regenerate').mockResolvedValue({ kind: 'busy' });
      await serveFromGeneration(input, store, { ...source, onMiss: 'render' }, handler);

      const target: unknown = expect.objectContaining({
        allowHeader: ['x-locale'],
        descriptor: { kind: 'pages', route: ROUTE, pathname: PATH },
      });

      expect(render).toHaveBeenCalledWith(expect.objectContaining({ target }));
    });

    it('passes dynamic template allowed headers to a manual regeneration', async () => {
      const store = storeFor({ ...shell, body: undefined, allowHeader: ['x-locale'] }, 'pages');
      const input = inputFor();
      const render = vi.spyOn(regeneration, 'regenerate').mockResolvedValue({ kind: 'busy' });
      vi.spyOn(stores, 'getStore').mockReturnValue(store);
      const context = {
        tables: input,
        runtime: input.cache,
        request: input.request,
        startedAt: Date.now(),
        fetchStarts: new Map<string, number>(),
        waitUntil: input.waitUntil,
        run: input.run,
        invalidated: new InvalidatedTags(),
        writes: new RequestWrites(),
      };

      await expect(
        withRequestContext(context, () => platformRevalidate({ urlPath: PATH })),
      ).rejects.toThrow('busy');

      const target: unknown = expect.objectContaining({
        allowHeader: ['x-locale'],
        descriptor: { kind: 'pages', route: ROUTE, pathname: PATH },
      });

      expect(render).toHaveBeenCalledWith(expect.objectContaining({ target }));
    });
  });

  /**
   * The edge asks for a first render where it found no record, naming no generation, and for a
   * regeneration of the one it found expired otherwise: the first's answer waits for its publish, so
   * that a request made once it was read reads that generation; the other's does not.
   */
  describe('a foreground regeneration the edge asks for', () => {
    const rendered = {
      html: encoder.encode('<html>first</html>'),
      postponed: undefined,
      rscData: undefined,
      segments: new Map<string, Uint8Array>(),
      headers: {},
      status: 200,
      cacheControl: { revalidate: 60, expire: 3600 },
      data: undefined,
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      { said: 'no generation, a first render', named: {}, held: true },
      {
        said: 'the generation it found expired',
        named: { [GENERATION_HEADER]: 'generation-1' },
        held: false,
      },
    ])('holds its answer for the publish where the request names $said', async (example) => {
      const store = storeFor({ ...shell, body: undefined });
      const input = inputFor(
        new Request(`https://fixture.test${PATH}`, {
          headers: { [CACHE_ROUTE_HEADER]: ROUTE, ...example.named },
        }),
      );
      const publish = Promise.withResolvers<{ readonly kind: 'published'; generationId: string }>();
      vi.spyOn(regeneration, 'regenerate').mockResolvedValue({
        kind: 'accepted',
        render: rendered,
        published: publish.promise,
      });
      const context = {
        tables: input,
        runtime: input.cache,
        request: input.request,
        startedAt: Date.now(),
        fetchStarts: new Map<string, number>(),
        waitUntil: input.waitUntil,
        run: input.run,
        invalidated: new InvalidatedTags(),
        writes: new RequestWrites(),
      };

      const answer = await withRequestContext(context, () => handleForeground(input, store));
      const pending = context.writes.pending;
      publish.resolve({ kind: 'published', generationId: 'generation-2' });

      expect(answer.outcome).toBe('accepted');
      expect(pending).toBe(example.held);
    });
  });

  describe('runtime resume-state transport', () => {
    it.each([null, '0', '-1', String(MAX_PACK_BYTES + 1)])(
      'rejects an absent, empty or oversized declared length: %s',
      async (length) => {
        const headers = new Headers({ [CACHE_ROUTE_HEADER]: ROUTE });
        const lengths = length === null ? [] : [length];
        for (const value of lengths) {
          headers.set(RESUME_STATE_LENGTH_HEADER, value);
        }
        const response = await handleRuntimeResume(
          inputFor(new Request(`https://fixture.test${PATH}`, { method: 'POST', headers })),
          storeFor(),
        );

        expect(response.status).toBe(400);
        expect(invokeNodeHandler).not.toHaveBeenCalled();
      },
    );

    it('accepts a state larger than Next.js request-body default when it fits a published pack', async () => {
      const body = 's'.repeat(9 * 1024 * 1024);
      const request = new Request(`https://fixture.test${PATH}`, {
        method: 'POST',
        headers: { [CACHE_ROUTE_HEADER]: ROUTE, [RESUME_STATE_LENGTH_HEADER]: String(body.length) },
        body,
      });
      const response = await handleRuntimeResume(inputFor(request), storeFor());

      expect(response.status).toBe(200);
      expect(vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta['postponed']).toHaveLength(
        body.length,
      );
    });

    it('cancels a dishonest stream as soon as it exceeds its declared length', async () => {
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('too long'));
        },
        cancel: cancelled,
      });
      const init = {
        method: 'POST',
        headers: { [CACHE_ROUTE_HEADER]: ROUTE, [RESUME_STATE_LENGTH_HEADER]: '1' },
        body,
        duplex: 'half' as const,
      };
      const response = await handleRuntimeResume(
        inputFor(new Request(`https://fixture.test${PATH}`, init)),
        storeFor(),
      );

      expect(response.status).toBe(400);
      expect(cancelled).toHaveBeenCalledExactlyOnceWith(undefined);
    });
  });
});
