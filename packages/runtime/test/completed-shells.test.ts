import type { Prerender } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { handleRequest } from '../src/handle.ts';
import { type InvokeInput, invokeNodeHandler } from '../src/node-bridge.ts';
import { rscRepresentation } from '../src/representations.ts';
import { completedShell, getStore, type Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

/**
 * A member of a route that blocks, whose entries Next.js 16.4 keys by some of the route's
 * parameters: the root parameters `lang` and `region`, and not `id`, which `generateStaticParams`
 * never provides (`buildCompletedShellCacheKey`). The member is kept under the shell those complete
 * to, `/de/fr/posts/[id]`, rendered from that pathname with `id` left a placeholder, and every
 * member that shares them is answered from it, resumed for its own `id`. A prefetch made before
 * anything is kept is answered from the class's own output, which holds up its root layout, and the
 * shell is made behind it, as a deployment of Next.js makes it
 * (`app-dir/segment-cache/app-shell-root-params`).
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_completedShellsTest000';
const HOST = 'https://app.test';
const T0 = 1_800_000_000_000;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const POSTS = '/[lang]/[region]/posts/[id]';
const COMPLETED = '/de/fr/posts/[id]';
const SEGMENT = '/$d$lang/$d$region/posts/$d$id/__PAGE__';
const RSC = {
  header: 'rsc',
  varyHeader: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
  prefetchHeader: 'next-router-prefetch',
  prefetchSegmentHeader: 'next-router-segment-prefetch',
  prefetchSegmentSuffix: '.segment.rsc',
  prefetchSegmentDirSuffix: '.segments',
};
const SHELL = '<html lang="de"><body>Shell lang: de';
const RESUMED = '<p>the post</p></body></html>';
const BUILT_SEGMENT = '0:{"segment":"the class, its root layout held up"}';
const SHELL_SEGMENT = '0:{"segment":"Shell lang: de"}';
const encoder = new TextEncoder();
const blobs = new Map([
  ['segment', encoder.encode(BUILT_SEGMENT)],
  ['tree', encoder.encode('0:{"tree":"built"}')],
]);
const page: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [POSTS]: () => ({ handler: page }) } };

function prerender(pathname: string, fields: Partial<Prerender> = {}): Prerender {
  return { id: pathname, pathname, route: POSTS, parentOutputId: POSTS, groupId: 5, ...fields };
}

/** The route's own entry, as Next.js 16.4 writes a class whose root parameters it cannot resolve. */
function templateOf(allowQuery: readonly string[]): Prerender {
  return prerender(POSTS, {
    routeType: 'page',
    response: 'empty',
    compute: 'blocking',
    renderingMode: 'PARTIALLY_STATIC',
    allowQuery: [...allowQuery],
  });
}

function segment(segmentPath: string, sha256: string): Prerender {
  return prerender(`${POSTS}.segments${segmentPath}.segment.rsc`, {
    segmentPath,
    body: { sha256, byteLength: 1, contentType: 'text/x-component' },
  });
}

/** The route, its own entry keyed by `allowQuery`, and the segments the build wrote of it. */
function deployment(allowQuery: readonly string[] = ['nxtPlang', 'nxtPregion']): Store {
  const template = templateOf(allowQuery);
  const prerenders = [template, segment('/_tree', 'tree'), segment(SEGMENT, 'segment')];
  const route = {
    sourceRegex: '^/(?<nxtPlang>[^/]+?)/(?<nxtPregion>[^/]+?)/posts/(?<nxtPid>[^/]+?)(?:/)?$',
    destination: `${POSTS}?nxtPlang=$nxtPlang&nxtPregion=$nxtPregion&nxtPid=$nxtPid`,
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
      entrypoints: [{ id: POSTS, kind: 'app-page', pathname: POSTS }],
    },
    pathnames: [POSTS],
    slashSpellings: new Map(),
    dynamicRoutes: [route],
    staticFiles: new Map(),
    shellsByRoute: new Map([
      [
        POSTS,
        {
          pages: new Map(),
          patterns: [{ pattern: /^\/[^/]+\/[^/]+\/posts\/[^/]+$/u, prerender: template }],
        },
      ],
    ]),
    prerendersById: new Map(prerenders.map((each) => [each.id, each])),
    prerendersByPathname: new Map(prerenders.map((each) => [each.pathname, each])),
    renderedPages: new Set(),
    readBlob: (sha256: string) => blobs.get(sha256),
    tryReadBlob: (sha256: string) => blobs.get(sha256),
  } as unknown as Store;
}

