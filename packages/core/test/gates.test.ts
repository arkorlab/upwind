import { describe, expect, it } from 'vitest';

import type { ArtifactRef } from '../src/artifact/artifact.ts';
import {
  declaredRouteGates,
  gatedDataPrefixOf,
  gatedPathnamesOf,
  ROUTE_GATES_ENV,
} from '../src/bundle/gates.ts';
import { type DeploymentBundle, deploymentBundleSchema, type Route } from '../src/bundle/schema.ts';
import { dynamicRouting } from '../src/bundle/serving.ts';
import { gateFor } from '../src/manifest/gates.ts';
import { type BuildProjectManifestInput, buildProjectManifest } from '../src/manifest/manifest.ts';
import type { DynamicRoute, ProjectManifest, RouteEntry } from '../src/manifest/schema.ts';
import { createId } from '../src/util/index.ts';

/**
 * The gates a build declares for its routes (`ROUTE_GATES_ENV`): read off the environment, held to
 * the routes the build has and to the rewrites that could reach them, carried into the manifest
 * beside what finds a request's gate by, and found for a request as the route that serves it is
 * (`gateFor`).
 */

const GENERATED_AT = '2026-10-16T00:00:00.000Z';
const BUILD = 'build';
const POST = '/posts/[slug]';
const AUTHOR = '/authors/[slug]';
const NEWS = '/news/[slug]';
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
/** A Pages Router page's props, as `next build` writes their route beside the page's own. */
const NEWS_DATA_ENTRY = {
  source: NEWS,
  sourceRegex: String.raw`^/_next/data/build[/]?/news/(?<nxtPslug>[^/]+?)\.json(?:/)?$`,
  destination: `/_next/data/${BUILD}/news/[slug].json?nxtPslug=$nxtPslug`,
};
const NEWS_ENTRY = {
  source: NEWS,
  sourceRegex: '^[/]?/news/(?<nxtPslug>[^/]+?)(?:/)?$',
  destination: '/news/[slug]?nxtPslug=$nxtPslug',
};
const FILE = { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/plain' };
const ARTIFACT: ArtifactRef = { ...FILE, contentType: 'text/html', encoding: 'identity' };

/** A build of a few pages, two of them dynamic, with `gates` declared as given. */
function bundleOf(extra: Partial<DeploymentBundle> = {}): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: BUILD,
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
      { id: '/private', kind: 'app-page', pathname: '/private' },
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

/** `bundle` with `rules` in the routing phase named. */
function rerouted(
  bundle: DeploymentBundle,
  phase: 'beforeFiles' | 'afterFiles' | 'fallback',
  rules: Route[],
): DeploymentBundle {
  return { ...bundle, routing: { ...bundle.routing, [phase]: rules } };
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
  const routeKeys = new Set(extra.routes?.map((route) => route.pathname));
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: GENERATED_AT,
    originHost: 'app.example',
    deployment: { dplId: bundle.deploymentId, assetSetHash: 'h', observedAt: GENERATED_AT },
    routes: [],
    app: { deploymentId: bundle.deploymentId, scriptName: 'app' },
    ...dynamicRouting(bundle, routeKeys),
    gates: bundle.gates,
    gatedPathnames: gatedPathnamesOf(bundle),
    gatedDataPrefix: gatedDataPrefixOf(bundle),
    ...extra,
  });
}

/** A route the build prerendered, served from its shell. */
function routeEntry(pathname: string, extra: Partial<RouteEntry> = {}): RouteEntry {
  return { pathname, status: 200, shell: ARTIFACT, headers: {}, ...extra };
}

function gateOf(manifest: ProjectManifest, path: string) {
  return gateFor(manifest, new URL(path, 'https://app.example'), new Headers());
}

const GATES = { [POST]: 'checker' };
const POST_GATE = { route: POST, name: 'checker' };

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
    ['{"/ポスト":"checker"}', /expected a route/u],
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

/**
 * A request a rewrite of `next.config` claims is served as its destination is, by the Function, and
 * no gate is asked on the way: a gated route a rewrite may send a request to is refused at the build.
 */
