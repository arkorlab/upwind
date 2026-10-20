import { describe, expect, it } from 'vitest';

import { edgeServableRouteBodies } from '../src/bundle/route-bodies.ts';
import {
  type DeploymentBundle,
  deploymentBundleSchema,
  type Prerender,
} from '../src/bundle/schema.ts';
import { KEY_SCHEMA_VERSION } from '../src/cache/keys.ts';
import { generationResponseHeaders } from '../src/cache/response-headers.ts';
import { functionFor } from '../src/manifest/functions.ts';
import { gateFor } from '../src/manifest/gates.ts';
import {
  type BuildProjectManifestInput,
  buildProjectManifest,
  findRouteEntry,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import { findRouteBody } from '../src/manifest/route-bodies.ts';
import type { ProjectManifest, RouteEntry, StaticFileEntry } from '../src/manifest/schema.ts';
import { classifyRequest } from '../src/request/classify.ts';
import { ROUTER_PROTOCOL_HEADERS } from '../src/request/constants.ts';
import { createId } from '../src/util/index.ts';

const GENERATED_AT = '2026-10-19T00:00:00.000Z';
const BODY = { pathname: '/icon', route: '/icon', entryId: 'icon-entry' };
const HTTP_OK = 200;
const BUILD_PROTOCOL = [
  'host',
  'x-matched-path',
  'x-prerender-revalidate',
  'x-prerender-revalidate-if-generated',
  'x-next-revalidated-tags',
  'x-next-revalidate-tag-token',
];
const NAVIGATION = {
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  accept: 'text/html',
};
const HTML: RouteEntry = {
  pathname: '/[id]',
  status: HTTP_OK,
  shell: {
    sha256: 'b'.repeat(64),
    byteLength: 1,
    contentType: 'text/html',
    encoding: 'identity' as const,
  },
  headers: {},
};
const input: BuildProjectManifestInput = {
  projectId: 'project',
  runId: 'run',
  generatedAt: GENERATED_AT,
  originHost: 'app.example',
  deployment: { dplId: 'deployment', assetSetHash: 'assets', observedAt: GENERATED_AT },
  routes: [],
  app: { deploymentId: 'deployment', scriptName: 'app' },
  cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: 'scope' },
  routeBodies: [BODY],
};
const PRERENDER: Prerender = {
  id: 'icon',
  pathname: '/icon',
  route: '/icon',
  parentOutputId: 'icon',
  groupId: 1,
  routeType: 'route',
  response: 'complete',
  compute: 'static',
  initialStatus: HTTP_OK,
  body: { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'image/png' },
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
    routeBodyPrivacy: 2,
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
    entrypoints: [{ id: 'icon', kind: 'app-route', pathname: '/icon' }],
    prerenders: [PRERENDER],
    staticFiles: [],
    functions: { app: FUNCTION },
    ...extra,
  };
}
function request(
  manifest: ProjectManifest,
  headers: HeadersInit = {},
  pathname = '/icon',
  method = 'GET',
) {
  return {
    method,
    url: new URL(pathname, 'https://app.example'),
    headers: new Headers(headers),
    manifest,
    deployment: manifest.deployment,
  };
}

