import { describe, expect, it } from 'vitest';

import { declaredRouteGates, gatedPathnamesOf, ROUTE_GATES_ENV } from '../src/bundle/gates.ts';
import { type DeploymentBundle, deploymentBundleSchema } from '../src/bundle/schema.ts';
import { dynamicRouting } from '../src/bundle/serving.ts';
import { gateFor } from '../src/manifest/gates.ts';
import { type BuildProjectManifestInput, buildProjectManifest } from '../src/manifest/manifest.ts';
import type { DynamicRoute, ProjectManifest } from '../src/manifest/schema.ts';
import { createId } from '../src/util/index.ts';

/**
 * The gates a build declares for its routes (`ROUTE_GATES_ENV`): read off the environment, held to
 * the routes the build has, carried into the manifest beside what finds a request's gate by, and
 * found for a request the way Next.js finds its route (`gateFor`).
 */

const GENERATED_AT = '2026-10-16T00:00:00.000Z';
const POST = '/posts/[slug]';
const AUTHOR = '/authors/[slug]';
/** `/posts/[slug]` as 16.4 collapses a page and its data into one entry of the table. */
const POST_ENTRY = {
  source: POST,
  sourceRegex: String.raw`^/posts/(?<nxtPslug>[^/]+?)(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`,
  destination: '/posts/[slug]$2?nxtPslug=$nxtPslug',
};
const AUTHOR_ENTRY = {
  source: AUTHOR,
  sourceRegex: '^/authors/(?<nxtPslug>[^/]+?)(?:/)?$',
  destination: '/authors/[slug]?nxtPslug=$nxtPslug',
};
const FILE = { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/plain' };

/** A build of a few pages, two of them dynamic, with `gates` declared as given. */
function bundleOf(extra: Partial<DeploymentBundle> = {}): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: GENERATED_AT,
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
      dynamicRoutes: [POST_ENTRY, AUTHOR_ENTRY],
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
      { id: '/', kind: 'app-page', pathname: '/' },
      { id: '/posts/new', kind: 'app-page', pathname: '/posts/new' },
      { id: POST, kind: 'app-page', pathname: POST },
      { id: AUTHOR, kind: 'app-page', pathname: AUTHOR },
    ],
    prerenders: [
      { id: 'demo', pathname: '/posts/demo', route: POST, parentOutputId: 'demo', groupId: 1 },
      {
        id: 'demo.rsc',
        pathname: '/posts/demo.rsc',
        route: POST,
        parentOutputId: 'demo',
        groupId: 1,
      },
    ],
    staticFiles: [{ pathname: '/robots.txt', blob: FILE, immutable: false }],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
    ...extra,
  };
}

/** What the schema says is wrong with a bundle, by message. */
function refusals(bundle: DeploymentBundle): string[] {
  const parsed = deploymentBundleSchema.safeParse(bundle);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

/** The manifest a deployment of `bundle` publishes, as far as finding a gate goes. */
function manifestOf(
  bundle: DeploymentBundle,
  extra: Partial<BuildProjectManifestInput> = {},
): ProjectManifest {
  const routing = dynamicRouting(bundle, new Set());
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: GENERATED_AT,
    originHost: 'app.example',
    deployment: { dplId: bundle.deploymentId, assetSetHash: 'h', observedAt: GENERATED_AT },
    routes: [],
    app: { deploymentId: bundle.deploymentId, scriptName: 'app' },
    ...routing,
    gates: bundle.gates,
    gatedPathnames: gatedPathnamesOf(bundle),
    ...extra,
  });
}

function gateOf(manifest: ProjectManifest, path: string) {
  return gateFor(manifest, new URL(path, 'https://app.example'), new Headers());
}

const GATES = { [POST]: 'checker' };

describe('the gates a build declares in its environment', () => {
  it.each([[undefined], [''], ['  '], ['{}']])('declares none for %j', (raw) => {
    expect(declaredRouteGates(raw)).toBeUndefined();
  });

  it('reads an object of each route to the name of its gate', () => {
    expect(declaredRouteGates(JSON.stringify(GATES))).toStrictEqual(GATES);
  });

  /** A declaration read as none would serve the route to every visitor, no gate asked. */
  it.each([
    ['{', /is not JSON/u],
    ['[]', /each route to the name of its gate/u],
    ['"checker"', /each route to the name of its gate/u],
    ['{"/posts/[slug]":"Checker"}', /gate name/u],
    ['{"/posts/[slug]":"a_b"}', /gate name/u],
    ['{"posts":"checker"}', /expected a route/u],
    ['{"/ボード":"checker"}', /expected a route/u],
  ])('refuses %j, saying what is wrong with it', (raw, said) => {
    expect(() => declaredRouteGates(raw)).toThrow(said);
    expect(() => declaredRouteGates(raw)).toThrow(ROUTE_GATES_ENV);
  });
});

