import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import type { GenerationPackHeader } from '@stayingupwind/core/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentGeneration } from '../../src/cache/current.ts';
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
    ...(middlewareRan && { middlewareRan: true }),
  } as unknown as RoutedInput;
}

/** What the runtime answers, before either rule: one visitor's. */
function visitorAnswer(contentType: string, extra: Record<string, string> = {}): Response {
  return new Response('body', {
    headers: { 'content-type': contentType, 'cache-control': VISITOR, ...extra },
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