type CacheEntryCallback = (entry: unknown, meta: { url: string | undefined }) => unknown;

/**
 * Next.js in minimal mode: a static render captured where one is asked for — the shell, with what
 * is left of the page postponed — its resume where it is handed the state, and nothing else.
 */
async function rendering(call: InvokeInput): Promise<Response> {
  const meta = call.requestMeta;
  const onCacheEntry = meta['onCacheEntry'] as CacheEntryCallback | undefined;
  if (onCacheEntry !== undefined) {
    await onCacheEntry(
      {
        value: {
          kind: 'APP_PAGE',
          html: { toUnchunkedString: () => SHELL },
          rscData: encoder.encode('0:["the shell"]'),
          headers: { 'content-type': 'text/html' },
          status: 200,
          postponed: 'the post, held up',
          segmentData: new Map([
            ['/_tree', encoder.encode('0:{"tree":"rendered"}')],
            [SEGMENT, encoder.encode(SHELL_SEGMENT)],
          ]),
        },
        cacheControl: { revalidate: 60, expire: 3600 },
      },
      { url: call.url },
    );
    return new Response(null);
  }
  if (meta['postponed'] === 'the post, held up') {
    return new Response(RESUMED);
  }
  return new Response('rendered whole');
}

/** The pathnames the page was rendered from to be kept: what each regeneration rendered. */
function kept(): (string | undefined)[] {
  return vi
    .mocked(invokeNodeHandler)
    .mock.calls.filter(([call]) => call.requestMeta['onCacheEntry'] !== undefined)
    .map(([call]) => call.url);
}

function leases(authority: FakeAuthority): number {
  return authority.calls.filter((call) => call === 'POST /attempts').length;
}

/** Every piece of work handed to the runtime settled, and whatever that work handed on in turn. */
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

/** The answer to `path`, read to its end, and the work it left behind settled. */
async function ask(
  { runtime }: Cache,
  path: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const pending: Promise<unknown>[] = [];
  const response = await handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`${HOST}${path}`, { headers }),
    waitUntil: (promise) => {
      pending.push(promise);
    },
    cache: runtime,
    clock: T0,
  });
  const body = await response.text();
  await settle(pending);
  return body;
}

/** A server action posted to `path`, read to its end, the work it left behind settled. */
async function act({ runtime }: Cache, path: string): Promise<string> {
  const pending: Promise<unknown>[] = [];
  const response = await handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`${HOST}${path}`, {
      method: 'POST',
      headers: { 'next-action': 'an-action', 'content-type': 'text/plain;charset=UTF-8' },
      body: '[]',
    }),
    waitUntil: (promise) => {
      pending.push(promise);
    },
    cache: runtime,
    clock: T0,
  });
  const body = await response.text();
  await settle(pending);
  return body;
}

/** `res.revalidate(path)`, called from a request this runtime answers. */
function revalidate({ runtime }: Cache, path: string): Promise<void> {
  const context = {
    tables: { app, edge: { entries: {} } },
    runtime,
    request: new Request(`${HOST}/api/revalidate`),
    startedAt: T0,
    fetchStarts: new Map<string, number>(),
    waitUntil: () => {
      // What the regeneration hands the runtime is what the call itself waits on.
    },
    run: <T>(work: () => Promise<T>) => work(),
    invalidated: new InvalidatedTags(),
    writes: new RequestWrites(),
  };
  return withClock(T0, () =>
    withRequestContext(context, () => platformRevalidate({ urlPath: path })),
  );
}

const PREFETCH = {
  rsc: '1',
  'next-router-prefetch': '1',
  'next-router-segment-prefetch': SEGMENT,
};