describe('host delivery of a complete route body', () => {
  it.each(
    ROUTER_PROTOCOL_HEADERS.flatMap((name) =>
      ['', '1', 'one, two'].map((value) => ({ name, value })),
    ),
  )(
    'never answers a router-controlled request with a sealed body: $name=$value',
    ({ name, value }) => {
      const manifest = buildProjectManifest(input);

      expect(classifyRequest(request(manifest, { [name]: value })).kind).not.toBe('route-body');
    },
  );

  it('allows an ordinary Host field on a sealed body request', () => {
    const manifest = buildProjectManifest(input);

    expect(classifyRequest(request(manifest, { HOST: 'app.example' })).kind).toBe('route-body');
  });

  it.each(
    BUILD_PROTOCOL.filter((name) => name !== 'host').flatMap((name) =>
      ['', 'control', 'one, two'].map((value) => ({ name, value })),
    ),
  )('keeps a protocol-controlled body in the Function: $name=$value', ({ name, value }) => {
    const manifest = buildProjectManifest(input);

    expect(classifyRequest(request(manifest, { [name]: value })).kind).toBe('passthrough');
  });

  it('does not interpret an RSC segment request as a complete image body', () => {
    const manifest = buildProjectManifest(input);

    expect(
      classifyRequest(request(manifest, { rsc: '1', 'next-router-segment-prefetch': '/segment' }))
        .kind,
    ).toBe('passthrough');

    const document = buildProjectManifest({ ...input, routeBodies: [], routes: [HTML] });

    expect(
      classifyRequest(
        request(document, { rsc: '1', 'next-router-segment-prefetch': '/segment' }, '/page'),
      ).kind,
    ).toBe('segment-prefetch');
  });

  it.each(['GET', 'HEAD'])('classifies %s without browser document navigation hints', (method) => {
    const manifest = buildProjectManifest(input);

    expect(
      classifyRequest(request(manifest, { 'sec-fetch-dest': 'image' }, '/icon', method)),
    ).toStrictEqual({ kind: 'route-body', entry: BODY });
  });

  it('preserves old manifest bytes when the new map is absent or empty, and roundtrips the new map', () => {
    const legacy = buildProjectManifest({ ...input, routeBodies: undefined });
    const empty = buildProjectManifest({ ...input, routeBodies: [] });
    const manifest = buildProjectManifest(input);

    expect(serializeManifest(empty)).toBe(serializeManifest(legacy));
    expect(serializeManifest(legacy)).not.toContain('routeBodies');
    expect(parseProjectManifest(serializeManifest(manifest))).toStrictEqual(manifest);
    expect(manifest.schemaVersion).toBe(legacy.schemaVersion);
  });

  it('rejects missing authority, duplicate names, and unreachable Functions', () => {
    expect(() => buildProjectManifest({ ...input, cache: undefined })).toThrow(/cache/u);
    expect(() => buildProjectManifest({ ...input, routeBodies: [BODY, BODY] })).toThrow(
      /already named/u,
    );
    expect(() =>
      buildProjectManifest({ ...input, routeBodies: [{ ...BODY, function: 'app-2' }] }),
    ).toThrow(/app-2/u);
  });

  it('finds the exact encoded route and its owning Function without accepting a mismatched map key', () => {
    const body = { ...BODY, pathname: '/café', function: 'app-2' as const };
    const manifest = buildProjectManifest({
      ...input,
      routeBodies: [body],
      app: { ...input.app, functions: { 'app-2': 'images' } },
    });
    const asked = request(manifest, {}, '/caf%C3%A9');

    expect(findRouteBody(manifest, asked.url.pathname)).toStrictEqual(body);
    expect(functionFor(manifest, asked.url, asked.headers)).toBe('app-2');
    expect(
      findRouteBody({ ...manifest, routeBodies: { '/other': body } }, '/other'),
    ).toBeUndefined();
  });

  it.each([
    { document: '/docs/a/b', body: '/docs/a%2Fb', winner: 'document' },
    { document: '/docs/a%2Fb', body: '/docs/a/b', winner: 'route-body' },
  ])(
    'shares the filesystem winner across classification, Function and gate: $winner',
    ({ document, body, winner }) => {
      const own = winner === 'document' ? document : body;
      const manifest = buildProjectManifest({
        ...input,
        routes: [{ ...HTML, pathname: document, function: 'app-2' }],
        routeBodies: [
          {
            ...BODY,
            pathname: body,
            route: winner === 'route-body' ? body : '/docs/[slug]',
            function: 'app-3',
          },
        ],
        app: { ...input.app, functions: { 'app-2': 'documents', 'app-3': 'images' } },
        filesystemPages: [own],
        dynamicRoutes: [{ sourceRegex: '^/docs/([^/]+?)$', route: '/docs/[slug]' }],
        gates: { [document]: 'document-access', [body]: 'body-access' },
        gatedPathnames: { [document]: document, [body]: body },
      });
      const asked = request(manifest, NAVIGATION, '/docs/a%2Fb');
      const isDocument = winner === 'document';

      expect({
        kind: classifyRequest(asked).kind,
        document: findRouteEntry(manifest, asked.url.pathname)?.pathname,
        body: findRouteBody(manifest, asked.url.pathname)?.pathname,
        function: functionFor(manifest, asked.url, asked.headers),
        gate: gateFor(manifest, asked.url, asked.headers),
      }).toStrictEqual({
        kind: winner,
        document: isDocument ? document : undefined,
        body: isDocument ? undefined : body,
        function: isDocument ? 'app-2' : 'app-3',
        gate: { route: own, name: isDocument ? 'document-access' : 'body-access' },
      });
    },
  );

  it('shares the filesystem winner when an exact page has no hosted response', () => {
    const member = '/docs/a%2Fb';
    const own = '/docs/a/b';
    const manifest = buildProjectManifest({
      ...input,
      routeBodies: [{ ...BODY, pathname: member, route: '/docs/[slug]', function: 'app-2' }],
      app: { ...input.app, functions: { 'app-2': 'images' } },
      exactPathnames: [own],
      filesystemPages: [own],
      dynamicRoutes: [{ sourceRegex: '^/docs/([^/]+?)$', route: '/docs/[slug]' }],
      gates: { [own]: 'page-access', [member]: 'body-access' },
      gatedPathnames: { [own]: own, [member]: member },
    });
    const asked = request(manifest, NAVIGATION, '/docs/a%2Fb');

    expect({
      classification: classifyRequest(asked),
      body: findRouteBody(manifest, asked.url.pathname),
      function: functionFor(manifest, asked.url, asked.headers),
      gate: gateFor(manifest, asked.url, asked.headers),
    }).toStrictEqual({
      classification: { kind: 'passthrough', reason: 'route-not-proved' },
      body: undefined,
      function: 'app',
      gate: { route: own, name: 'page-access' },
    });
  });

  it.each([
    { headers: { range: 'bytes=0-1' }, reason: 'range' },
    { headers: { 'service-worker': 'script' }, reason: 'service-worker' },
    { headers: { 'x-nextjs-data': '1' }, reason: 'internal-header' },
    { headers: { cookie: '__prerender_bypass=preview' }, reason: 'bypass-cookie' },
    { headers: { 'x-deployment-id': 'other' }, reason: 'internal-header' },
  ])('keeps the request bypass $reason', ({ headers, reason }) => {
    const manifest = buildProjectManifest(input);

    expect(classifyRequest(request(manifest, headers))).toStrictEqual({
      kind: 'passthrough',
      reason,
    });
  });

  it('never falls through a bypassed body to an HTML class, and preserves method, query and routing gates', () => {
    const manifest = buildProjectManifest({
      ...input,
      routeBodies: [{ ...BODY, bypassFor: [{ type: 'header', key: 'x-private' }] }],
      routes: [HTML],
      dynamicRoutes: [{ sourceRegex: '^/([^/]+)$', route: '/[id]' }],
    });

    expect(classifyRequest(request(manifest, { ...NAVIGATION, 'x-private': 'yes' }))).toStrictEqual(
      {
        kind: 'passthrough',
        reason: 'route-body-bypass',
      },
    );
    expect(classifyRequest(request(manifest, {}, '/icon?dpl=other'))).toStrictEqual({
      kind: 'passthrough',
      reason: 'dpl-mismatch',
    });
    expect(classifyRequest(request(manifest, {}, '/icon', 'POST'))).toStrictEqual({
      kind: 'passthrough',
      reason: 'method',
    });

    const withoutBodies = buildProjectManifest({
      ...input,
      routeBodies: undefined,
      routes: [HTML],
      dynamicRoutes: manifest.dynamicRoutes,
    });

    expect(classifyRequest(request(withoutBodies, NAVIGATION)).kind).toBe('document');

    const gated = buildProjectManifest({
      ...input,
      gates: { '/icon': 'image-access' },
      gatedPathnames: { '/icon': '/icon' },
    });

    expect(gateFor(gated, new URL('https://app.example/icon'), new Headers())).toStrictEqual({
      route: '/icon',
      name: 'image-access',
    });
    expect(
      classifyRequest(
        request({ ...manifest, reservedRoutes: [{ sourceRegex: '^/icon$', beforeFiles: true }] }),
      ),
    ).toStrictEqual({ kind: 'passthrough', reason: 'route-body-bypass' });
  });
});