describe('the gates a build’s rewrites may reach', () => {
  it.each([
    [
      'a parameter of its route',
      'beforeFiles' as const,
      { source: '/p/:slug', sourceRegex: '^/p/([^/]+?)$', destination: '/posts/$1' },
    ],
    [
      'a capture that may be any path',
      'afterFiles' as const,
      { source: '/old/:path*', sourceRegex: '^/old(?:/(.*))?$', destination: '/$1' },
    ],
    [
      'a member of it the build prerendered',
      'fallback' as const,
      { source: '/latest', sourceRegex: '^/latest$', destination: '/posts/demo' },
    ],
    [
      'a member of it the build did not name',
      'afterFiles' as const,
      { source: '/first', sourceRegex: '^/first$', destination: '/posts/first?from=first' },
    ],
    [
      'a prefetch segment of a member',
      'beforeFiles' as const,
      { source: '/s/:rest*', sourceRegex: '^/s/(.*)$', destination: '/posts/first.segments/$1' },
    ],
  ])('refuses a gate of a route a rewrite reaches by %s', (_, phase, rule) => {
    const bundle = rerouted(bundleOf({ gates: GATES }), phase, [rule]);

    expect(refusals(bundle)).toStrictEqual([
      expect.stringMatching(/^gates names \/posts\/\[slug\], which the rewrite of /u),
    ]);
  });

  it.each([
    [
      'another route, as a delivery of the application’s own is',
      { source: '/authors/:slug', sourceRegex: '^/authors/(.+)$', destination: '/api/deliver/$1' },
    ],
    [
      'a page of its own the gated route’s pattern also matches',
      { source: '/write', sourceRegex: '^/write$', destination: '/posts/new' },
    ],
    [
      'another origin',
      { source: '/blog/:p*', sourceRegex: '^/blog(.*)$', destination: 'https://blog.example/$1' },
    ],
    [
      'a redirect, which sends the visitor to ask for it',
      {
        source: '/p/:slug',
        sourceRegex: '^/p/([^/]+?)$',
        destination: '/posts/$1',
        status: 308,
        headers: { Location: '/posts/$1' },
      },
    ],
  ])('takes a gate no rewrite can reach, with one to %s', (_, rule) => {
    const bundle = rerouted(bundleOf({ gates: GATES }), 'beforeFiles', [rule]);

    expect(refusals(bundle)).toStrictEqual([]);
  });

  /** A Pages Router page's props are asked for by a name of their own, which a rewrite may write. */
  it('refuses a gate of a Pages Router page a rewrite of its props’ name reaches', () => {
    const bundle = rerouted(
      bundleOf({
        gates: { [NEWS]: 'checker' },
        entrypoints: [{ id: NEWS, kind: 'pages', pathname: NEWS }],
      }),
      'beforeFiles',
      [
        {
          source: '/n/:slug',
          sourceRegex: '^/n/([^/]+?)$',
          destination: `/_next/data/${BUILD}/news/$1.json`,
        },
      ],
    );

    expect(refusals(bundle)).toStrictEqual([
      expect.stringMatching(/gates names \/news\/\[slug\]/u),
    ]);
  });
});

