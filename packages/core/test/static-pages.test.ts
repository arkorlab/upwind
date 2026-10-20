import { describe, expect, it } from 'vitest';

import {
  type DeploymentBundle,
  type Prerender,
  deploymentBundleSchema,
} from '../src/bundle/schema.ts';
import { edgeServableStaticPages } from '../src/bundle/static-pages.ts';
import { KEY_SCHEMA_VERSION } from '../src/cache/keys.ts';
import { packHeaderOf } from '../src/cache/pack-header.ts';
import { generationPackHeaderSchema, outputSnapshotSchema } from '../src/cache/schema.ts';
import { functionFor } from '../src/manifest/functions.ts';
import { gateFor } from '../src/manifest/gates.ts';
import { buildProjectManifest, serializeManifest } from '../src/manifest/manifest.ts';
import { findStaticPage } from '../src/manifest/static-pages.ts';
import { classifyRequest } from '../src/request/classify.ts';
import { createId } from '../src/util/index.ts';
const GENERATED_AT = '2026-10-20T00:00:00.000Z';
const BLOB = { sha256: 'a'.repeat(64), byteLength: 8, contentType: 'text/html' };
const PAGE: Prerender = {
  id: 'html',
  pathname: '/something',
  route: '/something',
  parentOutputId: 'page',
  groupId: 1,
  routeType: 'page',
  response: 'complete',
  compute: 'static',
  initialRevalidate: false,
  body: { sha256: 'a'.repeat(64), byteLength: 8, contentType: 'text/html' },
};
const FUNCTION = {
  mainModule: 'index.mjs',
  modules: [],
  compatibilityDate: '2026-10-01',
  compatibilityFlags: [],
};
function bundleOf(extra: Partial<DeploymentBundle> = {}): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: GENERATED_AT,
    staticPagesPrivacy: 1,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
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
    entrypoints: [{ id: 'page', kind: 'pages', pathname: '/something' }],
    prerenders: [PAGE],
    staticFiles: [],
    functions: { app: FUNCTION },
    ...extra,
  };
}

const ENTRY = { pathname: '/something', route: '/something', entryId: 'page-entry' };
function manifestOf(extra: Partial<Parameters<typeof buildProjectManifest>[0]> = {}) {
  return buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    generatedAt: GENERATED_AT,
    originHost: 'app.example',
    deployment: { dplId: 'deployment', assetSetHash: 'assets', observedAt: GENERATED_AT },
    routes: [
      {
        pathname: ENTRY.pathname,
        status: 200,
        shell: {
          sha256: 'a'.repeat(64),
          byteLength: 8,
          contentType: 'text/html',
          encoding: 'identity',
        },
        headers: {},
        cache: { entryId: ENTRY.entryId, kind: 'pages', delivery: 'complete' },
      },
    ],
    app: { deploymentId: 'deployment', scriptName: 'app' },
    cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: 'scope' },
    staticPages: [ENTRY],
    ...extra,
  });
}
const HEADER = {
  schemaVersion: 1,
  scopeId: 'scope',
  entryId: 'page-entry',
  generationId: 'generation',
  seq: 1,
  source: 'build',
  kind: 'pages',
  route: '/something',
  pathname: '/something',
  cacheTimestamp: 1,
  producedAt: 1,
  policy: {
    revalidateAfter: { kind: 'unbounded' },
    expireAfter: { kind: 'unbounded' },
    clientStale: { kind: 'unknown' },
    source: 'build-output',
  },
  status: 200,
  headers: {},
  tags: [],
  htmlSha256: 'a'.repeat(64),
  htmlLength: 8,
  postponedSha256: null,
  postponedLength: 0,
  artifacts: [],
  revision: 0,
};

describe('trusted complete static Pages documents', () => {
  it.each(['GET', 'HEAD'])('classifies %s without browser navigation hints', (method) => {
    const manifest = manifestOf();

    expect(
      classifyRequest({
        method,
        url: new URL('https://app.example/something'),
        headers: new Headers(),
        manifest,
        deployment: manifest.deployment,
      }),
    ).toStrictEqual({ kind: 'static-page', entry: ENTRY });
  });

  it('retains the new table while preserving absent legacy bytes', () => {
    const manifest = manifestOf();

    expect(manifest).toHaveProperty('staticPages', { '/something': ENTRY });
    expect(serializeManifest(manifest)).toContain('staticPages');
  });

  it('retains only supported optional static privacy proofs in the fast decoder', () => {
    expect(packHeaderOf({ ...HEADER, staticPagePrivacy: 1 })).toHaveProperty(
      'staticPagePrivacy',
      1,
    );
    expect(packHeaderOf({ ...HEADER, staticPagePrivacy: 2 })).toBeUndefined();
  });
});