describe('kept file status under a base path', () => {
  it.each([404, 500])("does not give the previous asset this build's status %s", (status) => {
    const pathname = `/_next/static/prior/${status}`;
    const previous = {
      sha256: 'c'.repeat(64),
      byteLength: 3,
      contentType: 'text/html',
      deploymentId: 'previous',
    };
    const file: StaticFileEntry = {
      sha256: 'd'.repeat(64),
      byteLength: 4,
      contentType: 'text/html',
      immutable: false,
      status,
      previous,
    };
    const manifest = buildProjectManifest({ ...input, staticFiles: { [pathname]: file } });

    expect(classifyRequest(request(manifest, {}, `${pathname}?dpl=previous`))).toStrictEqual({
      kind: 'static-file',
      pathname,
      file: { ...previous, immutable: false },
    });
    expect(classifyRequest(request(manifest, {}, pathname))).toStrictEqual({
      kind: 'static-file',
      pathname,
      file,
    });
    expect(classifyRequest(request(manifest, {}, `${pathname}?dpl=deployment`))).toStrictEqual({
      kind: 'static-file',
      pathname,
      file,
    });
    expect(classifyRequest(request(manifest, {}, `${pathname}?dpl=unknown`))).toStrictEqual({
      kind: 'passthrough',
      reason: 'dpl-mismatch',
    });
  });

  it('retains absent status and the current bytes of a content-addressed file', () => {
    const pathname = '/docs/asset';
    const previous = {
      sha256: 'e'.repeat(64),
      byteLength: 1,
      contentType: 'text/plain',
      deploymentId: 'previous',
    };
    const file: StaticFileEntry = {
      ...previous,
      deploymentId: 'deployment',
      immutable: false,
      previous,
    };
    const manifest = buildProjectManifest({ ...input, staticFiles: { [pathname]: file } });
    const immutable = { ...file, immutable: true };
    const shared = buildProjectManifest({ ...input, staticFiles: { [pathname]: immutable } });

    expect(classifyRequest(request(manifest, {}, `${pathname}?dpl=previous`))).toStrictEqual({
      kind: 'static-file',
      pathname,
      file: { ...previous, immutable: false },
    });
    expect(classifyRequest(request(shared, {}, `${pathname}?dpl=previous`))).toStrictEqual({
      kind: 'static-file',
      pathname,
      file: immutable,
    });
  });
});