describe('what a manifest carries to find a request’s gate by', () => {
  it('names the gated route on each dynamic route that lands on it, its data’s among them', () => {
    const routes = dynamicRouting(bundleOf({ gates: GATES }), new Set()).dynamicRoutes ?? [];

    expect(routes.map((route: DynamicRoute) => route.gated)).toStrictEqual([POST, POST, undefined]);
  });

  /**
   * A build before 16.4 writes a page's payload and its prefetch segments routes of their own,
   * whose destination names the page with what follows its name for its data.
   */
  it('names the gated route on the data routes a build before 16.4 writes of it', () => {
    const bundle = bundleOf({
      gates: GATES,
      routing: {
        ...bundleOf().routing,
        dynamicRoutes: [
          {
            source: POST,
            sourceRegex: String.raw`^/posts/(?<nxtPslug>[^/]+?)\.segments/posts/\$d\$slug(?<segment>/__PAGE__\.segment\.rsc|\.segment\.rsc)(?:/)?$`,
            destination: '/posts/[slug].segments/posts/$d$slug$segment?nxtPslug=$nxtPslug',
          },
          {
            source: `${POST}.rsc`,
            sourceRegex: String.raw`^/posts/(?<nxtPslug>[^/]+?)(?<rscSuffix>\.rsc|\.segments/.+\.segment\.rsc)(?:/)?$`,
            destination: '/posts/[slug]$rscSuffix?nxtPslug=$nxtPslug',
          },
          {
            source: POST,
            sourceRegex: '^/posts/(?<nxtPslug>[^/]+?)(?:/)?$',
            destination: '/posts/[slug]?nxtPslug=$nxtPslug',
          },
        ],
      },
    });
    const routes = dynamicRouting(bundle, new Set()).dynamicRoutes ?? [];
    const manifest = manifestOf(bundle);

    expect(routes.map((route: DynamicRoute) => route.gated)).toStrictEqual([POST, POST, POST]);
    expect(gateOf(manifest, '/posts/first.rsc')).toStrictEqual(POST_GATE);
    expect(
      gateOf(manifest, '/posts/first.segments/posts/$d$slug/__PAGE__.segment.rsc'),
    ).toStrictEqual(POST_GATE);
  });

  it('names the pathnames Next.js resolves exactly that are of a gated route', () => {
    expect(gatedPathnamesOf(bundleOf({ gates: GATES }))).toStrictEqual({
      [POST]: POST,
      '/posts/demo': POST,
      '/posts/demo.rsc': POST,
    });
  });

  /** The props of a page rendered for each request are asked for at a route of their own. */
  it('names the route a Pages Router page’s props are asked for by of the page', () => {
    const account = `/_next/data/${BUILD}/account.json`;
    const bundle = bundleOf({
      gates: { '/account': 'checker' },
      entrypoints: [
        { id: '/account', kind: 'pages', pathname: '/account' },
        { id: account, kind: 'pages', pathname: account },
      ],
    });

    expect(gatedPathnamesOf(bundle)).toStrictEqual({
      '/account': '/account',
      [account]: '/account',
    });
  });

  /** A build that declares no gate publishes the tables it always did, byte for byte. */
  it('changes nothing of a build that declares no gate', () => {
    const routes = dynamicRouting(bundleOf(), new Set()).dynamicRoutes ?? [];

    expect(routes.some((route) => 'gated' in route)).toBe(false);
    expect(gatedPathnamesOf(bundleOf())).toBeUndefined();
    expect(gatedDataPrefixOf(bundleOf())).toBeUndefined();
  });

  /** The edge would find such a request a route and no gate to ask of it. */
  it('is refused where it says a route is gated that no gate is declared for', () => {
    const bundle = bundleOf({ gates: GATES });

    expect(() => manifestOf(bundle, { gates: { [AUTHOR]: 'checker' } })).toThrow(
      /no gate for: \/posts\/\[slug\]/u,
    );
    expect(() => manifestOf(bundle, { gates: {} })).toThrow(/declares no gate/u);
  });

  /**
   * And where it declares a gate nothing finds a request of the route by: the edge would serve every
   * request of the route as one with no gate.
   */
  it.each([
    [
      'a page no pathname is said to be of',
      { gates: { '/private': 'checker' }, gatedPathnames: {} },
      /gates declares \/private, which no pathname or dynamic route/u,
    ],
    [
      'a class of pages no dynamic route is said to land on',
      { gates: GATES, gatedPathnames: { [POST]: POST }, dynamicRoutes: [] },
      /gates declares \/posts\/\[slug\], which no pathname or dynamic route/u,
    ],
  ])('is refused where it declares a gate of %s', (_, extra, said) => {
    expect(() => manifestOf(bundleOf(), extra)).toThrow(said);
  });
});

