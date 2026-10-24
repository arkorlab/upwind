import { describe, expect, it } from 'vitest';

import { buildProjectManifest } from '../src/manifest/manifest.ts';
import type { ProjectManifest, RouteEntry } from '../src/manifest/schema.ts';
import { classifyRequest } from '../src/request/classify.ts';

const ROUTE = '/items/[id]';
const MEMBER = '/items/known';
const DEPLOYMENT = {
  dplId: 'dpl_payload',
  assetSetHash: 'set',
  observedAt: '2026-10-08T00:00:00Z',
};
const CLASS_ENTRY: RouteEntry = {
  pathname: ROUTE,
  status: 200,
  headers: {},
  shell: { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/html', encoding: 'identity' },
  cache: { entryId: 'class_entry', kind: 'app-page', delivery: 'resume' },
};

function manifestOf(
  options: { shell?: boolean; cache?: boolean; kind?: 'app-page' | 'pages' } = {},
) {
  return buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    generatedAt: DEPLOYMENT.observedAt,
    originHost: 'example.com',
    deployment: DEPLOYMENT,
    app: { deploymentId: DEPLOYMENT.dplId, scriptName: 'app' },
    routes: options.shell === true ? [CLASS_ENTRY] : [],
    dynamicRoutes: [
      {
        sourceRegex: '^/items/(?<id>[^/]+?)(?:/)?$',
        route: ROUTE,
        members: { route: ROUTE, kind: options.kind ?? 'app-page' },
      },
    ],
    ...(options.cache !== false && { cache: { keySchemaVersion: 1, scopeId: DEPLOYMENT.dplId } }),
  });
}

function payload(site: ProjectManifest, pathname = MEMBER, headers: Record<string, string> = {}) {
  return classifyRequest({
    method: 'GET',
    url: new URL(pathname, 'https://example.com'),
    headers: new Headers({ rsc: '1', ...headers }),
    manifest: site,
    deployment: DEPLOYMENT,
  });
}

describe('cache-backed dynamic Flight candidates', () => {
  it('selects an App Router member with no class shell for the host to check', () => {
    expect(payload(manifestOf())).toStrictEqual({ kind: 'rsc-payload', entry: undefined });
  });

  it('keeps a class shell as a candidate without claiming a concrete generation exists', () => {
    const site = manifestOf({ shell: true });

    expect(payload(site)).toStrictEqual({ kind: 'rsc-payload', entry: site.routes[ROUTE] });
  });

  it.each([{ cache: false }, { kind: 'pages' as const }])(
    'leaves members without App Router generation support to the Function: %j',
    (options) => {
      expect(payload(manifestOf(options)).kind).toBe('rsc');
    },
  );

  it.each(['/other', '/items/%E0', '/items//known'])('rejects a non-member %s', (pathname) => {
    expect(payload(manifestOf(), pathname).kind).toBe('rsc');
  });

  it.each([
    { 'next-resume': '1' },
    { 'x-deployment-id': 'dpl_old' },
    { cookie: '__prerender_bypass=1' },
  ])('preserves router bypasses for an unshelled member: %j', (headers) => {
    expect(payload(manifestOf(), MEMBER, headers).kind).toBe('rsc');
  });

  it('does not bypass an exact pathname or an earlier routing rule', () => {
    const site = manifestOf();

    expect(payload({ ...site, exactPathnames: { [MEMBER]: true } }).kind).toBe('rsc');
    expect(
      payload({
        ...site,
        reservedRoutes: [{ sourceRegex: '^/items/known$', beforeFiles: true }],
      }).kind,
    ).toBe('rsc');
    expect(
      payload({
        ...site,
        dynamicRoutes: [{ sourceRegex: '^/items/known$' }, ...site.dynamicRoutes!],
      }).kind,
    ).toBe('rsc');
  });
});
