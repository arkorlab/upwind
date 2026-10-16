import { describe, expect, it } from 'vitest';

import type { ArtifactRef } from '../src/artifact/artifact.ts';
import { declaredRouteGates, gatedPathnamesOf, ROUTE_GATES_ENV } from '../src/bundle/gates.ts';
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

/**
 * A build of a class of posts and a class of authors ahead of a catch-all, in Next.js's order, with
 * a member of the authors and one of the catch-all prerendered — the catch-all's under the posts.
 */
function classesOf(gates: Record<string, string>): DeploymentBundle {
  return bundleOf({
    gates,
    entrypoints: [
      { id: POST, kind: 'app-page', pathname: POST },
      { id: AUTHOR, kind: 'app-page', pathname: AUTHOR },
      { id: ALL, kind: 'app-page', pathname: ALL },
    ],
    prerenders: [
      { id: 'author', pathname: '/authors/demo', route: AUTHOR, parentOutputId: 'a', groupId: 1 },
      { id: 'caught', pathname: '/posts/demo', route: ALL, parentOutputId: 'c', groupId: 2 },
    ],
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

    expect(refusals(author)).toStrictEqual([]);
    expect(refusals(caught)).toStrictEqual([
      expect.stringMatching(/^gates names \/posts\/\[slug\], which the rewrite of /u),
    ]);
  });

  /** A dynamic route with conditions may be passed over, and the one after it reached. */
  it('reads a dynamic route with conditions as one the router may pass over', () => {
    const bundle = classesOf({ [ALL]: 'checker' });
    // The authors' class, asked only of a request with a cookie.
    const dynamicRoutes = bundle.routing.dynamicRoutes.map((route) => {
      return route === AUTHOR_ENTRY
        ? { ...route, has: [{ type: 'cookie' as const, key: 'b' }] }
        : route;
    });
    const conditioned = { ...bundle, routing: { ...bundle.routing, dynamicRoutes } };
    const rewritten = rerouted(conditioned, 'afterFiles', [latest('/authors/demo')]);

    expect(refusals(rewritten)).toStrictEqual([
      expect.stringMatching(/^gates names \/\[\.\.\.all\], which the rewrite of /u),
    ]);
  });

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

  /** The props of a page rendered for each request are asked for at a route of their own. */
  /**
   * The runtime reaches a member through its dynamic routes, the first that holds of it winning: a
   * member of the catch-all under the posts is served by the posts' class ahead of it, and asked of
   * that class's gate.
   */
  it('names a member the gated route a dynamic route ahead of its own lands it on', () => {
    const bundle = classesOf({ [POST]: 'checker' });
    const caught = manifestOf(classesOf({ [ALL]: 'checker' }));

    expect(gatedPathnamesOf(bundle)).toMatchObject({ '/posts/demo': POST });
    expect(gateOf(manifestOf(bundle), '/posts/demo')).toStrictEqual(POST_GATE);
    expect(gateOf(caught, '/authors/demo')).toBeUndefined();
  });

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

  /** An App Router page has no props: a request at that name is no request of the page's. */
  it('is none at the name an App Router page’s props would have', () => {
    expect(gateOf(withProps(), `/_next/data/${BUILD}/private.json`)).toBeUndefined();
  });
});