describe('the gate a request is asked of', () => {
  const manifest = manifestOf(bundleOf({ gates: GATES }), {
    reservedRoutes: [{ sourceRegex: '^/posts/claimed$', beforeFiles: true }],
  });

  it.each([
    ['a member of the gated class', '/posts/abc'],
    ['a member’s payload', '/posts/abc.rsc'],
    ['a member’s prefetch segment', '/posts/abc.segments/_tree.segment.rsc'],
    ['a member the build prerendered', '/posts/demo'],
    ['the payload the build wrote beside it', '/posts/demo.rsc'],
    ['the route itself, as written', '/posts/[slug]'],
    ['a member behind a trailing slash', '/posts/abc/'],
  ])('is the route’s for %s', (_, path) => {
    expect(gateOf(manifest, path)).toStrictEqual(POST_GATE);
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

  /**
   * The router finds a page of its own the path spells decoded ahead of a member of a class it
   * spells escaped: the gate asked is the one of the route that serves the request.
   */
  it('is the page of its own’s where a member of a gated class is spelled as it', () => {
    const docs = '/docs/[slug]';
    const bundle = bundleOf({
      gates: { [docs]: 'checker' },
      entrypoints: [
        { id: '/docs/a/b', kind: 'app-page', pathname: '/docs/a/b' },
        { id: docs, kind: 'app-page', pathname: docs },
      ],
      prerenders: [
        { id: 'own', pathname: '/docs/a/b', route: '/docs/a/b', parentOutputId: 'o', groupId: 1 },
        { id: 'member', pathname: '/docs/a%2Fb', route: docs, parentOutputId: 'm', groupId: 2 },
      ],
      routing: {
        ...bundleOf().routing,
        dynamicRoutes: [
          {
            source: docs,
            sourceRegex: '^/docs/(?<nxtPslug>[^/]+?)(?:/)?$',
            destination: '/docs/[slug]?nxtPslug=$nxtPslug',
          },
        ],
      },
    });
    const gated = manifestOf(bundle);

    expect(gateOf(gated, '/docs/a%2Fb')).toBeUndefined();
    expect(gateOf(gated, '/docs/other')).toStrictEqual({ route: docs, name: 'checker' });
  });

  /**
   * No page Next.js resolves exactly is found by its name behind a slash where the application
   * keeps none, so nothing serves such a request as the page; where it keeps one, that is a name.
   */
  it('is the page’s behind a trailing slash only where the application keeps its pages there', () => {
    const gates = { '/private': 'checker' };
    const slashless = manifestOf(bundleOf({ gates }));
    const slashed = bundleOf({
      gates,
      config: { ...bundleOf().config, trailingSlash: true, skipTrailingSlashRedirect: true },
    });

    expect(gateOf(slashless, '/private/')).toBeUndefined();
    expect(gateOf(manifestOf(slashed), '/private/')).toStrictEqual({
      route: '/private',
      name: 'checker',
    });
  });

  /** A page's payload is a name of its own, which the build writes only where it prerendered it. */
  it('is none for the payload of a page the build named no payload of', () => {
    const gated = manifestOf(bundleOf({ gates: { '/private': 'checker' } }));

    expect(gateOf(gated, '/private')).toStrictEqual({ route: '/private', name: 'checker' });
    expect(gateOf(gated, '/private.rsc')).toBeUndefined();
  });
});

describe('the gate a request for a page’s props is asked of', () => {
  /** A build of Pages Router news beside the App Router pages, the news and `/private` gated. */
  function pagesBundle(normalized = false): DeploymentBundle {
    const bundle = bundleOf();
    return bundleOf({
      gates: { [NEWS]: 'checker', [POST]: 'checker', '/private': 'checker' },
      entrypoints: [...bundle.entrypoints, { id: NEWS, kind: 'pages', pathname: NEWS }],
      prerenders: [
        { id: 'news', pathname: '/news/today', route: NEWS, parentOutputId: 'n', groupId: 3 },
        {
          id: 'news.json',
          pathname: `/_next/data/${BUILD}/news/today.json`,
          route: NEWS,
          parentOutputId: 'n',
          groupId: 3,
        },
      ],
      routing: {
        ...bundle.routing,
        dynamicRoutes: [NEWS_DATA_ENTRY, POST_ENTRY, AUTHOR_ENTRY, NEWS_ENTRY],
        shouldNormalizeNextData: normalized,
      },
    });
  }
  /** The manifest of a deployment of it whose edge holds the props of `/news/today`. */
  function withProps(extra: Partial<BuildProjectManifestInput> = {}): ProjectManifest {
    return manifestOf(pagesBundle(), {
      routes: [routeEntry('/news/today', { pagesData: { artifact: ARTIFACT } })],
      pagesDataUnder: { basePath: '', buildId: BUILD },
      ...extra,
    });
  }
  const today = `/_next/data/${BUILD}/news/today.json`;
  const newsGate = { route: NEWS, name: 'checker' };

  it('is the page’s for its props the edge holds, and for a member’s it does not', () => {
    expect(gateOf(withProps(), today)).toStrictEqual(newsGate);
    expect(gateOf(withProps(), `/_next/data/${BUILD}/news/yesterday.json`)).toStrictEqual(newsGate);
  });

  /** A redirect or a rewrite ahead of the filesystem takes the request elsewhere first. */
  it.each([
    [
      'claims the name of its props',
      [
        {
          sourceRegex: String.raw`^/_next/data/${BUILD}/news/today\.json$`,
          beforeFiles: true as const,
        },
      ],
    ],
    [
      'claims a request for props, by the header Next.js puts on every one',
      [
        {
          sourceRegex: '^/_next/data/.*$',
          has: [{ type: 'header' as const, key: 'x-nextjs-data' }],
          beforeFiles: true as const,
        },
      ],
    ],
  ])('is none where a rule ahead of the filesystem %s', (_, reservedRoutes) => {
    expect(gateOf(withProps({ reservedRoutes }), today)).toBeUndefined();
  });

  /** An App Router page has no props: a request at that name is no request of the page's. */
  it('is none at the name an App Router page’s props would have', () => {
    expect(gateOf(withProps(), `/_next/data/${BUILD}/private.json`)).toBeUndefined();
  });

  /**
   * Where the router reads such a name as the page it names, a member of a class is routed as one
   * by the class's dynamic route — an App Router page's among them — and is that class's to gate.
   */
  it('is a class’s for a name the router reads as one of its members', () => {
    const normalized = manifestOf(pagesBundle(true));
    const plain = manifestOf(pagesBundle());

    expect(gateOf(normalized, `/_next/data/${BUILD}/posts/abc.json`)).toStrictEqual(POST_GATE);
    expect(gateOf(plain, `/_next/data/${BUILD}/posts/abc.json`)).toBeUndefined();
    expect(gateOf(normalized, '/_next/data/other/posts/abc.json')).toBeUndefined();
  });
});
