import { describe, expect, it } from 'vitest';

import { KEY_SCHEMA_VERSION } from '../src/cache/keys.ts';
import { functionFor } from '../src/manifest/functions.ts';
import { gateFor } from '../src/manifest/gates.ts';
import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
  type BuildProjectManifestInput,
} from '../src/manifest/manifest.ts';
import type { PagesFallbackEntry, StaticPageEntry } from '../src/manifest/schema.ts';
import { classifyRequest } from '../src/request/classify.ts';
import { FALLBACK_ROUTE } from './fallback-pages-fixtures.ts';

const HTML = {
  sha256: 'a'.repeat(64),
  byteLength: 100,
  contentType: 'text/html',
  encoding: 'identity' as const,
};
const MEMBER: StaticPageEntry = {
  staticPagePrivacy: 3,
  pathname: '/fallback-true/first',
  route: FALLBACK_ROUTE,
  entryId: 'member',
  parameters: { slug: 'first' },
  dataPathname: '/_next/data/build/fallback-true/first.json',
};
const FALLBACK: PagesFallbackEntry = {
  staticPagePrivacy: 3,
  route: FALLBACK_ROUTE,
  dataPathname: '/_next/data/build/fallback-true/[slug].json',
  shell: { artifact: HTML },
  headers: {},
};
function inputOf(extra: Partial<BuildProjectManifestInput> = {}): BuildProjectManifestInput {
  return {
    projectId: 'project',
    runId: 'run',
    generatedAt: '2026-10-20T00:00:00.000Z',
    originHost: 'app.example',
    deployment: {
      dplId: 'deployment',
      assetSetHash: 'assets',
      observedAt: '2026-10-20T00:00:00.000Z',
    },
    routes: [
      {
        pathname: MEMBER.pathname,
        status: 200,
        shell: HTML,
        headers: {},
        cache: { kind: 'pages', entryId: 'member', route: FALLBACK_ROUTE, delivery: 'complete' },
      },
      {
        pathname: FALLBACK_ROUTE,
        status: 200,
        shell: HTML,
        headers: {},
      },
    ],
    app: { deploymentId: 'deployment', scriptName: 'app' },
    cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: 'scope' },
    pagesDataUnder: { basePath: '', buildId: 'build' },
    staticPages: [MEMBER],
    pagesFallbacks: [FALLBACK],
    dynamicRoutes: [{ sourceRegex: '^/fallback-true/([^/]+?)(?:/)?$', route: FALLBACK_ROUTE }],
    ...extra,
  };
}
function classify(
  pathname: string,
  headers: Record<string, string> = {},
  extra: Partial<BuildProjectManifestInput> = {},
) {
  const manifest = buildProjectManifest(inputOf(extra));
  return classifyRequest({
    method: 'GET',
    url: new URL(`https://app.example${pathname}`),
    headers: new Headers(headers),
    manifest,
    deployment: manifest.deployment,
  });
}