describe('build proof for complete static Pages HTML', () => {
  it('admits the fixed Next revalidation protocol while keeping its exact primary body', () => {
    const page = {
      ...PAGE,
      allowHeader: [
        'host',
        'x-matched-path',
        'x-prerender-revalidate',
        'x-prerender-revalidate-if-generated',
        'x-next-revalidated-tags',
        'x-next-revalidate-tag-token',
      ],
    };

    expect(edgeServableStaticPages(bundleOf({ prerenders: [page] }))).toStrictEqual([page]);
  });

  it('maps the complete static Pages build with the fixed Next router Vary protocol', () => {
    const page = {
      ...PAGE,
      id: '/something',
      allowHeader: [
        'host',
        'x-matched-path',
        'x-prerender-revalidate',
        'x-prerender-revalidate-if-generated',
        'x-next-revalidated-tags',
        'x-next-revalidate-tag-token',
      ],
      initialHeaders: {
        vary: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
        'content-type': 'text/html; charset=utf-8',
      },
      body: {
        sha256: 'd8572094aef1ffa6c3633212dc6639c2c41b6a0fc47f47ac7e35a16e0c0cf71a',
        byteLength: 2100,
        contentType: 'text/html; charset=utf-8',
      },
    };
    const admitted = edgeServableStaticPages(bundleOf({ prerenders: [page] }));
    const manifest = manifestOf({
      staticPages: admitted.map(({ pathname, route }) => ({ ...ENTRY, pathname, route })),
    });

    expect(admitted).toStrictEqual([page]);
    expect(findStaticPage(manifest, '/something')).toStrictEqual(ENTRY);
    expect(page.initialHeaders.vary).toBe(
      'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
    );
  });

  it('grants nothing to an old bundle even when rebuilt by a current host', () => {
    const bundle = bundleOf({ staticPagesPrivacy: undefined });

    expect(edgeServableStaticPages(deploymentBundleSchema.parse(bundle))).toStrictEqual([]);
  });

  it.each([
    { name: 'ISR', patch: { initialRevalidate: 2 } },
    { name: 'unknown lifetime', patch: { initialRevalidate: undefined } },
    { name: 'finite expiration', patch: { initialExpiration: 60 } },
    { name: 'postponed', patch: { postponed: PAGE.body } },
    { name: 'PPR chain', patch: { pprChain: { headers: { 'next-resume': '1' } } } },
    { name: 'partial fallback', patch: { partialFallback: true } },
    { name: 'partially static', patch: { renderingMode: 'PARTIALLY_STATIC' } },
    { name: 'navigation-only forced static', patch: { ensureStatic: 'navigation' } },
    { name: 'loading shell', patch: { routeType: 'fallback' } },
    { name: 'dynamic compute', patch: { compute: 'blocking' } },
    { name: 'initial response', patch: { response: 'initial' } },
    { name: 'error status', patch: { initialStatus: 500 } },
    { name: 'query dependency', patch: { allowQuery: ['token'] } },
    { name: 'custom header dependency', patch: { allowHeader: ['authorization'] } },
    { name: 'JSON twin', patch: { body: { ...BLOB, contentType: 'application/json' } } },
    { name: 'missing body', patch: { body: undefined } },
  ] satisfies { name: string; patch: Partial<Prerender> }[])('refuses $name', ({ patch }) => {
    expect(
      edgeServableStaticPages(bundleOf({ prerenders: [{ ...PAGE, ...patch }] })),
    ).toStrictEqual([]);
  });

  it.each(['app-page', 'pages-api'] as const)('refuses %s source entries', (kind) => {
    expect(
      edgeServableStaticPages(
        bundleOf({ entrypoints: [{ id: 'page', kind, pathname: '/something' }] }),
      ),
    ).toStrictEqual([]);
  });

  it('refuses Edge Pages and dynamic classes', () => {
    expect(
      edgeServableStaticPages(
        bundleOf({
          entrypoints: [{ id: 'page', kind: 'pages', pathname: '/something', runtime: 'edge' }],
        }),
      ),
    ).toStrictEqual([]);

    const dynamic = { ...PAGE, route: '/[slug]' };

    expect(
      edgeServableStaticPages(
        bundleOf({
          prerenders: [dynamic],
          entrypoints: [{ id: 'page', kind: 'pages', pathname: '/[slug]' }],
        }),
      ),
    ).toStrictEqual([]);
  });

  it.each(['', '/docs'])('refuses reserved error pages under %s', (basePath) => {
    for (const suffix of ['/404', '/500', '/_error', '/_global-error', '/_not-found']) {
      const pathname = basePath + suffix;
      const base = bundleOf();

      expect(
        edgeServableStaticPages({
          ...base,
          config: { ...base.config, basePath },
          prerenders: [{ ...PAGE, pathname, route: pathname }],
          entrypoints: [{ id: 'page', kind: 'pages', pathname }],
        }),
      ).toStrictEqual([]);
    }
  });

  it('checks initial and configured privacy before response filtering', () => {
    expect(
      edgeServableStaticPages(
        bundleOf({ prerenders: [{ ...PAGE, initialHeaders: { 'Set-Cookie': 'session=value' } }] }),
      ),
    ).toStrictEqual([]);

    const base = bundleOf();

    expect(
      edgeServableStaticPages({
        ...base,
        routing: {
          ...base.routing,
          beforeMiddleware: [
            { sourceRegex: '^/something$', headers: { 'Cache-Control': 'private' } },
          ],
        },
      }),
    ).toStrictEqual([]);
  });

  it('admits the canonical static Pages home document under a base path', () => {
    const basePath = '/docs';
    const page = { ...PAGE, pathname: basePath, route: basePath };
    const bundle = bundleOf({
      prerenders: [page],
      entrypoints: [{ id: 'page', kind: 'pages', pathname: basePath }],
    });

    expect(
      edgeServableStaticPages({ ...bundle, config: { ...bundle.config, basePath } }),
    ).toStrictEqual([page]);
  });

  it('refuses request-dependent locale routing and malformed base path identities', () => {
    const bundle = bundleOf();

    expect(
      edgeServableStaticPages({
        ...bundle,
        config: { ...bundle.config, i18n: { locales: ['en'], defaultLocale: 'en' } },
      }),
    ).toStrictEqual([]);
    expect(
      edgeServableStaticPages({ ...bundle, config: { ...bundle.config, basePath: '/some' } }),
    ).toStrictEqual([]);
  });

  it('keeps data twins and unclassified siblings outside the proof', () => {
    const twin = {
      ...PAGE,
      id: 'json',
      pathname: '/_next/data/build/something.json',
      routeType: undefined,
      body: { ...BLOB, contentType: 'application/json' },
    };

    expect(edgeServableStaticPages(bundleOf({ prerenders: [PAGE, twin] }))).toStrictEqual([PAGE]);
  });
});

