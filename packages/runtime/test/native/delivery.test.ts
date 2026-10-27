import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import type { GenerationPackHeader, RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CurrentGeneration, currentGeneration } from '../../src/cache/current.ts';
import type { CacheRuntime } from '../../src/cache/runtime.ts';
import type { FirstPublish } from '../../src/delivery.ts';
import * as shared from '../../src/delivery.ts';
import * as native from '../../src/native/delivery.ts';
import type { RoutedInput } from '../../src/serve.ts';
import { getStore, type Store } from '../../src/store.ts';

/**
 * The edge's rules for what goes out as everyone's, on the native target (`native/delivery.ts`),
 * against the runtime's own answer on Workers (`delivery.ts`), which stays the visitor's.
 */

vi.mock(import('../../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// The record a first member's data waits for is the test's to give (`offeredOncePublished`).
vi.mock(import('../../src/cache/current.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, currentGeneration: vi.fn() };
});

const PAGE_SHA = 'a'.repeat(64);
const BODY_SHA = 'b'.repeat(64);
const PAGE_BYTES = new TextEncoder().encode('<p>hi</p>');
const BODY_BYTES = new Uint8Array([1, 2, 3, 4]);
const ORIGIN = 'http://127.0.0.1:3000';
const VISITOR = 'private, no-store';
const REVALIDATE = 'public, max-age=0, must-revalidate';
const GATED = 'private, max-age=0, must-revalidate';
const SCOPE = 'scope';

const PAGE: Prerender = {
  id: 'page',
  parentOutputId: 'page',
  groupId: 1,
  pathname: '/something',
  route: '/something',
  routeType: 'page',
  response: 'complete',
  compute: 'static',
  initialRevalidate: false,
  body: { sha256: PAGE_SHA, byteLength: PAGE_BYTES.byteLength, contentType: 'text/html' },
};
const ISR: Prerender = {
  ...PAGE,
  id: 'isr',
  parentOutputId: 'isr',
  groupId: 3,
  pathname: '/isr',
  route: '/isr',
  initialRevalidate: 60,
};
const BODY: Prerender = {
  id: 'body',
  parentOutputId: 'body',
  groupId: 2,
  pathname: '/opengraph-image',
  route: '/opengraph-image',
  routeType: 'route',
  response: 'complete',
  compute: 'static',
  initialRevalidate: false,
  body: { sha256: BODY_SHA, byteLength: BODY_BYTES.byteLength, contentType: 'image/png' },
};

function bundle(): DeploymentBundle {
  return {
    v: 1,
    deploymentId: 'dpl_test',
    nextVersion: '16.4.3',
    buildId: 'build',
    projectDir: '.',
    generatedAt: '2026-10-26T00:00:00.000Z',
    staticPagesPrivacy: 3,
    routeBodyPrivacy: 2,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [
        // A rule of `next.config` for every visitor, and one only for some.
        { sourceRegex: '^/something$', headers: { 'x-everyone': '1' } },
        {
          sourceRegex: '^/something$',
          headers: { 'x-some': '1' },
          has: [{ type: 'header', key: 'x-choose' }],
        },
      ],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc',
        prefetchHeader: 'next-router-prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [
      { id: 'page', kind: 'pages', pathname: '/something' },
      { id: 'isr', kind: 'pages', pathname: '/isr' },
      { id: 'body', kind: 'app-route', pathname: '/opengraph-image' },
    ],
    prerenders: [PAGE, ISR, BODY],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: '2026-10-01',
        compatibilityFlags: [],
      },
    },
  };
}

