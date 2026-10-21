import {
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  CAPTURE_CONTENT_TYPE,
  CAPTURE_HEADER,
  type CaptureAnswer,
  FUNCTION_HEADER,
  MISDIRECTED_STATUS,
  pathHeaders,
  RESUME_PRERENDER_ESCAPED_HEADER,
  RESUME_PRERENDER_HEADER,
} from '@stayingupwind/core/paas';
import { toBase64, TtlCache } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_CAPTURED_BYTES } from '../src/cache/capture.ts';
import { requestContextFor } from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import type { CacheHost } from '../src/cache/host.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';
import entry from '../src/function.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler, type InvokeInput } from '../src/node-bridge.ts';
import type { VercelRequestContext } from '../src/request-context.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * A capture (`CAPTURE_HEADER`): the page a request names, rendered as a regeneration renders it,
 * and answered with what the render made rather than with the page — with nothing of it kept. The
 * router and the runtime run for real; Next.js is the bridge, replaced by what each test says it
 * renders, and the cache's host is one that records every call that would write.
 */

/** A page and a route handler of the deployment, and the entrypoints that render them: nothing. */
const { BOARD, FEED, tables } = vi.hoisted(() => {
  const board = '/board';
  const feed = '/api/feed';
  const rendersNothing = { handler: (): Promise<void> => Promise.resolve() };
  return {
    BOARD: board,
    FEED: feed,
    tables: {
      app: { entries: { [board]: () => rendersNothing, [feed]: () => rendersNothing } },
      edge: { entries: {} },
    },
  };
});

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: vi.fn(),
    // What the Function entry asks of a request before it answers: whether it may change anything.
    changesSomething: (method: string) => method !== 'GET' && method !== 'HEAD',
  };
});
// What the Function entry is bundled beside, which a suite of it does without: the environment it
// installs before Next.js is evaluated, the modules the adapter generates, and a cache host — none,
// and no reader of the bundle's blobs, which leaves a Function that runs as one given neither.
vi.mock(import('../src/environment.ts'), () => ({}));
vi.mock(import('../src/cache/install.ts'), () => ({}));
vi.mock(import('arkor:wasm'), () => ({}));
vi.mock(import('arkor:app'), () => ({ default: tables.app }));
vi.mock(import('arkor:edge'), () => ({ default: tables.edge }));
vi.mock(import('arkor:cache-host'), () => {
  const none = vi.fn();
  return { createCacheHost: none, createBundleBlobReader: none };
});

const NOW = 1_800_000_000_000;
const HOLD_MS = 5000;
const ENTRIES = 64;
const SCOPE = 'capture';
const ORIGIN = 'https://app.test';
/** A page another of the deployment's Functions holds. */
const ELSEWHERE = '/elsewhere';
const DOCUMENT = '<!DOCTYPE html><html><body><main>board</main></body></html>';
const STATE = '{"opaque":"the state that resumes the board"}';
const SEGMENT = '/_tree';
const TAG = 'todos';
const NOT_STORED = 'private, no-store';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
/** The visitor's own headers, which the edge forwards with a capture as with any request. */
const VISITOR: Readonly<Record<string, string>> = {
  host: 'app.test',
  cookie: 'session=alice',
  'x-visitor': 'alice',
};
/** The calls of a host that write something: none of them is a capture's to make. */
const WRITES = [
  'startAttempt',
  'uploadArtifact',
  'uploadArtifacts',
  'heartbeat',
  'commit',
  'fail',
  'setData',
  'invalidate',
] as const;

/** What the requests of a test handed to `waitUntil`. */
const pending: Promise<unknown>[] = [];

function frozen(): number {
  return NOW;
}

/** Everything handed to `waitUntil`, settled — and whatever that handed over in turn. */
async function drain(): Promise<void> {
  while (pending.length > 0) {
    await Promise.allSettled(pending.splice(0));
  }
}