describe('sealed route-body eligibility', () => {
  it.each(
    [
      ...BUILD_PROTOCOL.map((name) => [name]),
      BUILD_PROTOCOL,
      BUILD_PROTOCOL.map((name) => name.toUpperCase()),
    ].map((allowHeader) => ({ allowHeader })),
  )('admits only build-owned protocol inputs: %j', ({ allowHeader }) => {
    const page = { ...PRERENDER, allowHeader };

    expect(edgeServableRouteBodies(bundleOf({ prerenders: [page] }))).toStrictEqual([page]);
  });

  it.each(['authorization', 'cookie', 'x-visitor', 'rsc', 'next-router-segment-prefetch'])(
    'rejects a mixed protocol and application-dependent header: %s',
    (name) => {
      expect(
        edgeServableRouteBodies(
          bundleOf({ prerenders: [{ ...PRERENDER, allowHeader: [...BUILD_PROTOCOL, name] }] }),
        ),
      ).toStrictEqual([]);
    },
  );

  it('requires the bundled privacy contract; old bundles remain byte-identical and unsupported', () => {
    const modern = deploymentBundleSchema.parse(bundleOf());
    const old = deploymentBundleSchema.parse(bundleOf({ routeBodyPrivacy: undefined }));
    const serialized = JSON.stringify(old);
    const previous = deploymentBundleSchema.parse(bundleOf({ routeBodyPrivacy: 1 }));

    expect(edgeServableRouteBodies(modern)).toStrictEqual([PRERENDER]);
    expect(edgeServableRouteBodies(previous)).toStrictEqual([]);

    const headerKeyed = deploymentBundleSchema.parse(
      bundleOf({ prerenders: [{ ...PRERENDER, allowHeader: ['authorization'] }] }),
    );

    expect(headerKeyed.prerenders[0]?.allowHeader).toStrictEqual(['authorization']);
    expect(edgeServableRouteBodies(headerKeyed)).toStrictEqual([]);
    expect(edgeServableRouteBodies(deploymentBundleSchema.parse(old))).toStrictEqual([]);
    expect(JSON.stringify(deploymentBundleSchema.parse(old))).toBe(serialized);
    expect(() => deploymentBundleSchema.parse({ ...old, routeBodyPrivacy: 3 })).toThrow(
      /routeBodyPrivacy/u,
    );
  });

  it.each<Partial<Prerender>>([
    { routeType: undefined },
    { response: 'initial' },
    { compute: 'resuming' },
    { pathname: '/[id]' },
    { initialStatus: 201 },
    { body: undefined },
    { postponed: PRERENDER.body },
    { allowQuery: ['key'] },
    { allowHeader: ['authorization'] },
    { body: { ...PRERENDER.body!, contentType: 'text/html; charset=utf-8' } },
    { initialHeaders: { 'Content-Type': 'application/xhtml+xml' } },
    { initialHeaders: { 'Cache-Control': 'private, max-age=60' } },
    { initialHeaders: { 'Cache-Control': 'public, no-store' } },
    { initialHeaders: { 'Set-Cookie': ['session=private'] } },
    { initialHeaders: { Vary: '*' } },
    { initialHeaders: { Connection: 'cache-control', 'Cache-Control': 'public' } },
    { initialHeaders: { 'Cloudflare-CDN-Cache-Control': 'private' } },
    { initialHeaders: { 'Content-Encoding': 'gzip' } },
    { initialHeaders: { 'Content-Range': 'bytes 0-1/2' } },
  ])('keeps an unsupported or personalized output in the Function: %j', (extra) => {
    expect(
      edgeServableRouteBodies(bundleOf({ prerenders: [{ ...PRERENDER, ...extra }] })),
    ).toStrictEqual([]);
  });

  it.each([
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    { headers: { 'Cache-Control': 'private' } },
    { headers: { 'Content-Encoding': 'gzip' } },
  ])('checks the effective response headers used to seed a generation: %j', ({ headers }) => {
    const bundle = bundleOf();
    const configured = {
      ...bundle,
      routing: {
        ...bundle.routing,
        onMatch: [{ source: '/icon', sourceRegex: '^/icon$', headers }],
      },
    };

    expect(edgeServableRouteBodies(configured)).toStrictEqual([]);
  });

  it('leaves unsupported locale routing and its conditional privacy rules to the Function', () => {
    const bundle = bundleOf();
    const localized = {
      ...bundle,
      config: { ...bundle.config, i18n: { defaultLocale: 'en', locales: ['en', 'ja'] } },
      routing: {
        ...bundle.routing,
        beforeFiles: [{ source: '/icon', sourceRegex: '^/icon$', destination: '/private' }],
        onMatch: [
          {
            source: '/icon',
            sourceRegex: '^/icon$',
            has: [{ type: 'header' as const, key: 'authorization' }],
            headers: { 'cache-control': 'private' },
          },
        ],
      },
    };

    expect(edgeServableRouteBodies(localized)).toStrictEqual([]);
  });

  it('keeps Edge and non-app-route handlers outside the new host path', () => {
    expect(
      edgeServableRouteBodies(
        bundleOf({
          entrypoints: [{ id: 'icon', pathname: '/icon', kind: 'app-route', runtime: 'edge' }],
        }),
      ),
    ).toStrictEqual([]);
    expect(
      edgeServableRouteBodies(
        bundleOf({ entrypoints: [{ id: 'icon', pathname: '/icon', kind: 'pages-api' }] }),
      ),
    ).toStrictEqual([]);
  });
});