describe('version 3 Pages manifest and representation routing', () => {
  it('round-trips a separate immutable loading authority with no class entry ID or marker', () => {
    const manifest = buildProjectManifest(inputOf());

    expect(parseProjectManifest(serializeManifest(manifest))).toStrictEqual(manifest);
    expect(manifest.pagesFallbacks?.[FALLBACK_ROUTE]).toStrictEqual(FALLBACK);
    expect(manifest.pagesFallbacks?.[FALLBACK_ROUTE]).not.toHaveProperty('entryId');
    expect(manifest.routes[FALLBACK_ROUTE]).not.toHaveProperty('staticPagePrivacy');
    expect(manifest.routes[FALLBACK_ROUTE]).not.toHaveProperty('cache');
    expect(manifest.pagesDataPrefix).toBe('/_next/data/build');
  });

  it('rejects loading bytes that pretend to own a concrete cache generation', () => {
    const input = inputOf();
    const routes = input.routes.map((route) => {
      return route.pathname === FALLBACK_ROUTE
        ? {
            ...route,
            cache: { kind: 'pages' as const, entryId: 'fabricated', delivery: 'complete' as const },
          }
        : route;
    });

    expect(() => buildProjectManifest({ ...input, routes })).toThrow(/loading shell/u);
  });

  it('classifies HTML and canonical build-scoped props as the same concrete member', () => {
    expect(classify('/fallback-true/first')).toStrictEqual({ kind: 'static-page', entry: MEMBER });
    expect(
      classify('/_next/data/build/fallback-true/first.json', { 'x-nextjs-data': '1' }),
    ).toStrictEqual({ kind: 'static-page', entry: MEMBER, representation: 'pages-data' });
  });

  it('keeps an unbuilt HTML request distinct from the concrete props it still needs', () => {
    const common = {
      entry: FALLBACK,
      parameters: { slug: 'second' },
      pathname: '/fallback-true/second',
      dataPathname: '/_next/data/build/fallback-true/second.json',
    };

    expect(classify('/fallback-true/second')).toStrictEqual({
      kind: 'pages-fallback',
      ...common,
      representation: 'html',
    });
    expect(
      classify('/_next/data/build/fallback-true/second.json', { 'x-nextjs-data': '1' }),
    ).toStrictEqual({ kind: 'pages-fallback', ...common, representation: 'pages-data' });
  });

  it.each([
    'authorization',
    'cookie',
    'if-none-match',
    'if-modified-since',
    'x-prerender-revalidate',
    'x-matched-path',
    'rsc',
    'next-router-prefetch',
    'next-router-state-tree',
    'next-router-segment-prefetch',
    'next-action',
    'next-url',
  ])('keeps %s private for both representations', (header) => {
    for (const pathname of [
      '/fallback-true/first',
      '/fallback-true/second',
      '/_next/data/build/fallback-true/first.json',
      '/_next/data/build/fallback-true/second.json',
    ]) {
      expect(classify(pathname, { [header]: '1' }).kind).toBe('passthrough');
    }
  });

  it.each([
    '/fallback-true/first?visitor=1',
    '/fallback-true/second?slug=other',
    '/fallback-true/%66irst',
    '/fallback-true/first/',
    '/_next/data/other/fallback-true/first.json',
    '/_next/data/build/fallback-true/%66irst.json',
  ])('does not grant authority through %s', (pathname) => {
    expect(['static-page', 'pages-fallback']).not.toContain(classify(pathname).kind);
  });

  it('does not send loading bytes to a bot or a client router HTML request', () => {
    expect(classify('/fallback-true/second', { 'user-agent': 'Googlebot' }).kind).toBe(
      'passthrough',
    );
    expect(classify('/fallback-true/second', { 'x-nextjs-data': '1' }).kind).toBe('passthrough');
  });

  it('uses the first native owner and protects exact or reserved routes before a fallback', () => {
    expect(
      classify('/fallback-true/second', {}, { exactPathnames: ['/fallback-true/second'] }).kind,
    ).not.toBe('pages-fallback');
    expect(
      classify(
        '/fallback-true/second',
        {},
        {
          dynamicRoutes: [
            { sourceRegex: '^/fallback-true/([^/]+?)$', route: '/other/[slug]' },
            ...inputOf().dynamicRoutes!,
          ],
        },
      ).kind,
    ).not.toBe('pages-fallback');
    expect(
      classify(
        '/_next/data/build/fallback-true/first.json',
        {},
        {
          reservedRoutes: [
            { sourceRegex: '^/_next/data/build/fallback-true/first.json$', beforeFiles: true },
          ],
        },
      ).kind,
    ).toBe('passthrough');
  });

  it.each([
    { staticPages: [{ ...MEMBER, parameters: { slug: 'other' } }] },
    { staticPages: [{ ...MEMBER, dataPathname: '/_next/data/other/fallback-true/first.json' }] },
    {
      pagesFallbacks: [
        { ...FALLBACK, dataPathname: '/_next/data/other/fallback-true/[slug].json' },
      ],
    },
    { pagesFallbacks: [{ ...FALLBACK, shell: { artifact: { ...HTML, sha256: 'b'.repeat(64) } } }] },
    { pagesFallbacks: [FALLBACK, FALLBACK] },
    { pagesDataUnder: undefined },
  ])('rejects an inconsistent publication: %j', (extra) => {
    expect(() => buildProjectManifest(inputOf(extra))).toThrow(/paired|loading|pagesDataUnder/u);
  });

  it('keeps both data representations on their declared split Function and gate', () => {
    const input = inputOf({
      app: { deploymentId: 'deployment', scriptName: 'app', functions: { 'app-2': 'docs' } },
      routes: inputOf().routes.map((route) => ({ ...route, function: 'app-2' })),
      staticPages: [{ ...MEMBER, function: 'app-2' }],
      pagesFallbacks: [{ ...FALLBACK, function: 'app-2' }],
      dynamicRoutes: [
        {
          sourceRegex: '^/fallback-true/([^/]+?)$',
          route: FALLBACK_ROUTE,
          function: 'app-2',
          gated: FALLBACK_ROUTE,
        },
      ],
      gates: { [FALLBACK_ROUTE]: 'allow' },
      gatedPathnames: { [MEMBER.pathname]: FALLBACK_ROUTE },
    });
    const manifest = buildProjectManifest(input);
    for (const path of [
      '/_next/data/build/fallback-true/first.json',
      '/_next/data/build/fallback-true/second.json',
    ]) {
      const url = new URL(`https://app.example${path}`);

      expect(functionFor(manifest, url, new Headers())).toBe('app-2');
      expect(gateFor(manifest, url, new Headers())).toStrictEqual({
        route: FALLBACK_ROUTE,
        name: 'allow',
      });
    }
  });
});