function keep(work: Promise<unknown>): void {
  pending.push(work);
}

/** A deployment of a page, a route handler, and a page another of its Functions holds. */
function deployment(): Store {
  return {
    manifest: {
      buildId: 'build',
      deploymentId: SCOPE,
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [
        { id: BOARD, kind: 'app-page', pathname: BOARD },
        { id: FEED, kind: 'app-route', pathname: FEED },
        { id: ELSEWHERE, kind: 'app-page', pathname: ELSEWHERE, function: 'app-2' },
      ],
      prerenders: [],
    },
    pathnames: [BOARD, FEED, ELSEWHERE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    renderedPages: new Set(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

function refusing(what: string): () => Promise<never> {
  return () => Promise.reject(new Error(`a capture ${what}`));
}

/**
 * A host whose reads find nothing, and whose writes — answered as a host answers them, for a render
 * that is no capture's — are each recorded.
 */
function cache() {
  const host = {
    startAttempt: vi.fn<CacheHost['startAttempt']>(refusing('takes no lease')),
    uploadArtifact: vi.fn<CacheHost['uploadArtifact']>(refusing('uploads nothing')),
    uploadArtifacts: vi.fn<NonNullable<CacheHost['uploadArtifacts']>>(refusing('uploads nothing')),
    heartbeat: vi.fn<CacheHost['heartbeat']>(refusing('holds no lease')),
    commit: vi.fn<CacheHost['commit']>(refusing('commits nothing')),
    fail: vi.fn<CacheHost['fail']>(refusing('ends no attempt')),
    readRecord: vi.fn<CacheHost['readRecord']>(() => Promise.resolve(undefined)),
    readArtifact: vi.fn<CacheHost['readArtifact']>(() => Promise.resolve(undefined)),
    getData: vi.fn<CacheHost['getData']>(() => Promise.resolve(undefined)),
    setData: vi.fn<CacheHost['setData']>(() =>
      Promise.resolve({ entryId: 'entry', generationId: 'generation', revision: 1 }),
    ),
    getTags: vi.fn<CacheHost['getTags']>(() => Promise.resolve({ tags: [] })),
    tagsDelta: vi.fn<CacheHost['tagsDelta']>(() =>
      Promise.resolve({ revision: 0, truncated: false, tags: [] }),
    ),
    invalidate: vi.fn<CacheHost['invalidate']>(() =>
      Promise.resolve({ invalidations: [], revision: 1 }),
    ),
  } satisfies CacheHost;
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
  return {
    host,
    runtime,
    /** The host's calls that would have written something, by name. */
    written: () => WRITES.filter((name) => host[name].mock.calls.length > 0),
    /** What the isolate keeps of entries and values: renders, records, artifacts, writes. */
    kept: () => {
      return {
        publishing: runtime.publishing.size,
        regenerations: runtime.regenerationMemo.size,
        records: runtime.recordMemo.size,
        artifacts: runtime.artifactMemo.size,
        values: runtime.dataWrites.size,
      };
    },
  };
}

/** The headers the edge sends a capture of `route` with, beside `visitor`'s own. */
function captureOf(route: string, visitor: Readonly<Record<string, string>> = {}) {
  return {
    ...visitor,
    [CAPTURE_HEADER]: '1',
    ...pathHeaders(CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER, route),
  };
}

/** The deployment's Function asked `path`, with the cache `runtime` it was given. */
function handle(runtime: CacheRuntime, path: string, init?: RequestInit): Promise<Response> {
  return handleRequest({
    ...tables,
    request: new Request(`${ORIGIN}${path}`, init),
    cache: runtime,
    waitUntil: keep,
    clock: NOW,
  });
}

/** What each render of a test was handed, in the order they were made. */
function invoked(): InvokeInput[] {
  return vi.mocked(invokeNodeHandler).mock.calls.map(([input]) => input);
}

/** What a static render of the page made, as Next.js hands it over: a whole page by default. */
interface Made {
  readonly postponed?: string;
  readonly rscData?: Uint8Array;
  readonly segmentData?: ReadonlyMap<string, Uint8Array>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly cacheControl?: { readonly revalidate: number | false; readonly expire?: number };
}

type CacheCallback = (entry: unknown, meta: { url: string | undefined }) => Promise<boolean>;

/**
 * Next.js rendering the page statically and handing its cache entry to the platform
 * (`onCacheEntry`), as it does for an App Router page whose lifetime lets it be kept: it answers
 * nothing itself, and the bridge ends the response it never wrote.
 */
async function handOver(input: InvokeInput, made: Made = {}): Promise<Response> {
  const callback = input.requestMeta['onCacheEntryV2'] as CacheCallback | undefined;
  if (callback === undefined) {
    throw new Error('the render was handed no callback to hand its entry to');
  }
  await callback(
    {
      value: {
        kind: 'APP_PAGE',
        html: { toUnchunkedString: () => DOCUMENT },
        rscData: made.rscData,
        postponed: made.postponed,
        segmentData: made.segmentData,
        headers: made.headers ?? { 'content-type': 'text/html; charset=utf-8' },
        status: made.status ?? 200,
      },
      cacheControl: made.cacheControl ?? { revalidate: 60, expire: 3600 },
    },
    { url: input.url },
  );
  return new Response(null, { status: 204 });
}

/**
 * What a render asks of the cache's handlers when it fetched a value, made a `use cache` value
 * whose stream is `value`, and invalidated a tag behind its answer, as Next.js asks them.
 */
async function writeThroughHandlers(value: ReadableStream<Uint8Array>): Promise<void> {
  const fetchCache = new PlatformFetchCache();
  await fetchCache.set(
    'fetched',
    { kind: 'FETCH', data: { body: 'fetched' }, revalidate: 60 },
    { fetchCache: true, tags: [TAG] },
  );
  await useCacheHandler('default').set(
    'cached',
    Promise.resolve({ value, tags: [TAG], stale: 0, timestamp: NOW, expire: 3600, revalidate: 60 }),
  );
  await fetchCache.revalidateTag(TAG);
}

/** A render that writes through the cache's handlers as it runs, its `use cache` value `value`. */
function writingThroughHandlers(
  value: ReadableStream<Uint8Array>,
): (input: InvokeInput) => Promise<Response> {
  return async (input) => {
    await input.run?.(() => writeThroughHandlers(value));
    return handOver(input);
  };
}

/** The request context libraries read off the global, read as they read it. */
function requestContextNow(): VercelRequestContext | undefined {
  const holder = Reflect.get(globalThis, REQUEST_CONTEXT) as
    | { readonly get: () => VercelRequestContext | undefined }
    | undefined;
  return holder?.get();
}

/** The request context as the bridge is handed the render, and as the render runs. */
interface Seen {
  atBridge?: VercelRequestContext | undefined;
  inRender?: VercelRequestContext | undefined;
}

/** A render that notes the request context where it is handed over, and as it runs. */
function notingContext(seen: Seen): (input: InvokeInput) => Promise<Response> {
  return async (input) => {
    seen.atBridge = requestContextNow();
    await input.run?.(() => {
      seen.inRender = requestContextNow();
      return Promise.resolve();
    });
    return handOver(input);
  };
}

describe('a capture', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(async () => {
    await drain();
    configureCacheHandlers(undefined);
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('answers what a static render of the page made, as JSON nothing in front of it keeps', async () => {
    const test = cache();
    const rsc = new Uint8Array([0, 255, 10, 35]);
    const segment = new Uint8Array([1, 2, 3, 250]);
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      return handOver(input, {
        postponed: STATE,
        rscData: rsc,
        segmentData: new Map([[SEGMENT, segment]]),
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'X-Frame-Options': 'DENY',
          'set-cookie': 'session=nobody',
          'x-nextjs-stale-time': '300',
        },
      });
    });

    const response = await handle(test.runtime, BOARD, { headers: captureOf(BOARD, VISITOR) });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(CAPTURE_CONTENT_TYPE);
    expect(response.headers.get('cache-control')).toBe(NOT_STORED);
    await expect(response.json()).resolves.toStrictEqual({
      v: 1,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' },
      html: DOCUMENT,
      postponed: STATE,
      rsc: toBase64(rsc),
      segments: [[SEGMENT, toBase64(segment)]],
      cacheControl: { revalidate: 60, expire: 3600 },
    } satisfies CaptureAnswer);
  });

  it('says what a render without a resume, a payload or a lifetime leaves out', async () => {
    const test = cache();
    vi.mocked(invokeNodeHandler).mockImplementation((input) =>
      handOver(input, { cacheControl: { revalidate: false } }),
    );

    const response = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });

    await expect(response.json()).resolves.toMatchObject({
      postponed: null,
      rsc: null,
      segments: [],
      cacheControl: { revalidate: false, expire: null },
    });
  });

  it('renders the page as a regeneration renders it, handed nothing of the visitor', async () => {
    const test = cache();
    vi.mocked(invokeNodeHandler).mockImplementation((input) => handOver(input));

    await handle(test.runtime, `${BOARD}?tab=open`, { headers: captureOf(BOARD, VISITOR) });
    await handle(test.runtime, BOARD, { headers: captureOf(BOARD, VISITOR) });
    const [first, second] = invoked();
    const { 'x-invocation-id': invocation, ...given } = Object.fromEntries(first!.request.headers);

    expect(first?.url).toBe(BOARD);
    expect(first?.request.url).toBe(`${ORIGIN}${BOARD}`);
    expect(given).toStrictEqual({
      accept: 'text/html,application/xhtml+xml',
      host: 'app.test',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
    });
    expect(first?.requestMeta).toMatchObject({ minimalMode: true, initURL: `${ORIGIN}${BOARD}` });
    expect(first?.expectNoResponse).toBe(true);
    // An invocation of its own each, which Next.js scopes its response cache to.
    expect(invocation).toMatch(/^capture-/u);
    expect(second?.request.headers.get('x-invocation-id')).not.toBe(invocation);
  });

  it('keeps nothing: no lease, no upload, no record, no value, no invalidation', async () => {
    const test = cache();
    configureCacheHandlers(test.runtime);
    const value = { released: false };
    const made = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('cached'));
        controller.close();
      },
      cancel: () => {
        value.released = true;
      },
    });
    vi.mocked(invokeNodeHandler).mockImplementation(writingThroughHandlers(made));

    const response = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });
    await drain();

    expect(response.status).toBe(200);
    expect(test.written()).toStrictEqual([]);
    expect(test.host.readRecord).not.toHaveBeenCalled();
    expect(test.kept()).toStrictEqual({
      publishing: 0,
      regenerations: 0,
      records: 0,
      artifacts: 0,
      values: 0,
    });
    // The `use cache` value is let go of, rather than read and held for nobody.
    expect(value.released).toBe(true);
  });

  it('is what keeps a render from writing what a render of a request writes', async () => {
    const test = cache();
    configureCacheHandlers(test.runtime);
    const context = requestContextFor({
      tables,
      runtime: test.runtime,
      request: new Request(`${ORIGIN}${BOARD}`),
      startedAt: NOW,
      waitUntil: keep,
      clock: NOW,
    });

    await context.run(() => writeThroughHandlers(new Blob(['cached']).stream()));
    await drain();

    expect(test.written()).toStrictEqual(['setData', 'invalidate']);
  });

  it.each([
    {
      what: 'is not a GET',
      path: BOARD,
      init: { method: 'POST', headers: captureOf(BOARD), body: 'state' },
      reason: /a capture is a GET/u,
    },
    {
      what: 'names no route',
      path: BOARD,
      init: { headers: { [CAPTURE_HEADER]: '1' } },
      reason: /names its route/u,
    },
    {
      what: 'names a route handler',
      path: FEED,
      init: { headers: captureOf(FEED) },
      reason: /no App Router page entry renders \/api\/feed/u,
    },
    {
      what: 'names a route the deployment does not have',
      path: '/missing',
      init: { headers: captureOf('/missing') },
      reason: /no App Router page entry renders \/missing/u,
    },
  ])(
    'is refused, with nothing rendered, where the request $what',
    async ({ path, init, reason }) => {
      const test = cache();

      const response = await handle(test.runtime, path, init);

      expect(response.status).toBe(422);
      expect(response.headers.get('content-type')).toBe(TEXT_TYPE);
      await expect(response.text()).resolves.toMatch(reason);
      expect(invokeNodeHandler).not.toHaveBeenCalled();
      expect(test.written()).toStrictEqual([]);
    },
  );

  it.each([
    {
      what: 'Next.js answered the render itself, as it answers a page dynamic here',
      render: () => Promise.resolve(new Response('live')),
      reason: /rendered dynamically/u,
    },
    {
      what: 'the render failed',
      render: () => Promise.resolve(new Response('failed', { status: 500 })),
      reason: /answered 500/u,
    },
    {
      what: 'the render handed over a not-found',
      render: (input: InvokeInput) => handOver(input, { status: 404 }),
      reason: /answered 404/u,
    },
    {
      what: 'the render handed over a redirect',
      render: (input: InvokeInput) =>
        handOver(input, { status: 307, headers: { location: '/elsewhere' } }),
      reason: /answered 307/u,
    },
  ])('is refused where $what, and keeps none of it', async ({ render, reason }) => {
    const test = cache();
    vi.mocked(invokeNodeHandler).mockImplementation(render);

    const response = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });

    expect(response.status).toBe(422);
    await expect(response.text()).resolves.toMatch(reason);
    expect(test.written()).toStrictEqual([]);
  });

  it('is refused as too large where the render comes to more than a capture carries', async () => {
    const test = cache();
    const html = new TextEncoder().encode(DOCUMENT).byteLength;
    vi.mocked(invokeNodeHandler)
      .mockImplementationOnce((input) =>
        handOver(input, { rscData: new Uint8Array(MAX_CAPTURED_BYTES - html) }),
      )
      .mockImplementationOnce((input) =>
        handOver(input, { rscData: new Uint8Array(MAX_CAPTURED_BYTES - html + 1) }),
      );

    const whole = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });
    const over = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });
    await whole.body?.cancel();

    expect(whole.status).toBe(200);
    expect(over.status).toBe(413);
    await expect(over.text()).resolves.toMatch(/larger than/u);
    expect(test.written()).toStrictEqual([]);
  });

  it('is answered as another Function’s where it names a route that Function holds', async () => {
    const test = cache();

    const response = await handle(test.runtime, ELSEWHERE, { headers: captureOf(ELSEWHERE) });

    expect(response.status).toBe(MISDIRECTED_STATUS);
    expect(response.headers.get(FUNCTION_HEADER)).toBe('app-2');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('is answered here where it names a route here, whatever resume it carries beside', async () => {
    const test = cache();
    const store = deployment();
    vi.mocked(getStore).mockReturnValue({
      ...store,
      prerendersById: new Map([['elsewhere', { route: ELSEWHERE }]]),
    } as unknown as Store);
    vi.mocked(invokeNodeHandler).mockImplementationOnce((input) => handOver(input));

    const response = await handle(test.runtime, BOARD, {
      headers: {
        ...captureOf(BOARD),
        ...pathHeaders(RESUME_PRERENDER_HEADER, RESUME_PRERENDER_ESCAPED_HEADER, 'elsewhere'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.has(FUNCTION_HEADER)).toBe(false);
    expect(invoked()).toHaveLength(1);
  });

  it('is refused, rendering nothing, where its prerender varies on a query its path does not name', async () => {
    const test = cache();
    const store = deployment();
    vi.mocked(getStore).mockReturnValue({
      ...store,
      prerendersByPathname: new Map([[BOARD, { allowQuery: ['tab'] }]]),
    } as unknown as Store);

    const response = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });

    expect(response.status).toBe(422);
    expect(response.headers.get('cache-control')).toBe(NOT_STORED);
    await expect(response.text()).resolves.toMatch(/rendered for each request/u);
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('is refused 503, rendering nothing, where the tags cannot be brought up', async () => {
    const test = cache();

    test.host.tagsDelta.mockRejectedValue(new Error('the host is gone'));

    const response = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe(NOT_STORED);
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('brings the tags up before it renders, whatever the hold says', async () => {
    const test = cache();

    await test.runtime.tags.sync(test.host, NOW);

    test.host.tagsDelta.mockClear();

    vi.mocked(invokeNodeHandler).mockImplementationOnce((input) => handOver(input));

    const response = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });
    await response.body?.cancel();

    expect(response.status).toBe(200);
    // Past the revision the view stood at: the pull the hold would have spared it.
    expect(test.host.tagsDelta).toHaveBeenCalledWith(test.runtime.tags.revision);
  });

  it('is answered 500, kept by nobody, where its render fails as nothing expects', async () => {
    const test = cache();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // The Function's own log, which the test reads rather than prints.
    });
    vi.mocked(invokeNodeHandler).mockRejectedValueOnce(new Error('the page threw'));

    const response = await handle(test.runtime, BOARD, { headers: captureOf(BOARD) });

    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe(NOT_STORED);
    await expect(response.text()).resolves.toBe('the capture failed');
    expect(logged).toHaveBeenCalledWith('next-runtime: capture failed', expect.any(Error));
    expect(test.written()).toStrictEqual([]);
  });

  it.each([
    { what: 'without the header', headers: VISITOR },
    { what: 'whose header asks for nothing', headers: { ...VISITOR, [CAPTURE_HEADER]: '0' } },
  ])('leaves a request $what to the usual path', async ({ headers }) => {
    const test = cache();
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('the page, for the visitor'));

    const response = await handle(test.runtime, BOARD, { headers });
    const [rendered] = invoked();

    await expect(response.text()).resolves.toBe('the page, for the visitor');
    expect(rendered?.request.headers.get('cookie')).toBe('session=alice');
    expect(rendered?.request.headers.has(CAPTURE_HEADER)).toBe(false);
    expect(rendered?.requestMeta).not.toHaveProperty('onCacheEntryV2');
    expect(test.written()).toStrictEqual([]);
  });
});

describe('the Function entry, asked for a capture', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.stubGlobal('__ARKOR_FUNCTION_NAME__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(async () => {
    await drain();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('renders it within the request context it sets up, which holds the headers that came', async () => {
    const seen: Seen = {};
    vi.mocked(invokeNodeHandler).mockImplementation(notingContext(seen));
    const request = new Request(`${ORIGIN}${BOARD}`, { headers: captureOf(BOARD, VISITOR) });

    const response = await entry.fetch(request, {}, { waitUntil: keep });
    const [rendered] = invoked();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(CAPTURE_CONTENT_TYPE);
    expect(seen.atBridge?.headers).toMatchObject({
      cookie: 'session=alice',
      'x-visitor': 'alice',
      [CAPTURE_HEADER]: '1',
    });
    expect(seen.atBridge?.url).toBe(`${ORIGIN}${BOARD}`);
    expect(seen.inRender).toStrictEqual(seen.atBridge);
    // What Next.js itself is handed carries none of them.
    expect(rendered?.request.headers.has('cookie')).toBe(false);
    expect(rendered?.request.headers.has('x-visitor')).toBe(false);
  });
});