describe('stored route-body privacy', () => {
  it('keeps the original cache-control veto without changing page header storage', () => {
    const headers: [string, string][] = [
      ['cache-control', 'private, max-age=60'],
      ['content-type', 'image/png'],
      ['etag', 'version'],
    ];

    expect(generationResponseHeaders('app-route', HTTP_OK, headers)).toStrictEqual({
      'cache-control': 'private, max-age=60',
      'content-type': 'image/png',
      etag: 'version',
    });
    expect(generationResponseHeaders('app-page', HTTP_OK, headers)).not.toHaveProperty(
      'cache-control',
    );
  });

  it.each(
    [
      [['set-cookie', 'session=never-store-this']],
      [
        ['connection', 'cache-control'],
        ['cache-control', 'public'],
      ],
      [
        ['connection', 'vary'],
        ['vary', '*'],
      ],
      [['cloudflare-cdn-cache-control', 'no-store']],
      [['content-encoding', 'gzip']],
      [['content-range', 'bytes 0-1/2']],
    ].map((headers) => ({ headers: headers as [string, string][] })),
  )(
    'records only a deny signal for stripped privacy or representation headers: %j',
    ({ headers }) => {
      const kept = generationResponseHeaders('app-route', HTTP_OK, headers);

      expect(kept['cache-control']).toBe('private, no-store');
      expect(kept).not.toHaveProperty('set-cookie');
      expect(JSON.stringify(kept)).not.toContain('never-store-this');
    },
  );
});