function header(
  kind: 'pages' | 'app-route',
  extra: Partial<GenerationPackHeader>,
): GenerationPackHeader {
  const page = kind === 'pages';
  const sha = page ? PAGE_SHA : BODY_SHA;
  const bytes = page ? PAGE_BYTES : BODY_BYTES;
  const prerender = page ? PAGE : BODY;
  return {
    schemaVersion: 1,
    scopeId: SCOPE,
    entryId: `${prerender.id}-entry`,
    generationId: 'generation',
    seq: 1,
    source: 'build',
    kind,
    route: prerender.route,
    pathname: prerender.pathname,
    cacheTimestamp: 1,
    producedAt: 1,
    policy: {
      revalidateAfter: { kind: 'unbounded' },
      expireAfter: { kind: 'unbounded' },
      clientStale: { kind: 'unknown' },
      source: 'build-output',
    },
    status: 200,
    headers: { 'content-type': page ? 'text/html' : 'image/png' },
    tags: [],
    htmlSha256: sha,
    htmlLength: bytes.byteLength,
    postponedSha256: null,
    postponedLength: 0,
    artifacts: [
      {
        artifactId: 'artifact',
        sha256: sha,
        byteLength: bytes.byteLength,
        contentType: page ? 'text/html' : 'image/png',
        encoding: 'identity',
        role: page ? 'html' : 'route-body',
        representationKey: page ? 'html' : 'route-body',
      },
    ],
    revision: 0,
    ...(page && { staticPagePrivacy: 1 as const }),
    ...extra,
  };
}

function current(kind: 'pages' | 'app-route', extra: Partial<GenerationPackHeader> = {}) {
  const made = header(kind, extra);
  return {
    entryId: made.entryId,
    validity: 'fresh',
    pack: {
      header: made,
      html: kind === 'pages' ? PAGE_BYTES : BODY_BYTES,
      postponed: undefined,
    },
  } as CurrentGeneration;
}

function routed(path: string, init: RequestInit = {}, middlewareRan = false): RoutedInput {
  return {
    request: new Request(`${ORIGIN}${path}`, init),
    cache: { scopeId: SCOPE },
    waitUntil: () => {
      // Nothing is left behind the answers here.
    },
    ...(middlewareRan && { middlewareRan: true }),
  } as unknown as RoutedInput;
}

/** What the runtime answers, before either rule: one visitor's. */
function visitorAnswer(contentType: string): Response {
  return new Response('body', {
    headers: { 'content-type': contentType, 'cache-control': VISITOR },
  });
}

type Delivery = typeof shared;

/** The runtime's answer through a target's two steps, with routing's own headers between them. */
function answered(
  target: Delivery,
  input: RoutedInput,
  made: CurrentGeneration,
  routing: Record<string, string> = {},
): Response {
  const page = made.pack.header.kind === 'pages';
  const offered = target.offeredFromGeneration(
    input,
    made,
    page ? 'html' : 'route-body',
    visitorAnswer(page ? 'text/html; charset=utf-8' : 'image/png'),
  );
  const laid = new Response(offered.body, offered);
  for (const [name, value] of Object.entries(routing)) laid.headers.set(name, value);
  return target.delivered(input.request, laid);
}

