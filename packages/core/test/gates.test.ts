import { describe, expect, it, vi } from 'vitest';

import type { ArtifactRef } from '../src/artifact/artifact.ts';
import { declaredRouteGates, gatedPathnamesOf, ROUTE_GATES_ENV } from '../src/bundle/gates.ts';
import {
  type DeploymentBundle,
  deploymentBundleSchema,
  type Prerender,
  type Route,
} from '../src/bundle/schema.ts';
import { dynamicRouting } from '../src/bundle/serving.ts';
import { gateFor } from '../src/manifest/gates.ts';
import { type BuildProjectManifestInput, buildProjectManifest } from '../src/manifest/manifest.ts';
import type { DynamicRoute, ProjectManifest, RouteEntry } from '../src/manifest/schema.ts';
import { EDGE_BYPASS_COOKIE } from '../src/request/constants.ts';
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
/** A route a segment of whose name ends as a page's prefetch segments do. */
const REPORT = '/reports.segments/[slug]';
const REPORT_ENTRY = {
  source: REPORT,
  sourceRegex: String.raw`^/reports\.segments/(?<nxtPslug>[^/]+?)(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`,
  destination: '/reports.segments/[slug]$2?nxtPslug=$nxtPslug',
};
/** An image optimizer at Next.js's own path. */
const IMAGES = {
  path: '/_next/image',
  basePath: '',
  sizes: [64],
  formats: [],
  minimumCacheTTL: 60,
  maximumRedirects: 3,
  maximumResponseBody: 50_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: '',
  contentDispositionType: 'inline' as const,
};
const ARTIFACT: ArtifactRef = { ...FILE, contentType: 'text/html', encoding: 'identity' };

/** A Function of the build's own, as its code is carried. */
const FUNCTION = {
  mainModule: 'index.mjs',
  modules: [],
  compatibilityDate: '2026-09-15',
  compatibilityFlags: [],
};

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
    functions: { app: FUNCTION },
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

/** A prerender of `/posts/new`, a page of its own beside the gated class. */
function ofNewPost(id: string, pathname: string): Prerender {
  return { id, pathname, route: '/posts/new', parentOutputId: 'new', groupId: 3 };
}