describe('static Pages publication and request boundaries', () => {
  it('preserves legacy manifest bytes and omits an empty table', () => {
    const legacy = manifestOf({ staticPages: undefined });

    expect(serializeManifest(manifestOf({ staticPages: [] }))).toBe(serializeManifest(legacy));
    expect(serializeManifest(legacy)).not.toContain('staticPages');
  });

  it('rejects missing authority, duplicate names and an unreachable Function', () => {
    expect(() => manifestOf({ routes: [] })).toThrow(/authority/u);

    const base = manifestOf();
    const route = base.routes[ENTRY.pathname];

    expect(route).toBeDefined();

    const changed = Object.values(base.routes).map((entry) => {
      return {
        ...entry,
        cache: { entryId: 'another', kind: 'pages' as const, delivery: 'complete' as const },
      };
    });

    expect(() => manifestOf({ routes: changed })).toThrow(/authority/u);
    expect(() => manifestOf({ cache: undefined })).toThrow(/cache/u);
    expect(() => manifestOf({ staticPages: [ENTRY, ENTRY] })).toThrow(/already named/u);
    expect(() => manifestOf({ staticPages: [{ ...ENTRY, function: 'app-2' }] })).toThrow(/app-2/u);
  });

  it('shares exact path, Function and gate identity without accepting a mismatched table key', () => {
    const entry = {
      ...ENTRY,
      pathname: '/caf%C3%A9',
      route: '/caf%C3%A9',
      function: 'app-2' as const,
    };
    const manifest = manifestOf({
      staticPages: [entry],
      routes: [
        {
          pathname: entry.pathname,
          status: 200,
          shell: {
            sha256: 'a'.repeat(64),
            byteLength: 8,
            contentType: 'text/html',
            encoding: 'identity',
          },
          headers: {},
          cache: { entryId: entry.entryId, kind: 'pages', delivery: 'complete' },
          function: 'app-2',
        },
      ],
      app: { deploymentId: 'deployment', scriptName: 'app', functions: { 'app-2': 'second' } },
      gates: { '/caf%C3%A9': 'access' },
      gatedPathnames: { '/caf%C3%A9': '/caf%C3%A9' },
    });
    const url = new URL('https://app.example/caf%C3%A9');

    expect(findStaticPage(manifest, url.pathname)).toStrictEqual(entry);
    expect(functionFor(manifest, url, new Headers())).toBe('app-2');
    expect(gateFor(manifest, url, new Headers())).toStrictEqual({
      route: '/caf%C3%A9',
      name: 'access',
    });
    expect(
      findStaticPage({ ...manifest, staticPages: { '/other': entry } }, '/other'),
    ).toBeUndefined();
  });

  it.each([
    { cookie: 'session=value' },
    { authorization: 'Bearer value' },
    { 'proxy-authorization': 'value' },
    { 'if-none-match': 'tag' },
    { 'if-modified-since': 'yesterday' },
    { 'if-match': 'tag' },
    { 'if-unmodified-since': 'yesterday' },
    { 'if-range': 'tag' },
    { range: 'bytes=0-1' },
    { 'next-resume': '1' },
    { 'x-matched-path': '/other' },
    { 'x-next-revalidated-tags': 'tag' },
    { 'x-next-revalidate-tag-token': 'token' },
    { 'x-prerender-revalidate': 'value' },
  ])('keeps personalized/conditional/internal requests private: %j', (headers) => {
    const manifest = manifestOf();

    expect(
      classifyRequest({
        method: 'GET',
        url: new URL('https://app.example/something'),
        headers: new Headers(headers),
        manifest,
        deployment: manifest.deployment,
      }).kind,
    ).toBe('passthrough');
  });

  it.each(
    [
      'rsc',
      'next-router-state-tree',
      'next-router-prefetch',
      'next-router-segment-prefetch',
      'next-action',
    ].flatMap((name) => ['', '0', '1'].map((value) => ({ name, value }))),
  )('never grants static HTML to a present router header: $name=$value', ({ name, value }) => {
    const manifest = manifestOf();

    expect(
      classifyRequest({
        method: 'GET',
        url: new URL('https://app.example/something'),
        headers: new Headers({ [name]: value }),
        manifest,
        deployment: manifest.deployment,
      }).kind,
    ).not.toBe('static-page');
  });

  it.each(['/_tree', '', '0'])(
    'never grants static HTML to a combined RSC and segment request: %s',
    (segment) => {
      const manifest = manifestOf();

      expect(
        classifyRequest({
          method: 'GET',
          url: new URL('https://app.example/something'),
          headers: new Headers({ rsc: '1', 'next-router-segment-prefetch': segment }),
          manifest,
          deployment: manifest.deployment,
        }).kind,
      ).not.toBe('static-page');
    },
  );

  it.each([
    '/something?foo=bar',
    '/something?dpl=other',
    '/something?__nextDefaultLocale=en',
    '/_next/data/build/something.json',
  ])('never broadens %s to static HTML', (path) => {
    const manifest = manifestOf();

    expect(
      classifyRequest({
        method: 'GET',
        url: new URL(path, 'https://app.example'),
        headers: new Headers(),
        manifest,
        deployment: manifest.deployment,
      }).kind,
    ).toBe('passthrough');
  });

  it('retains route-specific bypass conditions ahead of generic HTML handling', () => {
    const manifest = manifestOf({
      staticPages: [{ ...ENTRY, bypassFor: [{ type: 'header', key: 'x-private' }] }],
    });

    expect(
      classifyRequest({
        method: 'GET',
        url: new URL('https://app.example/something'),
        headers: new Headers({ 'x-private': '1' }),
        manifest,
        deployment: manifest.deployment,
      }),
    ).toStrictEqual({ kind: 'passthrough', reason: 'static-page-bypass' });
  });

  it.each([null, 0, 2, '1', false])(
    'rejects invalid proof %j identically in schema and fast decoder',
    (staticPagePrivacy) => {
      const value = { ...HEADER, staticPagePrivacy };

      expect(packHeaderOf(value)).toBeUndefined();
      expect(generationPackHeaderSchema.safeParse(value).success).toBe(false);
    },
  );

  it('keeps old records unmarked and both decoders agree on version1', () => {
    expect(packHeaderOf(HEADER)).not.toHaveProperty('staticPagePrivacy');

    const value = { ...HEADER, staticPagePrivacy: 1 };

    expect(packHeaderOf(value)).toStrictEqual(generationPackHeaderSchema.parse(value));
  });

  it('retains an optional proof in output storage, without defaulting old output records', () => {
    const output = {
      outputId: 'html',
      representationKey: 'html',
      pathname: '/something',
      status: 200,
      headers: {},
      compute: 'static',
      response: 'complete',
      htmlSize: null,
      artifacts: [],
    };

    expect(outputSnapshotSchema.parse(output)).not.toHaveProperty('staticPagePrivacy');
    expect(outputSnapshotSchema.parse({ ...output, staticPagePrivacy: 1 })).toHaveProperty(
      'staticPagePrivacy',
      1,
    );
    expect(outputSnapshotSchema.safeParse({ ...output, staticPagePrivacy: 2 }).success).toBe(false);
  });
});