describe('a member of a route that blocks, keyed by some of its parameters', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    vi.mocked(invokeNodeHandler).mockReset().mockImplementation(rendering);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is kept under the shell its class completes to', () => {
    const template = templateOf(['nxtPlang', 'nxtPregion']);

    expect(completedShell(template, '/de/fr/posts/1')).toBe(COMPLETED);
    expect(completedShell(template, '/de/fr/posts/2')).toBe(COMPLETED);
  });

  /** A class narrower than its route keeps what it resolved; the rest is completed as before. */
  it('is completed from a class narrower than its route', () => {
    const narrower = {
      ...templateOf(['nxtPregion']),
      id: '/de/[region]/posts/[id]',
      pathname: '/de/[region]/posts/[id]',
    };

    expect(completedShell(narrower, '/de/fr/posts/1')).toBe(COMPLETED);
  });

  it('is its own entry where the build keys the class by every parameter, as before 16.4', () => {
    const every = templateOf(['nxtPlang', 'nxtPregion', 'nxtPid']);

    expect(completedShell(every, '/de/fr/posts/1')).toBe('/de/fr/posts/1');
  });

  it('is not completed from a shell the build made, which answers it as it is', () => {
    const built = {
      ...templateOf(['nxtPlang', 'nxtPregion']),
      body: { sha256: 'tree', byteLength: 1, contentType: 'text/html' },
    };

    expect(completedShell(built, '/de/fr/posts/1')).toBe('/de/fr/posts/1');
  });

  it('is answered from the shell, rendered once for every member that shares it', async () => {
    const shared = cache();

    const first = await ask(shared, '/de/fr/posts/1');
    const second = await ask(shared, '/de/fr/posts/2');

    expect(first).toBe(`${SHELL}${RESUMED}`);
    expect(second).toBe(`${SHELL}${RESUMED}`);
    expect(kept()).toStrictEqual([COMPLETED]);
    expect(leases(shared.authority)).toBe(1);
  });

  it('is resumed for its own pathname', async () => {
    const shared = cache();

    await ask(shared, '/de/fr/posts/1');
    await ask(shared, '/de/fr/posts/2');
    const resumed = vi
      .mocked(invokeNodeHandler)
      .mock.calls.filter(([call]) => call.requestMeta['postponed'] !== undefined)
      .map(([call]) => new URL(call.url ?? '', HOST).pathname);

    expect(resumed).toStrictEqual(['/de/fr/posts/1', '/de/fr/posts/2']);
  });

  it('is prefetched from the class’s own output first, and the shell made behind it', async () => {
    const shared = cache();

    const first = await ask(shared, '/de/fr/posts/1?_rsc=a', PREFETCH);
    const afterwards = await ask(shared, '/de/fr/posts/2?_rsc=a', PREFETCH);

    expect(first).toBe(BUILT_SEGMENT);
    expect(afterwards).toBe(SHELL_SEGMENT);
    expect(kept()).toStrictEqual([COMPLETED]);
  });

  it('shares nothing with a member under other root parameters', async () => {
    const shared = cache();

    await ask(shared, '/de/fr/posts/1');
    const other = await ask(shared, '/de/ch/posts/1?_rsc=a', PREFETCH);

    expect(other).toBe(BUILT_SEGMENT);
    expect(kept()).toStrictEqual([COMPLETED, '/de/ch/posts/[id]']);
  });

  /**
   * An action posted to the page re-renders it with the state of the entry it was answered from,
   * so that what the render cached is what the page showed (`actionPostponedFor`).
   */
  it('is handed the shell’s state when an action is posted to it', async () => {
    const shared = cache();

    await ask(shared, '/de/fr/posts/1');
    await act(shared, '/de/fr/posts/2');
    const action = vi
      .mocked(invokeNodeHandler)
      .mock.calls.map(([call]) => call)
      .find((call) => call.request.headers.has('next-action'));

    expect(action?.requestMeta['postponed']).toBe('the post, held up');
  });

  /** `res.revalidate` of a member regenerates the entry its requests read, as Next.js 16.4 does. */
  it('is revalidated as the shell it completes to', async () => {
    const shared = cache();

    await revalidate(shared, '/de/fr/posts/1');

    expect(kept()).toStrictEqual([COMPLETED]);
  });

  it('is rendered as its own entry where the build keys the class by every parameter', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(['nxtPlang', 'nxtPregion', 'nxtPid']));
    const shared = cache();

    await ask(shared, '/de/fr/posts/1');

    expect(kept()).toStrictEqual(['/de/fr/posts/1']);
  });
});

/** A payload request naming `part` as the segment it prefetches. */
function askedFor(part: string): Request {
  return new Request(HOST, { headers: { 'next-router-segment-prefetch': part } });
}

describe('the output a payload request names', () => {
  /** An empty segment header names no segment, as the build's own answer reads it. */
  it('is the payload where the segment header is empty', () => {
    const store = deployment();

    expect(rscRepresentation(askedFor(''), store)).toBe('rsc');
    expect(rscRepresentation(askedFor(SEGMENT), store)).toBe(`segment:${SEGMENT}`);
  });
});