/** A rewrite of `/latest` to `destination`. */
function latest(destination: string): Route {
  return { source: '/latest', sourceRegex: '^/latest(?:/)?$', destination };
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
const ALL = '/[...all]';

/** A member of the authors' class, prerendered. */
const AUTHOR_DEMO: Prerender = {
  id: 'author',
  pathname: '/authors/demo',
  route: AUTHOR,
  parentOutputId: 'a',
  groupId: 1,
};
/** A member of the catch-all, prerendered under the posts, whose class is ahead of the catch-all. */
const CAUGHT_DEMO: Prerender = {
  id: 'caught',
  pathname: '/posts/demo',
  route: ALL,
  parentOutputId: 'c',
  groupId: 2,
};
/** A member of the posts' class, prerendered. */
const POST_DEMO: Prerender = {
  id: 'post',
  pathname: '/posts/first',
  route: POST,
  parentOutputId: 'p',
  groupId: 3,
};

/**
 * A build of a class of posts and a class of authors ahead of a catch-all, in Next.js's order, with
 * `prerendered` — by default, a member of the authors and one of the catch-all under the posts.
 */
function classesOf(
  gates: Record<string, string>,
  prerendered: readonly Prerender[] = [AUTHOR_DEMO, CAUGHT_DEMO],
): DeploymentBundle {
  return bundleOf({
    gates,
    entrypoints: [
      { id: POST, kind: 'app-page', pathname: POST },
      { id: AUTHOR, kind: 'app-page', pathname: AUTHOR },
      { id: ALL, kind: 'app-page', pathname: ALL },
    ],
    prerenders: [...prerendered],
    routing: {
      ...bundleOf().routing,
      dynamicRoutes: [
        POST_ENTRY,
        AUTHOR_ENTRY,
        {
          source: ALL,
          sourceRegex: '^/(?<nxtPall>.+?)(?:/)?$',
          destination: '/[...all]?nxtPall=$nxtPall',
        },
      ],
    },
  });
}

/** The same build with the authors' class asked only of a request with a cookie. */
function conditionedOf(
  gates: Record<string, string>,
  prerendered?: readonly Prerender[],
): DeploymentBundle {
  const bundle = classesOf(gates, prerendered);
  const dynamicRoutes = bundle.routing.dynamicRoutes.map((route) => {
    return route === AUTHOR_ENTRY
      ? { ...route, has: [{ type: 'cookie' as const, key: 'b' }] }
      : route;
  });
  return { ...bundle, routing: { ...bundle.routing, dynamicRoutes } };
}

/** Whether `pattern` is the authors' class's, read back as written: compiled, a `/` is escaped. */
function isAuthors(pattern: RegExp): boolean {
  return pattern.source.replaceAll(String.raw`\/`, '/') === AUTHOR_ENTRY.sourceRegex;
}

/**
 * How often the authors' class's pattern is asked of a path as the schema reads a build that gates
 * `gates`, with a rewrite to a path no name or class holds of: every ask of every pattern watched.
 */
function authorsAsked(gates: Record<string, string>): number {
  const bundle = rerouted(bundleOf({ gates }), 'afterFiles', [latest('/elsewhere/x')]);
  const exec = vi.spyOn(RegExp.prototype, 'exec');
  try {
    refusals(bundle);
    return exec.mock.contexts.filter((pattern) => pattern instanceof RegExp && isAuthors(pattern))
      .length;
  } finally {
    exec.mockRestore();
  }
}

/**
 * A build with `/private` gated and `rule` rewriting — and an image optimizer at Next.js's own path,
 * unless it has `none`.
 */
function optimizedBy(rule: Route, optimizer: 'none' | 'own' = 'own'): DeploymentBundle {
  const bundle = bundleOf({ gates: { '/private': 'checker' } });
  const config = optimizer === 'none' ? bundle.config : { ...bundle.config, images: IMAGES };
  return rerouted({ ...bundle, config }, 'afterFiles', [rule]);
}

/** A rewrite of `/thumb/…`, what follows the prefix captured. */
function thumbnail(destination: string): Route {
  return {
    source: '/thumb/:path*',
    sourceRegex: String.raw`^\/thumb(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
    destination,
  };
}

/** A rewrite of `/old` to a page of its own no gate is declared for, asked only on `conditions`. */
function conditionedRewrite(conditions: Pick<Route, 'has' | 'missing'>): DeploymentBundle {
  const rule = { source: '/old', sourceRegex: '^/old(?:/)?$', destination: '/posts/new' };
  return rerouted(bundleOf({ gates: GATES }), 'beforeFiles', [{ ...rule, ...conditions }]);
}

/** What the schema says of a bundle's rewrites, of all it says is wrong with the bundle. */
function rewriteRefusals(bundle: DeploymentBundle): string[] {
  return refusals(bundle).filter((said) => said.includes(', which the rewrite of '));
}

const DOCS = '/docs/[slug]';
const DOCS_ENTRY = {
  source: DOCS,
  sourceRegex: '^/docs/(?<nxtPslug>[^/]+?)(?:/)?$',
  destination: '/docs/[slug]?nxtPslug=$nxtPslug',
};

/**
 * A build of a class of docs, with a member whose value holds a slash (`/docs/a%2Fb`) prerendered,
 * a page of its own at the path that member's name also spells decoded (`/docs/a/b`), and another.
 */
function docsOf(gates: Record<string, string>): DeploymentBundle {
  return bundleOf({
    gates,
    entrypoints: [
      { id: DOCS, kind: 'app-page', pathname: DOCS },
      { id: '/docs/a/b', kind: 'app-page', pathname: '/docs/a/b' },
      { id: '/private', kind: 'app-page', pathname: '/private' },
    ],
    prerenders: [
      { id: 'ab', pathname: '/docs/a%2Fb', route: DOCS, parentOutputId: 'ab', groupId: 1 },
    ],
    routing: { ...bundleOf().routing, dynamicRoutes: [DOCS_ENTRY] },
  });
}
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

  /**
   * The edge judges the rules a request's gate is found by on the request as it came, and the
   * deployment's router on the request as the edge hands it on: a rule that asks for what the edge
   * takes off or writes itself there would be judged otherwise by each.
   */
  it.each([
    [
      'a forwarding header',
      { has: [{ type: 'header' as const, key: 'x-forwarded-for', value: '1' }] },
    ],
    [
      'a header of the platform in front',
      { has: [{ type: 'header' as const, key: 'CF-IPCountry' }] },
    ],
    ['the host header', { missing: [{ type: 'header' as const, key: 'host' }] }],
    ['the via header', { missing: [{ type: 'header' as const, key: 'via' }] }],
    ['the edge’s own cookie', { has: [{ type: 'cookie' as const, key: EDGE_BYPASS_COOKIE }] }],
  ])('refuses one of a build with a rule that asks for %s', (_, conditions) => {
    expect(refusals(conditionedRewrite(conditions))).toStrictEqual([
      expect.stringMatching(/^a build that declares a gate may judge no route on what its router/u),
    ]);
  });

  /** A dynamic route a request's gate is found by is held to the same. */
  it('refuses one of a build with a dynamic route that asks for a header the edge writes', () => {
    const asked = {
      ...AUTHOR_ENTRY,
      missing: [{ type: 'header' as const, key: 'x-forwarded-proto' }],
    };
    const bundle = bundleOf({
      gates: GATES,
      routing: { ...bundleOf().routing, dynamicRoutes: [POST_ENTRY, asked] },
    });

    expect(refusals(bundle)).toStrictEqual([
      expect.stringContaining(`the rule of ${AUTHOR} asks for the x-forwarded-proto header`),
    ]);
  });

  /**
   * What the router is handed as the visitor sent it is judged alike — and `x-nextjs-data`, which
   * the edge judges as the router does: Next.js conditions its own redirects on it.
   */
  it.each([
    ['a header of the application’s own', { has: [{ type: 'header' as const, key: 'x-mode' }] }],
    ['x-nextjs-data', { missing: [{ type: 'header' as const, key: 'x-nextjs-data' }] }],
    ['a cookie', { has: [{ type: 'cookie' as const, key: 'theme', value: 'dark' }] }],
    ['the host', { has: [{ type: 'host' as const, value: 'app.example' }] }],
  ])('takes one of a build with a rule that asks for %s', (_, conditions) => {
    expect(refusals(conditionedRewrite(conditions))).toStrictEqual([]);
  });

  /**
   * The image optimizer's own path is answered as the optimizer's ahead of every route, a page of
   * that name among them, by either spelling of one trailing slash: a gate of that page would never
   * be asked.
   */
  it.each([
    ['as the page is named', '/private'],
    ['behind a trailing slash', '/private/'],
  ])('refuses one of a page at the image optimizer’s own path, spelled %s', (_, path) => {
    const config = { ...bundleOf().config, images: { ...IMAGES, path } };

    expect(refusals(bundleOf({ gates: { '/private': 'checker' }, config }))).toStrictEqual([
      expect.stringMatching(/^gates names \/private, the image optimizer's path/u),
    ]);
  });

  /**
   * The edge runs a middleware itself only for the requests it serves as documents; one it hands
   * on runs it in the Function, where a rewrite onto a gated route reaches it with no gate asked.
   */
  it.each([
    ['its matchers', { middleware: { matchers: [{ sourceRegex: '^/.*$' }] } }],
    ['its own Function', { functions: { ...bundleOf().functions, middleware: FUNCTION } }],
    [
      'its matchers among the routing',
      { routing: { ...bundleOf().routing, middlewareMatchers: [{ sourceRegex: '^/.*$' }] } },
    ],
  ])('refuses any gate of a build with a middleware, by %s', (_, extra) => {
    expect(refusals(bundleOf({ gates: GATES, ...extra }))).toStrictEqual([
      expect.stringMatching(/^a build with a middleware may declare no gate/u),
    ]);
  });

  /**
   * A prerendered pathname that may be served as more than one route, one of them gated — its own,
   * which the edge serves what it kept of, and a class ahead of it that the router lands it on; two
   * the router chooses between by what a request carries; its own and a page of its own its name
   * also spells — leaves the edge no one gate to ask before it serves the pathname: the gate asked
   * would answer for the other route, gated or not.
   */
  it.each([
    ['both gated', { [POST]: 'posts', [ALL]: 'pages' }],
    ['the class gated', { [POST]: 'posts' }],
    ['its own gated', { [ALL]: 'pages' }],
  ])(
    'refuses a gate where a prerendered pathname may be served as its own or a class ahead of it, %s',
    (_, gates) => {
      expect(refusals(classesOf(gates, [CAUGHT_DEMO]))).toStrictEqual([
        expect.stringMatching(
          /^gates names .*, and \/posts\/demo may be served as \/\[\.\.\.all\] or \/posts\/\[slug\]: /u,
        ),
      ]);
    },
  );

  it.each([
    ['both gated', { [AUTHOR]: 'authors', [ALL]: 'pages' }],
    ['the one passed over gated', { [AUTHOR]: 'authors' }],
    ['the one after it gated', { [ALL]: 'pages' }],
  ])(
    'refuses a gate where a request’s conditions choose a prerendered pathname’s route, %s',
    (_, gates) => {
      expect(refusals(conditionedOf(gates, [AUTHOR_DEMO]))).toStrictEqual([
        expect.stringMatching(
          /^gates names .*, and \/authors\/demo may be served as \/authors\/\[slug\] or \/\[\.\.\.all\]: /u,
        ),
      ]);
    },
  );

  it.each([
    ['the page of its own gated', { '/docs/a/b': 'checker' }],
    ['its own route gated', { [DOCS]: 'checker' }],
    ['both gated', { [DOCS]: 'checker', '/docs/a/b': 'checker' }],
  ])('refuses a gate where a member’s name also spells a page of its own, %s', (_, gates) => {
    expect(refusals(docsOf(gates))).toStrictEqual([
      expect.stringMatching(
        /^gates names .*, and \/docs\/a%2Fb may be served as \/docs\/\[slug\] or \/docs\/a\/b: /u,
      ),
    ]);
  });

  /**
   * Where every route it may be served as is ungated, or it may be served as one route only, there is
   * nothing to choose between: a gated class's member and a catch-all's member it is ahead of, the
   * catch-all ungated, are taken.
   */
  it('takes a gate where each prerendered pathname may be served as one route, or none gated', () => {
    expect(refusals(classesOf({ [POST]: 'posts' }, [AUTHOR_DEMO, POST_DEMO]))).toStrictEqual([]);
    expect(refusals(conditionedOf({ [POST]: 'posts' }, [AUTHOR_DEMO]))).toStrictEqual([]);
  });

  /** Next.js has a router read a data URL as the page it names only for a build with a middleware. */
  it('refuses any gate of a build whose router reads a data URL as the page it names', () => {
    const bundle = bundleOf({
      gates: GATES,
      routing: { ...bundleOf().routing, shouldNormalizeNextData: true },
    });

    expect(refusals(bundle)).toStrictEqual([
      expect.stringMatching(/^a build whose router reads a Pages Router data URL/u),
    ]);
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
    [
      'a member written in another case, as the router matches a class without regard to it',
      'beforeFiles' as const,
      { source: '/up/:slug', sourceRegex: '^/up/([^/]+?)$', destination: '/POSTS/$1' },
    ],
    [
      'a member written whole in another case',
      'afterFiles' as const,
      { source: '/first', sourceRegex: '^/first$', destination: '/Posts/first' },
    ],
    [
      'a fragment, which the router keeps in the path it rewrites to',
      'beforeFiles' as const,
      { source: '/top', sourceRegex: '^/top$', destination: '/posts/new#top' },
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
      {
        source: '/authors/:slug',
        sourceRegex: String.raw`^\/authors(?:\/([^\/]+?))(?:\/)?$`,
        destination: '/api/deliver/$1',
      },
    ],
    [
      'a page of its own the gated route’s pattern also matches',
      { source: '/write', sourceRegex: '^/write$', destination: '/posts/new' },
    ],
    [
      'a page of its own written escaped, which the router finds decoded whole',
      { source: '/compose', sourceRegex: '^/compose$', destination: '/posts%2Fnew' },
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

  /**
   * A value a rewrite puts in the path may climb out of what it writes ahead of it: one a `has`
   * condition captured — from the query, a header, a cookie — may hold `/` and `..`, and reach any
   * route; part of a segment may be `..`, and climb a level; and so does a `..` written after it.
   */
  it.each([
    [
      'a value of the query',
      {
        source: '/alias',
        sourceRegex: String.raw`^\/alias(?:\/)?$`,
        has: [{ type: 'query' as const, key: 'target' }],
        destination: '/public/$target',
      },
    ],
    [
      'a value of a header',
      {
        source: '/alias',
        sourceRegex: String.raw`^\/alias(?:\/)?$`,
        has: [{ type: 'header' as const, key: 'x-target' }],
        destination: '/public/$xtarget',
      },
    ],
    [
      'part of a segment',
      {
        source: '/img/:name.png',
        sourceRegex: String.raw`^\/img(?:\/([^\/]+?))\.png(?:\/)?$`,
        destination: '/public/$1/private',
      },
    ],
    [
      'a segment a climb is written after',
      {
        source: '/up/:slug',
        sourceRegex: String.raw`^\/up(?:\/([^\/]+?))(?:\/)?$`,
        destination: '/public/$1/../../private',
      },
    ],
  ])('refuses a gate a rewrite reaches by what %s may hold', (_, rule) => {
    const gates = { '/private': 'checker' };
    const bundle = rerouted(bundleOf({ gates }), 'beforeFiles', [rule]);

    expect(refusals(bundle)).toStrictEqual([
      expect.stringMatching(/^gates names \/private, which the rewrite of /u),
    ]);
  });

  /** What a pattern of the application's own captures (`:id(\d+)`) is read as anything at all. */
  it('refuses a gate where a rewrite puts in what a pattern of its own captured', () => {
    const rule = {
      source: String.raw`/n/:id(\d+)`,
      sourceRegex: String.raw`^\/n(?:\/(\d+))(?:\/)?$`,
      destination: '/public/$1',
    };
    const bundle = rerouted(bundleOf({ gates: { '/private': 'checker' } }), 'beforeFiles', [rule]);

    expect(refusals(bundle)).toStrictEqual([expect.stringMatching(/^gates names \/private/u)]);
  });

  /**
   * The router reaches a member the build prerendered through its dynamic routes, the first that
   * holds of it winning: a rewrite to a member of the authors lands on the authors' class, and
   * reaches no gated catch-all behind it — while one to the catch-all's member under the posts lands
   * on the posts' class ahead of the catch-all, and reaches that.
   */
  it('reads a rewrite to a member as the dynamic route the router lands it on', () => {
    const author = rerouted(classesOf({ [ALL]: 'checker' }), 'afterFiles', [
      latest('/authors/demo'),
    ]);
    const caught = rerouted(classesOf({ [POST]: 'checker' }), 'afterFiles', [
      latest('/posts/demo'),
    ]);

    expect(rewriteRefusals(author)).toStrictEqual([]);
    expect(rewriteRefusals(caught)).toStrictEqual([
      expect.stringMatching(/^gates names \/posts\/\[slug\], which the rewrite of /u),
    ]);
  });

  /**
   * Where a rewrite lands is read once for the rewrite, and every gated route held to it: the dynamic
   * routes are asked of its destination once, however many routes the build gates.
   */
  it('asks the dynamic routes where a rewrite lands once, however many routes are gated', () => {
    const many = { [POST]: 'checker', [AUTHOR]: 'checker', '/private': 'checker', '/': 'checker' };

    expect(authorsAsked(GATES)).toBeGreaterThan(0);
    expect(authorsAsked(many)).toBe(authorsAsked(GATES));
  });

  /** A dynamic route with conditions may be passed over, and the one after it reached. */
  it('reads a dynamic route with conditions as one the router may pass over', () => {
    const rewritten = rerouted(conditionedOf({ [ALL]: 'checker' }), 'afterFiles', [
      latest('/authors/demo'),
    ]);

    expect(rewriteRefusals(rewritten)).toStrictEqual([
      expect.stringMatching(/^gates names \/\[\.\.\.all\], which the rewrite of /u),
    ]);
  });

  /**
   * A rewrite to the image optimizer has it fetch its source within the deployment's Function, which
   * knows no gate: a gated route's answer it may fetch is refused — a source it names, one a request
   * names where it names none, one it puts in what its rule captured.
   */
  it.each([
    ['a gated page it names', '/_next/image?url=/private&w=64&q=75'],
    ['a gated page named escaped', '/_next/image?url=%2Fprivate&w=64&q=75'],
    ['whatever source a request names', '/_next/image'],
    ['what its rule captured', '/_next/image?url=/$1&w=64&q=75'],
    ['a gated page, the optimizer’s path written behind a slash', '/_next/image/?url=/private'],
  ])('refuses a gate a rewrite has the image optimizer fetch: %s', (_, destination) => {
    const bundle = optimizedBy(thumbnail(destination));

    expect(refusals(bundle)).toStrictEqual([
      `gates names /private, which the rewrite of /thumb/:path* to ${destination} may have the image optimizer fetch as its source, with no gate asked`,
    ]);
  });

  /** One the optimizer fetches from another origin, or that no gated route serves, is taken. */
  it.each([
    ['a file it names', '/_next/image?url=/robots.txt&w=64&q=75', 'own'],
    ['a page no gate is declared for', '/_next/image?url=/posts/new&w=64&q=75', 'own'],
    ['an image of another origin', '/_next/image?url=https://img.example/a.png&w=64', 'own'],
    ['a gated page, where the build has no optimizer', '/_next/image?url=/private', 'none'],
  ] as const)(
    'takes a gate where a rewrite has the image optimizer fetch %s',
    (_, path, optimizer) => {
      const bundle = optimizedBy(thumbnail(path), optimizer);

      expect(refusals(bundle)).toStrictEqual([]);
    },
  );

  /**
   * The router resolves the optimizer's own path as the optimizer's where it resolves the names it
   * is handed before its dynamic routes — a request as it comes, one a rule ahead of the filesystem
   * rewrites — and asks its dynamic routes first of what a rule after the filesystem rewrites: a
   * catch-all serves the optimizer's path there, and its path behind a trailing slash everywhere.
   */
  it.each([
    ['ahead of the filesystem', 'beforeFiles', '/_next/image?url=https://img.example/a.png', []],
    ['ahead of the filesystem, of a file', 'beforeFiles', '/_next/image?url=/robots.txt', []],
    ['after the filesystem', 'afterFiles', '/_next/image?url=https://img.example/a.png', [ALL]],
    [
      'behind a trailing slash',
      'beforeFiles',
      '/_next/image/?url=https://img.example/a.png',
      [ALL],
    ],
  ] as const)(
    'reads a rewrite to the optimizer %s as the router lands it',
    (_, phase, destination, reached: readonly string[]) => {
      const bundle = classesOf({ [ALL]: 'checker' }, [AUTHOR_DEMO]);
      const optimized = { ...bundle, config: { ...bundle.config, images: IMAGES } };
      const rule = { source: '/thumb', sourceRegex: '^/thumb(?:/)?$', destination };
      const rewrite = `the rewrite of /thumb to ${destination}`;
      const said = reached.map(
        (route) =>
          `gates names ${route}, which ${rewrite} may send a request to, served there with no gate asked`,
      );

      expect(rewriteRefusals(rerouted(optimized, phase, [rule]))).toStrictEqual(said);
    },
  );

  /**
   * The router is handed more names than the build's own (`routerPathnames`): each page's spelling
   * behind the trailing slash an application keeps its pages behind, and the escaped spellings of a
   * page of its own (`namesSpelledBy`). A dynamic route whose destination is one of them lands a
   * path on the page it spells, ahead of the catch-all after it.
   */
  it.each([
    ['behind a trailing slash', '/private', '/private/', true],
    ['escaped', '/sticks & stones', '/sticks%20%26%20stones', false],
  ])(
    'refuses a gate of a page a dynamic route lands a rewrite on, spelled %s',
    (_, page, destination, trailingSlash) => {
      const bundle = classesOf({ [page]: 'checker' });
      const door = { source: '/door', sourceRegex: '^/door(?:/)?$', destination };
      const landing = {
        ...bundle,
        config: { ...bundle.config, trailingSlash },
        entrypoints: [
          ...bundle.entrypoints,
          { id: page, kind: 'app-page' as const, pathname: page },
        ],
        routing: { ...bundle.routing, dynamicRoutes: [door, ...bundle.routing.dynamicRoutes] },
      };

      const rewritten = rerouted(landing, 'afterFiles', [latest('/door')]);

      expect(refusals(rewritten)).toStrictEqual([
        expect.stringContaining(`gates names ${page}, which the rewrite of /latest to /door`),
      ]);
    },
  );

  /**
   * A whole segment of the request's path, and whole segments of it, are never `.` or `..`: the
   * router matches a rule against the URL's path, its dot segments resolved. So a rewrite that puts
   * them under a path of its own reaches no route outside it — as a delivery of the application's
   * own does, a route's params under its key, whatever else a request must or must not carry.
   */
  it('takes a gate no rewrite can reach, with deliveries of a route’s params under a key', () => {
    const gates = { ...GATES, '/private': 'checker' };
    const bundle = rerouted(bundleOf({ gates }), 'beforeFiles', [
      {
        source: '/reports/:team/:rest+',
        sourceRegex: String.raw`^\/reports(?:\/([^\/]+?))(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))(?:\/)?$`,
        destination: '/api/deliver/cmVwb3J0cw/$1/$2',
        missing: [{ type: 'header' as const, key: 'x-direct', value: 'k' }],
      },
      {
        source: '/files/:path*',
        sourceRegex: String.raw`^\/files(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
        destination: '/api/deliver/ZmlsZXM/$1',
      },
    ]);

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

  /**
   * The router sets a destination on the URL as its path, and finds a page of its own by that path
   * decoded whole: an escaped slash, or a dot segment, writes the page as surely as its name does.
   */
  it.each([
    ['an escaped slash', '/private%2Farea'],
    ['an escaped slash ahead of a capture', '/private%2F$1'],
    ['a dot segment', '/elsewhere/../private/area'],
    ['an escape a capture completes', '/private%2$1'],
  ])('refuses a gate of a page a rewrite writes with %s', (_, destination) => {
    const area = '/private/area';
    const bundle = rerouted(
      bundleOf({
        gates: { [area]: 'checker' },
        entrypoints: [...bundleOf().entrypoints, { id: area, kind: 'app-page', pathname: area }],
      }),
      'afterFiles',
      [{ source: '/alias/:p', sourceRegex: '^/alias/([^/]+?)$', destination }],
    );

    expect(refusals(bundle)).toStrictEqual([
      expect.stringMatching(/^gates names \/private\/area, which the rewrite of /u),
    ]);
  });

  /** The router hands another origin only a URL that begins `http://` or `https://`, as written. */
  it('refuses a gate a rewrite reaches by a destination it reads as a path of this origin', () => {
    const all = '/[...all]';
    const bundle = rerouted(
      bundleOf({
        gates: { [all]: 'checker' },
        entrypoints: [{ id: all, kind: 'app-page', pathname: all }],
        prerenders: [],
        routing: {
          ...bundleOf().routing,
          dynamicRoutes: [
            {
              source: all,
              sourceRegex: '^/(?<nxtPall>.+?)(?:/)?$',
              destination: '/[...all]?nxtPall=$nxtPall',
            },
          ],
        },
      }),
      'beforeFiles',
      [
        {
          source: '/shout/:p*',
          sourceRegex: '^/shout(?:/(.*))?$',
          destination: 'HTTPS://blog.example/$1',
        },
      ],
    );

    expect(refusals(bundle)).toStrictEqual([
      expect.stringMatching(/^gates names \/\[\.\.\.all\], which the rewrite of /u),
    ]);
  });

  /** A route may name a segment of its own as a page's prefetch segments are named: its members. */
  it('refuses a gate of a route a segment of whose name ends as prefetch segments do', () => {
    const bundle = rerouted(
      bundleOf({
        gates: { [REPORT]: 'checker' },
        entrypoints: [
          ...bundleOf().entrypoints,
          { id: REPORT, kind: 'app-page', pathname: REPORT },
        ],
        routing: {
          ...bundleOf().routing,
          dynamicRoutes: [...bundleOf().routing.dynamicRoutes, REPORT_ENTRY],
        },
      }),
      'afterFiles',
      [{ source: '/latest', sourceRegex: '^/latest$', destination: '/reports.segments/demo' }],
    );

    expect(refusals(bundle)).toStrictEqual([
      expect.stringMatching(/^gates names \/reports\.segments\/\[slug\], which the rewrite of /u),
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

  /** The same of a route a segment of whose name ends as a page's prefetch segments do. */
  it('names the gated route on those data routes of a route named as prefetch segments are', () => {
    const bundle = bundleOf({
      gates: { [REPORT]: 'checker' },
      entrypoints: [...bundleOf().entrypoints, { id: REPORT, kind: 'app-page', pathname: REPORT }],
      routing: {
        ...bundleOf().routing,
        dynamicRoutes: [
          {
            source: REPORT,
            sourceRegex: String.raw`^/reports\.segments/(?<nxtPslug>[^/]+?)\.segments/reports\.segments/\$d\$slug(?<segment>/__PAGE__\.segment\.rsc|\.segment\.rsc)(?:/)?$`,
            destination:
              '/reports.segments/[slug].segments/reports.segments/$d$slug$segment?nxtPslug=$nxtPslug',
          },
          {
            source: `${REPORT}.rsc`,
            sourceRegex: String.raw`^/reports\.segments/(?<nxtPslug>[^/]+?)(?<rscSuffix>\.rsc|\.segments/.+\.segment\.rsc)(?:/)?$`,
            destination: '/reports.segments/[slug]$rscSuffix?nxtPslug=$nxtPslug',
          },
          {
            source: REPORT,
            sourceRegex: String.raw`^/reports\.segments/(?<nxtPslug>[^/]+?)(?:/)?$`,
            destination: '/reports.segments/[slug]?nxtPslug=$nxtPslug',
          },
        ],
      },
    });
    const routes = dynamicRouting(bundle, new Set()).dynamicRoutes ?? [];

    expect(routes.map((route: DynamicRoute) => route.gated)).toStrictEqual([
      REPORT,
      REPORT,
      REPORT,
    ]);
    expect(gateOf(manifestOf(bundle), '/reports.segments/first.rsc')).toStrictEqual({
      route: REPORT,
      name: 'checker',
    });
  });

  it('names the pathnames Next.js resolves exactly that are of a gated route', () => {
    expect(gatedPathnamesOf(bundleOf({ gates: GATES }))).toStrictEqual({
      [POST]: POST,
      '/posts/demo': POST,
      '/posts/demo.rsc': POST,
    });
  });

  /**
   * The runtime reaches a member through its dynamic routes, the first that holds of it winning: a
   * member of the posts is the posts' gate's, and one of the authors is asked of no gate, though the
   * gated catch-all behind the authors' class also holds of it.
   */
  it('names a member the gated route the dynamic route that lands it is of', () => {
    const posts = classesOf({ [POST]: 'checker' }, [AUTHOR_DEMO, POST_DEMO]);
    const caught = manifestOf(classesOf({ [ALL]: 'checker' }, [AUTHOR_DEMO]));

    expect(gatedPathnamesOf(posts)).toMatchObject({ '/posts/first': POST });
    expect(gatedPathnamesOf(posts)).not.toHaveProperty(['/authors/demo']);
    expect(gateOf(manifestOf(posts), '/posts/first')).toStrictEqual(POST_GATE);
    expect(gateOf(caught, '/authors/demo')).toBeUndefined();
  });

  /**
   * A page of its own the router finds by its name, which it serves in place of any class that also
   * holds of it: no other route's gate is asked of it — nor of its payload, which no class lands.
   */
  it('names no page of its own the gated route of a class that also holds of it', () => {
    const bundle = bundleOf({
      gates: GATES,
      prerenders: [
        ...bundleOf().prerenders,
        ofNewPost('new', '/posts/new'),
        ofNewPost('new.rsc', '/posts/new.rsc'),
      ],
    });

    expect(gatedPathnamesOf(bundle)).not.toHaveProperty(['/posts/new']);
    expect(gatedPathnamesOf(bundle)).not.toHaveProperty(['/posts/new.rsc']);
    expect(gateOf(manifestOf(bundle), '/posts/new')).toBeUndefined();
  });

  /**
   * A member whose name escapes a slash (`/docs/a%2Fb`, of the value `a/b`) is served by the runtime
   * as the page of its own the name also spells decoded (`/docs/a/b`), as Next.js serves it: where
   * neither is gated, nothing names it; a build that gates either is refused (`gatedEitherWay`).
   */
  it('names no member whose name also spells a page of its own, where neither is gated', () => {
    const bundle = docsOf({ '/private': 'checker' });

    expect(refusals(bundle)).toStrictEqual([]);
    expect(gatedPathnamesOf(bundle)).not.toHaveProperty(['/docs/a%2Fb']);
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
  });

  /** As a bundle with both is (`gateIssues`): its rewrites reach a gated route with no gate asked. */
  it('is refused where it declares a gate beside a middleware', () => {
    const middleware = { matchers: [{ sourceRegex: '^/.*$' }] };
    const built = (): ProjectManifest => manifestOf(bundleOf({ gates: GATES }), { middleware });

    expect(built).toThrow(/gate beside a middleware/u);
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

  /**
   * No client says a request is for a page's props: the router routes a page's own request with no
   * `x-nextjs-data`, whatever the client sent, and a rule that asks for it claims none of them.
   */
  it('is the gated page’s, where a client says it asks for props a rule rewrites', () => {
    const rule = {
      source: '/private',
      sourceRegex: '^/private(?:/)?$',
      destination: '/posts/new',
      has: [{ type: 'header' as const, key: 'x-nextjs-data' }],
    };
    const gated = manifestOf(
      rerouted(bundleOf({ gates: { '/private': 'checker' } }), 'beforeFiles', [rule]),
    );
    const asked = new Headers({ 'x-nextjs-data': '1' });

    expect(gateFor(gated, new URL('/private', 'https://app.example'), asked)).toStrictEqual({
      route: '/private',
      name: 'checker',
    });
  });

  it.each([
    ['a member of the gated class', '/posts/abc'],
    ['a member’s payload', '/posts/abc.rsc'],
    ['a member’s prefetch segment', '/posts/abc.segments/_tree.segment.rsc'],
    ['a member the build prerendered', '/posts/demo'],
    ['the payload the build wrote beside it', '/posts/demo.rsc'],
    ['the route itself, as written', '/posts/[slug]'],
    ['a member behind a trailing slash', '/posts/abc/'],
    ['a member in another case, as the router matches a class without regard to it', '/POSTS/abc'],
    ['a member’s payload in another case', '/Posts/abc.RSC'],
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
   * The router finds a file the build ships by its name, ahead of every dynamic route that matches
   * it too. A file kept from the deployment before is no name of this deployment's router, which
   * routes the path as any other.
   */
  it('is none for a file the build ships where a gated class’s pattern matches it as well', () => {
    const file = { ...FILE, immutable: false };
    const bundle = bundleOf({ gates: GATES });
    const shipped = manifestOf(bundle, { staticFiles: { '/posts/logo.png': file } });
    const kept = manifestOf(bundle, {
      staticFiles: { '/posts/logo.png': { ...file, deploymentId: 'dpl_before', dplOnly: true } },
    });

    expect(gateOf(shipped, '/posts/logo.png')).toBeUndefined();
    expect(gateOf(kept, '/posts/logo.png')).toStrictEqual(POST_GATE);
  });

  /**
   * The edge keeps its dynamic routes out of Next.js's namespace under a base path, so as not to
   * hand out a class's shell there; the router routes such a path as any other.
   */
  it('is a class’s for a path in Next.js’s namespace under a base path it matches', () => {
    const docs = '/docs/[...slug]';
    const bundle = bundleOf({
      gates: { [docs]: 'checker' },
      config: { ...bundleOf().config, basePath: '/docs' },
      entrypoints: [{ id: docs, kind: 'app-page', pathname: docs }],
      prerenders: [],
      staticFiles: [],
      routing: {
        ...bundleOf().routing,
        dynamicRoutes: [
          {
            source: docs,
            sourceRegex: '^/docs/(?<nxtPslug>.+?)(?:/)?$',
            destination: '/docs/[...slug]?nxtPslug=$nxtPslug',
          },
        ],
      },
    });
    const based = manifestOf(bundle, { spelledPrefix: { basePath: '/docs' } });

    expect(gateOf(based, '/docs/_next/missing.js')).toStrictEqual({ route: docs, name: 'checker' });
  });

  /**
   * The router routes a path in Next.js's namespace at the root that names nothing of the build as
   * it does any other: a catch-all serves it, and its gate is asked. The image optimizer's own path
   * is a name the router answers itself, ahead of every dynamic route.
   */
  it('is a catch-all’s for a path in Next.js’s namespace it matches, but the optimizer’s', () => {
    const all = '/[...all]';
    const bundle = bundleOf({
      gates: { [all]: 'checker' },
      entrypoints: [{ id: all, kind: 'app-page', pathname: all }],
      prerenders: [],
      routing: {
        ...bundleOf().routing,
        dynamicRoutes: [
          {
            source: all,
            sourceRegex: '^/(?<nxtPall>.+?)(?:/)?$',
            destination: '/[...all]?nxtPall=$nxtPall',
          },
        ],
      },
    });
    const caught = manifestOf(bundle, { images: IMAGES });

    expect(gateOf(caught, '/_next/missing.js')).toStrictEqual({ route: all, name: 'checker' });
    expect(gateOf(caught, '/_next/image')).toBeUndefined();
    // As `next/image` asks for it where the application keeps its pages behind the slash.
    expect(gateOf(caught, '/_next/image/')).toBeUndefined();
  });

  /**
   * An optimizer at a path of its own choosing is answered there ahead of every route, a page of
   * that name among them: the router serves its own path the optimizer's, whatever else is named so.
   */
  it('is none at the optimizer’s own path, where a gated page is named so as well', () => {
    const gated = manifestOf(bundleOf({ gates: { '/private': 'checker' } }), {
      images: { ...IMAGES, path: '/private' },
    });

    expect(gateOf(gated, '/private')).toBeUndefined();
    expect(gateOf(gated, '/private/')).toBeUndefined();
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
  function pagesBundle(): DeploymentBundle {
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

  /**
   * The optimizer's own path is the optimizer's ahead of everything, a page's props named so among
   * them: the edge answers it before it asks any rule or route, and no page's gate of it.
   */
  it('is none where the optimizer’s own path is the name of a page’s props', () => {
    const optimized = withProps({ images: { ...IMAGES, path: today } });

    expect(gateOf(optimized, today)).toBeUndefined();
    expect(gateOf(optimized, `${today}/`)).toBeUndefined();
  });

  /** An App Router page has no props: a request at that name is no request of the page's. */
  it('is none at the name an App Router page’s props would have', () => {
    expect(gateOf(withProps(), `/_next/data/${BUILD}/private.json`)).toBeUndefined();
  });
});