describe('answers by the edge’s rules on the native target', () => {
  beforeEach(() => {
    vi.mocked(getStore).mockReturnValue({ manifest: bundle() } as unknown as Store);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('leaves a prerendered page the visitor’s on Workers, where the edge decides', () => {
    const response = answered(shared, routed('/something'), current('pages'));

    expect(response.headers.get('cache-control')).toBe(VISITOR);
  });

  it('shares a prerendered page with an anonymous GET, and says nothing of its own', () => {
    const response = answered(native, routed('/something'), current('pages'));

    expect(response.headers.get('cache-control')).toBe(REVALIDATE);
    expect(
      [...response.headers.keys()].filter((name) => name.startsWith('x-arkor-')),
    ).toStrictEqual([]);
  });

  it('keeps a page that carries no-transform from being transformed', () => {
    const made = current('pages', {
      headers: { 'content-type': 'text/html', 'cache-control': 's-maxage=1, no-transform' },
    });

    const response = answered(native, routed('/something'), made);

    expect(response.headers.get('cache-control')).toBe(`${REVALIDATE}, no-transform`);
  });

  it.each([
    ['a cookie', { headers: { cookie: 'a=1' } }],
    ['authorization', { headers: { authorization: 'Bearer x' } }],
    ['a condition', { headers: { 'if-none-match': '"x"' } }],
    ['a rule that holds for this visitor alone', { headers: { 'x-choose': '1' } }],
  ])('keeps a page the visitor’s for a request with %s', (_name, init) => {
    const response = answered(native, routed('/something', init), current('pages'));

    expect(response.headers.get('cache-control')).toBe(VISITOR);
  });

  it('keeps a page the visitor’s once a middleware ran, and for a HEAD', () => {
    const middleware = answered(native, routed('/something', {}, true), current('pages'));
    const head = answered(native, routed('/something', { method: 'HEAD' }), current('pages'));

    expect(middleware.headers.get('cache-control')).toBe(VISITOR);
    expect(head.headers.get('cache-control')).toBe(VISITOR);
  });

  it('shares an ISR page stale, and keeps one the cache carries an invalidation of the visitor’s', () => {
    const isr: Partial<GenerationPackHeader> = {
      entryId: 'isr-entry',
      route: '/isr',
      pathname: '/isr',
      staticPagePrivacy: 2,
      policy: {
        revalidateAfter: { kind: 'finite', seconds: 60 },
        expireAfter: { kind: 'unbounded' },
        clientStale: { kind: 'unknown' },
        source: 'build-output',
      },
    };
    const stale = { ...current('pages', isr), validity: 'stale' } as CurrentGeneration;
    const invalidated = current('pages', { ...isr, invalidation: { revision: 1 } });

    expect(answered(native, routed('/isr'), stale).headers.get('cache-control')).toBe(REVALIDATE);
    expect(answered(native, routed('/isr'), invalidated).headers.get('cache-control')).toBe(
      VISITOR,
    );
  });

  it('answers a stale ISR page as it stands for a request it is everyone’s for, and on Workers never', () => {
    const stale = {
      ...current('pages', {
        entryId: 'isr-entry',
        route: '/isr',
        pathname: '/isr',
        staticPagePrivacy: 2,
        policy: {
          revalidateAfter: { kind: 'finite', seconds: 60 },
          expireAfter: { kind: 'unbounded' },
          clientStale: { kind: 'unknown' },
          source: 'build-output',
        },
      }),
      validity: 'stale',
    } as CurrentGeneration;
    const invalidated = {
      ...stale,
      pack: {
        ...stale.pack,
        header: { ...stale.pack.header, invalidation: { revision: 1 } },
      },
    } as CurrentGeneration;
    const standing = (input: RoutedInput, made = stale): boolean =>
      native.standingShared(input, made, 'html');

    expect(standing(routed('/isr'))).toBe(true);
    expect(standing(routed('/isr', { headers: { cookie: 'a=1' } }))).toBe(false);
    expect(standing(routed('/isr', {}, true))).toBe(false);
    expect(standing(routed('/elsewhere'))).toBe(false);
    expect(standing(routed('/isr'), invalidated)).toBe(false);
    expect(shared.standingShared(routed('/isr'), stale, 'html')).toBe(false);
  });

  it('keeps a page the visitor’s where a route ahead of the filesystem takes its request', () => {
    // A rewrite through another name and back, for a request that carries `x-hop`; a rule of that
    // other name, for the same request, lays a header no rule of the page's own name lays.
    const made = bundle();
    vi.mocked(getStore).mockReturnValue({
      manifest: {
        ...made,
        routing: {
          ...made.routing,
          beforeMiddleware: [
            ...made.routing.beforeMiddleware,
            {
              sourceRegex: '^/intermediate$',
              headers: { 'access-control-allow-origin': '*' },
              has: [{ type: 'header', key: 'x-hop' }],
            },
          ],
          beforeFiles: [
            {
              sourceRegex: '^/something$',
              destination: '/intermediate',
              has: [{ type: 'header', key: 'x-hop' }],
            },
            { sourceRegex: '^/intermediate$', destination: '/something' },
          ],
        },
      },
    } as unknown as Store);

    const hopped = answered(
      native,
      routed('/something', { headers: { 'x-hop': '1' } }),
      current('pages'),
      { 'access-control-allow-origin': '*' },
    );
    const direct = answered(native, routed('/something'), current('pages'));

    expect(hopped.headers.get('cache-control')).toBe(VISITOR);
    expect(direct.headers.get('cache-control')).toBe(REVALIDATE);
  });

  it('keeps a page whose record the build did not admit the visitor’s', () => {
    const made = current('pages', { staticPagePrivacy: undefined });

    const response = answered(native, routed('/something'), made);

    expect(response.headers.get('cache-control')).toBe(VISITOR);
  });

  it('shares a prerendered route body under a shared revalidation where its record has no policy', () => {
    const response = answered(native, routed('/opengraph-image'), current('app-route'));

    expect(response.headers.get('cache-control')).toBe(REVALIDATE);
  });

  it('keeps a route body’s own policy, and one a middleware admitted from shared caches', () => {
    const made = current('app-route', {
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=60' },
    });

    const own = answered(native, routed('/opengraph-image'), made);
    const gated = answered(native, routed('/opengraph-image', {}, true), made);

    expect(own.headers.get('cache-control')).toBe('public, max-age=60');
    expect(gated.headers.get('cache-control')).toBe(GATED);
  });

  it('keeps a route body the visitor’s when routing laid a cookie on it, or its own privacy', () => {
    const cookie = answered(native, routed('/opengraph-image'), current('app-route'), {
      'set-cookie': 'a=1',
    });
    const privacy = answered(native, routed('/opengraph-image'), current('app-route'), {
      'cache-control': 'private, max-age=60',
    });

    expect(cookie.headers.get('cache-control')).toBe(VISITOR);
    // Routing's own word stands, as it would over the visitor's answer.
    expect(privacy.headers.get('cache-control')).toBe('private, max-age=60');
  });
});

/** A `fallback: true` route, its loading shell the build's, its members its first requests' own. */
const FALLBACK_ROUTE = '/fallback-true/[slug]';
const MEMBER = '/fallback-true/second';
const MEMBER_DATA = `/_next/data/build${MEMBER}.json`;
const DATA_BYTES = new TextEncoder().encode('{"pageProps":{}}');
const SHELL: Prerender = {
  id: FALLBACK_ROUTE,
  pathname: FALLBACK_ROUTE,
  route: FALLBACK_ROUTE,
  parentOutputId: 'fallback',
  groupId: 4,
  routeType: 'fallback',
  response: 'initial',
  compute: 'static',
  initialRevalidate: 1,
  allowQuery: ['nxtPslug'],
  body: { sha256: PAGE_SHA, byteLength: PAGE_BYTES.byteLength, contentType: 'text/html' },
};

function fallbackBundle(): DeploymentBundle {
  const made = bundle();
  return {
    ...made,
    routing: {
      ...made.routing,
      beforeMiddleware: [],
      dynamicRoutes: [
        { sourceRegex: '^/fallback-true/([^/]+?)(?:/)?$', destination: FALLBACK_ROUTE },
      ],
    },
    entrypoints: [{ id: 'fallback', kind: 'pages', pathname: FALLBACK_ROUTE }],
    prerenders: [SHELL],
  };
}

/** The first generation a request made of the member: its page and its paired data. */
function memberCurrent(): CurrentGeneration {
  const made = header('pages', {
    entryId: 'member-entry',
    source: 'runtime',
    route: FALLBACK_ROUTE,
    pathname: MEMBER,
    staticPagePrivacy: 3,
    policy: {
      revalidateAfter: { kind: 'finite', seconds: 60 },
      expireAfter: { kind: 'unbounded' },
      clientStale: { kind: 'unknown' },
      source: 'runtime-output',
    },
    artifacts: [
      {
        artifactId: 'html',
        sha256: PAGE_SHA,
        byteLength: PAGE_BYTES.byteLength,
        contentType: 'text/html',
        encoding: 'identity',
        role: 'html',
        representationKey: 'html',
      },
      {
        artifactId: 'data',
        sha256: 'c'.repeat(64),
        byteLength: DATA_BYTES.byteLength,
        contentType: 'application/json',
        encoding: 'identity',
        role: 'pages-data',
        representationKey: 'pages-data',
        storageRef: 'data',
      },
    ],
  });
  return {
    entryId: made.entryId,
    validity: 'fresh',
    pack: { header: made, html: PAGE_BYTES, postponed: undefined },
  };
}

/** The member's data, as the runtime answers it before either rule: one visitor's. */
function dataAnswer(): Response {
  return visitorAnswer('application/json');
}

/** The loading fallback the build wrote for the route, which says nothing of its lifetime. */
function loadingAnswer(): Response {
  return new Response('loading', { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** The route's loading fallback the build wrote, through both steps. */
function deliveredFor(input: RoutedInput): Response {
  return native.delivered(
    input.request,
    native.offeredFromFallback(input, getStore(), SHELL, loadingAnswer()),
  );
}

/** The runtime's answer of `representation` from `made`, through both steps, `routing` between. */
function answeredAs(
  input: RoutedInput,
  made: CurrentGeneration,
  representation: 'html' | 'pages-data',
  routing: Record<string, string> = {},
): Response {
  const offered = native.offeredFromGeneration(
    input,
    made,
    representation,
    representation === 'html' ? visitorAnswer('text/html; charset=utf-8') : dataAnswer(),
  );
  const laid = new Response(offered.body, offered);
  for (const [name, value] of Object.entries(routing)) laid.headers.set(name, value);
  return native.delivered(input.request, laid);
}

describe('a member of a fallback: true route, and what a rewrite or routing left on an answer', () => {
  beforeEach(() => {
    vi.mocked(getStore).mockReturnValue({ manifest: fallbackBundle() } as unknown as Store);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shares a member its first request rendered, its page and its data, each by its own name', () => {
    const page = answeredAs(routed(MEMBER), memberCurrent(), 'html');
    const data = answeredAs(routed(MEMBER_DATA), memberCurrent(), 'pages-data');

    expect(page.headers.get('cache-control')).toBe(REVALIDATE);
    expect(data.headers.get('cache-control')).toBe(REVALIDATE);
  });

  it('keeps a member’s data the visitor’s where routing laid a cookie or a private policy on it', () => {
    const cookie = answeredAs(routed(MEMBER_DATA), memberCurrent(), 'pages-data', {
      'set-cookie': 'a=1',
    });
    const privacy = answeredAs(routed(MEMBER_DATA), memberCurrent(), 'pages-data', {
      'cache-control': 'private, max-age=60',
    });

    expect(cookie.headers.get('cache-control')).toBe(VISITOR);
    expect(privacy.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('keeps a member the visitor’s where a rewrite led to it from another name', () => {
    const page = answeredAs(routed('/alias'), memberCurrent(), 'html');
    const data = answeredAs(routed('/_next/data/build/alias.json'), memberCurrent(), 'pages-data');

    expect(page.headers.get('cache-control')).toBe(VISITOR);
    expect(data.headers.get('cache-control')).toBe(VISITOR);
  });

  it('shares the loading fallback asked for by a member’s own name, and by no other', () => {
    expect(deliveredFor(routed(MEMBER)).headers.get('cache-control')).toBe(REVALIDATE);
    expect(deliveredFor(routed('/alias')).headers.get('cache-control')).toBe(VISITOR);
    expect(deliveredFor(routed(MEMBER, {}, true)).headers.get('cache-control')).toBe(VISITOR);
    expect(
      deliveredFor(routed(MEMBER, { headers: { cookie: 'a=1' } })).headers.get('cache-control'),
    ).toBe(VISITOR);
  });
});

/** The member's first data the visitor is answered with, through both steps. */
async function heldFor(
  target: Delivery,
  input: RoutedInput,
  first: FirstPublish,
): Promise<Response> {
  const held = await target.offeredOncePublished(input, first, 'pages-data', dataAnswer());
  return target.delivered(input.request, held);
}

/** Whether `promise` is still pending once everything queued ahead of the check has run. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
}

describe('a member’s first data, held for its first generation', () => {
  const descriptor: RouteEntryDescriptor = {
    kind: 'pages',
    route: FALLBACK_ROUTE,
    pathname: MEMBER,
  };
  const generation = { kind: 'generation', current: memberCurrent() } as const;
  const none = { kind: 'none', entryId: 'member-entry' } as const;

  /** What the runtime knows of the first generation, its answer from the record the rules'. */
  function firstPublish(input: RoutedInput, given: Partial<FirstPublish>): FirstPublish {
    return {
      runtime: { log: vi.fn() } as unknown as CacheRuntime,
      descriptor,
      published: undefined,
      elsewhere: false,
      fromRecord: vi.fn((made: CurrentGeneration) =>
        Promise.resolve(native.offeredFromGeneration(input, made, 'pages-data', dataAnswer())),
      ),
      ...given,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getStore).mockReturnValue({ manifest: fallbackBundle() } as unknown as Store);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('answers from the generation once this isolate’s publish of it settles', async () => {
    const input = routed(MEMBER_DATA);
    const publish = Promise.withResolvers<unknown>();
    vi.mocked(currentGeneration).mockResolvedValue(generation);

    const answer = heldFor(native, input, firstPublish(input, { published: publish.promise }));
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending(answer)).resolves.toBe(true);
    expect(currentGeneration).not.toHaveBeenCalled();

    publish.resolve({ kind: 'published', generationId: 'generation' });

    await expect(answer).resolves.toSatisfy(
      (response: Response) => response.headers.get('cache-control') === REVALIDATE,
    );
  });

  it('reads the record again while it is absent, where another render is making it', async () => {
    const input = routed(MEMBER_DATA);
    vi.mocked(currentGeneration)
      .mockResolvedValueOnce(none)
      .mockResolvedValueOnce(none)
      .mockResolvedValueOnce(generation);

    const answer = heldFor(native, input, firstPublish(input, { elsewhere: true }));
    await vi.advanceTimersByTimeAsync(250 + 500);

    expect((await answer).headers.get('cache-control')).toBe(REVALIDATE);
    expect(currentGeneration).toHaveBeenCalledTimes(3);
  });

  it('leaves the visitor the answer made for them once they go', async () => {
    const controller = new AbortController();
    const input = routed(MEMBER_DATA, { signal: controller.signal });
    vi.mocked(currentGeneration).mockResolvedValue(none);
    const first = firstPublish(input, { elsewhere: true });

    const answer = heldFor(native, input, first);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect((await answer).headers.get('cache-control')).toBe(VISITOR);
    expect(currentGeneration).toHaveBeenCalledTimes(1);
    expect(first.fromRecord).not.toHaveBeenCalled();
  });

  it('reads an absent record six times at the most, as the edge reads it', async () => {
    const input = routed(MEMBER_DATA);
    vi.mocked(currentGeneration).mockResolvedValue(none);

    const answer = heldFor(native, input, firstPublish(input, { elsewhere: true }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await answer).headers.get('cache-control')).toBe(VISITOR);
    expect(currentGeneration).toHaveBeenCalledTimes(6);
  });

  it('waits ten seconds at the most for a publish that does not settle', async () => {
    const input = routed(MEMBER_DATA);

    const answer = heldFor(
      native,
      input,
      firstPublish(input, { published: Promise.withResolvers<unknown>().promise }),
    );
    await vi.advanceTimersByTimeAsync(9999);

    await expect(pending(answer)).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(1);

    expect((await answer).headers.get('cache-control')).toBe(VISITOR);
    expect(currentGeneration).not.toHaveBeenCalled();
  });

  it('reads once after a publish that came to nothing, and not at all where nobody makes one', async () => {
    const input = routed(MEMBER_DATA);
    vi.mocked(currentGeneration).mockResolvedValue(none);

    const refused = await heldFor(
      native,
      input,
      firstPublish(input, { published: Promise.resolve({ kind: 'refused', reason: 'lease' }) }),
    );

    expect(refused.headers.get('cache-control')).toBe(VISITOR);
    expect(currentGeneration).toHaveBeenCalledTimes(1);

    vi.mocked(currentGeneration).mockClear();
    const unmade = await heldFor(native, input, firstPublish(input, {}));

    expect(unmade.headers.get('cache-control')).toBe(VISITOR);
    expect(currentGeneration).not.toHaveBeenCalled();
  });

  it('answers with the data made for the visitor where the generation’s own output does not come in time', async () => {
    const input = routed(MEMBER_DATA);
    vi.mocked(currentGeneration).mockResolvedValue(generation);
    // The generation's answer reads its output from the cache, which never answers.
    const first = firstPublish(input, {
      published: Promise.resolve({ kind: 'published' }),
      fromRecord: vi.fn(() => Promise.withResolvers<Response | undefined>().promise),
    });

    const answer = heldFor(native, input, first);
    await vi.advanceTimersByTimeAsync(9999);

    await expect(pending(answer)).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(1);

    expect((await answer).headers.get('cache-control')).toBe(VISITOR);
    expect(first.fromRecord).toHaveBeenCalledTimes(1);
  });

  it('holds nothing for data no shared cache may answer the request for', async () => {
    const input = routed(MEMBER_DATA, { headers: { cookie: 'a=1' } });
    vi.mocked(currentGeneration).mockResolvedValue(generation);

    const answer = await heldFor(native, input, firstPublish(input, { elsewhere: true }));

    expect(answer.headers.get('cache-control')).toBe(VISITOR);
    expect(currentGeneration).not.toHaveBeenCalled();
  });

  it('answers with the data made for the visitor whatever fails of the wait, and says so', async () => {
    const input = routed(MEMBER_DATA);
    vi.mocked(currentGeneration).mockRejectedValueOnce(new Error('the cache is gone'));
    const readFailed = firstPublish(input, { elsewhere: true });
    const answerFailed = firstPublish(input, {
      published: Promise.resolve({ kind: 'published' }),
      fromRecord: vi.fn(() => Promise.reject(new Error('the output is gone'))),
    });

    const read = await heldFor(native, input, readFailed);
    vi.mocked(currentGeneration).mockResolvedValue(generation);
    const output = await heldFor(native, input, answerFailed);

    expect(read.headers.get('cache-control')).toBe(VISITOR);
    expect(output.headers.get('cache-control')).toBe(VISITOR);
    expect(readFailed.runtime.log).toHaveBeenCalledWith('first data not shared', {
      pathname: MEMBER,
      detail: 'the cache is gone',
    });
    expect(answerFailed.runtime.log).toHaveBeenCalledWith('first data not shared', {
      pathname: MEMBER,
      detail: 'the output is gone',
    });
  });

  it('begins no read for a visitor already gone', async () => {
    const controller = new AbortController();
    controller.abort();
    const input = routed(MEMBER_DATA, { signal: controller.signal });
    vi.mocked(currentGeneration).mockRejectedValue(new Error('read past the visitor'));

    const answer = await heldFor(native, input, firstPublish(input, { elsewhere: true }));

    expect(answer.headers.get('cache-control')).toBe(VISITOR);
    expect(currentGeneration).not.toHaveBeenCalled();
  });

  it('holds nothing for data a rewrite led to from another name, or on Workers', async () => {
    const rewritten = routed('/_next/data/build/alias.json');
    const input = routed(MEMBER_DATA);
    vi.mocked(currentGeneration).mockResolvedValue(generation);
    const made = dataAnswer();

    const alias = await heldFor(native, rewritten, firstPublish(rewritten, { elsewhere: true }));
    const workers = await shared.offeredOncePublished(
      input,
      firstPublish(input, { published: Promise.resolve({ kind: 'published' }) }),
      'pages-data',
      made,
    );

    expect(alias.headers.get('cache-control')).toBe(VISITOR);
    expect(workers).toBe(made);
    expect(currentGeneration).not.toHaveBeenCalled();
  });
});
