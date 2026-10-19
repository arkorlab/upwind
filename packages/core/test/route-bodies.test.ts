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
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import { findRouteBody } from '../src/manifest/route-bodies.ts';
import type { ProjectManifest, RouteEntry } from '../src/manifest/schema.ts';
import { classifyRequest } from '../src/request/classify.ts';
import { createId } from '../src/util/index.ts';

const GENERATED_AT = '2026-10-19T00:00:00.000Z';
const BODY = { pathname: '/icon', route: '/icon', entryId: 'icon-entry' };
const HTTP_OK = 200;
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
    routeBodyPrivacy: 1,
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

    const withoutBodies = { ...manifest, routeBodies: undefined };

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

describe('sealed route-body eligibility', () => {
  it('requires the bundled privacy contract; old bundles remain byte-identical and unsupported', () => {
    const modern = deploymentBundleSchema.parse(bundleOf());
    const old = deploymentBundleSchema.parse(bundleOf({ routeBodyPrivacy: undefined }));
    const serialized = JSON.stringify(old);

    expect(edgeServableRouteBodies(modern)).toStrictEqual([PRERENDER]);

    const headerKeyed = deploymentBundleSchema.parse(
      bundleOf({ prerenders: [{ ...PRERENDER, allowHeader: ['authorization'] }] }),
    );

    expect(headerKeyed.prerenders[0]?.allowHeader).toStrictEqual(['authorization']);
    expect(edgeServableRouteBodies(headerKeyed)).toStrictEqual([]);
    expect(edgeServableRouteBodies(deploymentBundleSchema.parse(old))).toStrictEqual([]);
    expect(JSON.stringify(deploymentBundleSchema.parse(old))).toBe(serialized);
    expect(() => deploymentBundleSchema.parse({ ...old, routeBodyPrivacy: 2 })).toThrow(
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