describe('the gates a bundle carries', () => {
  it('takes a gate of a route the build has', () => {
    expect(refusals(bundleOf({ gates: GATES }))).toStrictEqual([]);
  });

  /** Each is a route that would be served to every visitor with no gate asked. */
  it.each([
    ['declares no gate', {}, /declares no gate/u],
    ['names no route of the build', { '/posts/[id]': 'checker' }, /no route of this build/u],
    ['names a file the build ships', { '/robots.txt': 'checker' }, /ships as a file/u],
  ])('refuses one that %s', (_, gates, said) => {
    const [refusal] = refusals(bundleOf({ gates }));

    expect(refusal).toMatch(said);
  });

  /** The edge leaves such a build's dynamic routes to its Function, unread. */
  it('refuses any gate of a build with i18n', () => {
    const bundle = bundleOf({ gates: GATES });
    const localized = {
      ...bundle,
      config: { ...bundle.config, i18n: { defaultLocale: 'en', locales: ['en', 'ja'] } },
    };

    expect(refusals(localized)).toStrictEqual([expect.stringMatching(/i18n/u)]);
  });
});

describe('what a manifest carries to find a request’s gate by', () => {
  it('names the gated route on each dynamic route that lands on it, its data’s among them', () => {
    const routes = dynamicRouting(bundleOf({ gates: GATES }), new Set()).dynamicRoutes ?? [];

    expect(routes.map((route: DynamicRoute) => route.gated)).toStrictEqual([POST, POST, undefined]);
  });

  it('names the pathnames Next.js resolves exactly that are of a gated route', () => {
    expect(gatedPathnamesOf(bundleOf({ gates: GATES }))).toStrictEqual({
      [POST]: POST,
      '/posts/demo': POST,
      '/posts/demo.rsc': POST,
    });
  });

  /** A build that declares no gate publishes the tables it always did, byte for byte. */
  it('changes nothing of a build that declares no gate', () => {
    const routes = dynamicRouting(bundleOf(), new Set()).dynamicRoutes ?? [];

    expect(routes.some((route) => 'gated' in route)).toBe(false);
    expect(gatedPathnamesOf(bundleOf())).toBeUndefined();
  });

  /** The edge would find such a request a route and no gate to ask of it. */
  it('is refused where it says a route is gated that no gate is declared for', () => {
    const bundle = bundleOf({ gates: GATES });

    expect(() => manifestOf(bundle, { gates: { [AUTHOR]: 'checker' } })).toThrow(
      /no gate for: \/posts\/\[slug\]/u,
    );
    expect(() => manifestOf(bundle, { gates: {} })).toThrow(/declares no gate/u);
  });
});

describe('the gate a request is asked of', () => {
  const manifest = manifestOf(bundleOf({ gates: GATES }), {
    reservedRoutes: [{ sourceRegex: '^/posts/claimed$', beforeFiles: true }],
  });
  const post = { route: POST, name: 'checker' };

  it.each([
    ['a member of the gated class', '/posts/abc'],
    ['a member’s payload', '/posts/abc.rsc'],
    ['a member’s prefetch segment', '/posts/abc.segments/_tree.segment.rsc'],
    ['a member the build prerendered', '/posts/demo'],
    ['the payload the build wrote beside it', '/posts/demo.rsc'],
    ['the route itself, as written', '/posts/[slug]'],
    ['a member behind a trailing slash', '/posts/abc/'],
  ])('is the route’s for %s', (_, path) => {
    expect(gateOf(manifest, path)).toStrictEqual(post);
  });

  it.each([
    ['a member of a class with no gate', '/authors/abc'],
    ['a page of its own the gated class’s pattern also matches', '/posts/new'],
    ['a page with no gate', '/'],
    ['a pathname a rule ahead of the filesystem claims', '/posts/claimed'],
    ['a pathname that names nothing', '/missing/page'],
  ])('is none for %s', (_, path) => {
    expect(gateOf(manifest, path)).toBeUndefined();
  });

  it('is none for any request of a deployment that declares no gate', () => {
    const ungated = manifestOf(bundleOf());

    expect(gateOf(ungated, '/posts/abc')).toBeUndefined();
  });

  /** The props of a page the build prerendered are of that page, as the edge finds them. */
  it('is the page’s for a request for the props the build wrote of it', () => {
    const withProps = {
      ...manifestOf(bundleOf({ gates: GATES })),
      pagesDataPrefix: '/_next/data/build',
    };

    expect(gateOf(withProps, '/_next/data/build/posts/demo.json')).toStrictEqual(post);
    expect(gateOf(withProps, '/_next/data/build/index.json')).toBeUndefined();
  });
});
