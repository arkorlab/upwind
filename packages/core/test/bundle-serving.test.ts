import { describe, expect, it } from 'vitest';

import { seedRouteFor } from '../../host/src/bundle/cache-seed.ts';
import type { DeploymentBundle, Prerender, Route, RouterReferences } from '../src/bundle/schema.ts';
import { prefetchSegments, routePagesData, routePayloads } from '../src/bundle/segments.ts';
import {
  cacheablePrerenders,
  completePrerenders,
  dynamicRouting,
  edgeServablePrerenders,
  edgeServedRewrites,
  foldedHeaderRulesOf,
  headerRulesOf,
  prerenderResponseHeaders,
  type ServableOptions,
  shellHeaders,
} from '../src/bundle/serving.ts';
import { spelledPrefixOf } from '../src/bundle/spelled-prefix.ts';
import { routePathnameOf } from '../src/bundle/spelling.ts';
import {
  staticFileAssetPrefixOf,
  staticFileLocalesOf,
  travelsWithFunction,
} from '../src/bundle/static-files.ts';
import { foldedHeadersFor, headerRulesFor, isReserved } from '../src/manifest/dynamic.ts';
import {
  buildProjectManifest,
  findStaticFile,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import { classifyStaticFile } from '../src/request/classify.ts';
import { filterShellResponseHeaders } from '../src/request/headers.ts';
import {
  type FixtureBundleOptions,
  fixtureBundle,
  ROOT_RSC,
  ROOT_TREE_SEGMENT,
  rootPrerender,
  slashRedirects,
  staticPrerender,
  trailingSlashRedirects,
} from './fixtures/bundle.ts';

const EVERY_PATH = { source: '/(.*)', sourceRegex: String.raw`^(?:\/(.*))(?:\/)?$` };

function ids(prerenders: readonly { id: string }[]): string[] {
  return prerenders.map((prerender) => prerender.id);
}

/** A redirect `next.config` puts ahead of the filesystem, of `source` alone. */
function redirectOf(source: string): Route {
  return {
    source,
    sourceRegex: `^\\${source}(?:\\/)?$`,
    destination: '/elsewhere',
    status: 308,
  };
}

/** The pages the edge serves of the fixture past a rule ahead of the filesystem, complete ones too. */
function servedPast(rule: Route): string[] {
  return ids(edgeServablePrerenders(fixtureBundle({ beforeFiles: [rule] }), { complete: true }));
}

describe('edgeServablePrerenders', () => {
  it('serves the pages with a shell and the state that resumes it, and the reachable class shell', () => {
    expect(edgeServablePrerenders(fixtureBundle()).map((prerender) => prerender.id)).toStrictEqual([
      '/',
      '/items/[id]',
    ]);
  });

  it('leaves a class shell to the Worker when the edge does not reproduce the routing', () => {
    expect(
      edgeServablePrerenders(fixtureBundle({ i18n: true })).map((prerender) => prerender.id),
    ).toStrictEqual(['/']);
  });

  /**
   * `next build` writes a base path into the patterns of its dynamic routes, the pages their
   * destinations name and every pathname of the build, so the edge routes such a build as it
   * routes any other — class shells and all.
   */
  it('serves the class shell of a build with a base path, named under it', () => {
    const served = edgeServablePrerenders(fixtureBundle({ basePath: '/app' }));

    expect(served.map((prerender) => prerender.pathname)).toStrictEqual([
      '/app',
      '/app/items/[id]',
    ]);
  });

  it('leaves a page a conditional header rule covers to the Worker outside reproduced routing', () => {
    const conditional = {
      ...EVERY_PATH,
      has: [{ type: 'header' as const, key: 'x-beta' }],
      headers: { 'x-beta': 'on' },
    };

    expect(
      edgeServablePrerenders(fixtureBundle({ i18n: true, headerRules: [conditional] })),
    ).toStrictEqual([]);
    expect(
      edgeServablePrerenders(fixtureBundle({ headerRules: [conditional] })).map((p) => p.id),
    ).toStrictEqual(['/', '/items/[id]']);
  });

  it('leaves a shell a rule ahead of the filesystem claims to the Worker', () => {
    const redirect = {
      source: '/',
      sourceRegex: String.raw`^\/(?:\/)?$`,
      destination: '/home',
      status: 308,
    };

    expect(
      edgeServablePrerenders(fixtureBundle({ beforeFiles: [redirect] })).map((p) => p.id),
    ).toStrictEqual(['/items/[id]']);
  });

  /**
   * Next.js's router matches the rules of `next.config` without regard to case: a rule ahead of the
   * filesystem written for `/STATIC` claims the page at `/static`, as one written in its own case.
   */
  it('leaves a page a rule ahead of the filesystem claims in another case to the Worker', () => {
    expect(servedPast(redirectOf('/other'))).toContain('/static');
    expect(servedPast(redirectOf('/STATIC'))).not.toContain('/static');
  });

  it('leaves a route on the edge runtime to the Worker: it resumes no shell, and has no generation', () => {
    const bundle = fixtureBundle();
    const onEdge = {
      ...bundle,
      entrypoints: bundle.entrypoints.map((entry) =>
        entry.pathname === '/' ? { ...entry, runtime: 'edge' as const } : entry,
      ),
    };

    expect(edgeServablePrerenders(bundle).map((prerender) => prerender.id)).toContain('/');
    expect(edgeServablePrerenders(onEdge).map((prerender) => prerender.id)).toStrictEqual([
      '/items/[id]',
    ]);
    expect(ids(cacheablePrerenders(bundle))).toContain('/');
    expect(ids(cacheablePrerenders(onEdge))).not.toContain('/');
  });

  it('serves nothing whose status is not 200 or whose resume state is missing', () => {
    const bundle = fixtureBundle();
    const root = rootPrerender();
    const noResume = { ...bundle, prerenders: [{ ...root, postponed: undefined }] };
    const notFound = { ...bundle, prerenders: [{ ...root, initialStatus: 404 }] };

    expect(edgeServablePrerenders(noResume)).toStrictEqual([]);
    expect(edgeServablePrerenders(notFound)).toStrictEqual([]);
  });

  it('serves the pages complete at build time only when asked to, and never an error document', () => {
    const bundle = fixtureBundle();

    expect(ids(completePrerenders(bundle))).toStrictEqual(['/static']);
    expect(ids(edgeServablePrerenders(bundle, { complete: true }))).toStrictEqual([
      '/',
      '/items/[id]',
      '/static',
    ]);
    expect(ids(edgeServablePrerenders(bundle))).toStrictEqual(['/', '/items/[id]']);
  });
});

/**
 * The rule `next build` writes into every build with a deployment id — a host's always have one:
 * the id on each response to the client's router, over every path, holding only for a request with
 * `rsc: 1`. No request the edge answers with a document carries `rsc`, so the rule never sets a
 * header on one. Read as a condition the build cannot settle, it took every page of a build the
 * edge does not route off the edge, and a fixture without the rule could not show it.
 */
describe("a rule only the client's router meets", () => {
  const RSC_RULE = {
    source: '/:path*',
    has: [{ type: 'header' as const, key: 'rsc', value: '1' }],
  };

  it('is what the fixture carries, as every build with a deployment id does', () => {
    expect(fixtureBundle().routing.onMatch).toContainEqual(expect.objectContaining(RSC_RULE));
  });

  it.each([
    ['a build the edge routes', {}, ['/', '/items/[id]', '/static']],
    ['a build with a base path', { basePath: '/app' }, ['/', '/items/[id]', '/static']],
    ['a build with i18n', { i18n: true }, ['/', '/static']],
    ['a build with both', { basePath: '/app', i18n: true }, ['/', '/static']],
  ])('keeps the documents of %s on the edge', (_name, options, expected) => {
    const served = edgeServablePrerenders(fixtureBundle(options), { complete: true });

    expect(ids(served)).toStrictEqual(expected);
  });

  /**
   * The rule is set aside for a document, which no router request asks for. A prefetch of the
   * document's parts is a router request, which the rule does apply to; where the edge does not
   * route the build, the manifest gives it no conditional rule to apply, so the parts of a page the
   * rule covers stay with the Function.
   */
  it.each([
    ['a build the edge routes', {}, ['/', '/items/[id]', '/static']],
    ['a build with i18n', { i18n: true }, []],
    ['a build with a base path and i18n', { basePath: '/app', i18n: true }, []],
  ])(
    'serves the parts of the pages of %s where the edge applies it',
    (_name, options, expected) => {
      const parts = prefetchSegments(withSegments(options), { complete: true });

      expect(parts.map(({ document }) => document.pathname)).toStrictEqual(expected);
    },
  );

  /**
   * Next.js matches a rule's source without regard to case, the router's rules too: one written for
   * `/STATIC` applies to a prefetch of `/static`, so that page's parts stay with the Function.
   */
  it('covers the parts of a page whose path it names in another case', () => {
    const bundle = withSegments({
      i18n: true,
      headerRules: [
        {
          source: '/STATIC',
          sourceRegex: String.raw`^\/STATIC(?:\/)?$`,
          has: RSC_RULE.has,
          headers: { 'x-router': 'yes' },
        },
      ],
    });
    // Without the rule `next build` writes over every path, which covers the parts of every page.
    const onlyThisRule = {
      ...bundle,
      routing: {
        ...bundle.routing,
        onMatch: bundle.routing.onMatch.filter((rule) => rule.has === undefined),
      },
    };

    expect(answered(onlyThisRule, { complete: true })).toStrictEqual([['/', '/_tree']]);
  });

  /**
   * Whatever the value asked for and however the name is spelled: the edge answers no request that
   * carries one of the router's own headers with a document (`classifyRequest`).
   */
  it.each([
    ['rsc', 'RSC', undefined],
    ['next-router-prefetch', 'next-router-prefetch', '1'],
    ['next-router-segment-prefetch', 'Next-Router-Segment-Prefetch', undefined],
    ['next-router-state-tree', 'next-router-state-tree', '.*'],
    ['next-action', 'next-action', undefined],
  ])('takes no page off the edge for a rule that requires %s', (_name, key, value) => {
    const rule = {
      ...EVERY_PATH,
      has: [{ type: 'header' as const, key, ...(value !== undefined && { value }) }],
      headers: { 'x-router': 'yes', Refresh: '0' },
    };
    const redirect = { ...EVERY_PATH, has: rule.has, destination: '/elsewhere', status: 307 };
    const covered = fixtureBundle({ i18n: true, headerRules: [rule] });

    expect(ids(edgeServablePrerenders(covered, { complete: true }))).toStrictEqual([
      '/',
      '/static',
    ]);
    expect(completeIn({ headerRules: [rule] })).toStrictEqual(['/static']);
    expect(completeIn({ i18n: true, redirects: [redirect] })).toStrictEqual(['/static']);
  });

  /**
   * The router's headers are not the only ones a document request lacks, but they are the ones the
   * edge refuses a document for; a header a navigation may carry is judged as a condition still. And
   * a `missing` of a router header holds for every document, so it is a rule that does apply.
   */
  it('reads every other condition as one the request settles', () => {
    const onHeader = { ...EVERY_PATH, has: [{ type: 'header' as const, key: 'x-rsc' }] };
    const unlessRouter = { ...EVERY_PATH, missing: [{ type: 'header' as const, key: 'rsc' }] };
    const onQuery = { ...EVERY_PATH, has: [{ type: 'query' as const, key: 'rsc' }] };

    for (const rule of [onHeader, unlessRouter, onQuery]) {
      const covered = fixtureBundle({
        i18n: true,
        headerRules: [{ ...rule, headers: { 'x-a': '1' } }],
      });

      expect(edgeServablePrerenders(covered, { complete: true })).toStrictEqual([]);
    }
  });

  /** A rule the edge judges on each request is published whatever it holds for: files, too. */
  it('is still published for the edge to judge where it routes the build', () => {
    expect(headerRulesOf(fixtureBundle())).toContainEqual({
      sourceRegex: String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
      has: RSC_RULE.has,
      headers: { 'x-nextjs-deployment-id': 'dpl_4Fixture2Minima1AppXy' },
      phase: 'onMatch',
    });
  });
});

/**
 * Next.js picks the locale of an `i18n` application's root when the request comes — the visitor's
 * `NEXT_LOCALE` cookie or `Accept-Language` — unless locale detection is off; with `domains`, every
 * page is in the locale of the host it is asked on. The edge picks neither, so those pages stay with
 * the deployment's Function.
 */
describe('an i18n build that picks the locale per request', () => {
  it('keeps its root with the Function while it detects the locale', () => {
    const detecting = fixtureBundle({ i18n: true, detectsLocale: true });
    const underBase = fixtureBundle({ basePath: '/app', i18n: true, detectsLocale: true });

    expect(ids(edgeServablePrerenders(detecting, { complete: true }))).toStrictEqual(['/static']);
    expect(ids(edgeServablePrerenders(underBase, { complete: true }))).toStrictEqual(['/static']);
  });

  it('keeps every page with the Function under locale domains', () => {
    const domains = fixtureBundle({ i18n: true, localeDomains: true });

    expect(edgeServablePrerenders(domains, { complete: true })).toStrictEqual([]);
  });
});

/**
 * A redirect or a `beforeFiles` rewrite with a condition claims some requests and not others. The
 * edge asks it of each request where it routes the build; where it does not, the manifest carries
 * no rule for it to ask, and a page such a rule may claim stays with the Function — or the edge
 * would answer the very request the rule redirects.
 */
describe('a conditional claim on a build the edge does not route', () => {
  const claim = {
    source: '/static',
    sourceRegex: String.raw`^\/static(?:\/)?$`,
    destination: '/elsewhere',
    status: 308,
  };

  it('keeps the page it may claim off the edge', () => {
    const onCookie = { ...claim, has: [{ type: 'cookie' as const, key: 'beta' }] };
    const unlessCookie = { ...claim, missing: [{ type: 'cookie' as const, key: 'beta' }] };

    expect(completeIn({ i18n: true, beforeFiles: [onCookie] })).toStrictEqual([]);
    expect(completeIn({ i18n: true, redirects: [unlessCookie] })).toStrictEqual([]);
    // Judged per request where the edge routes the build, with or without a base path.
    expect(completeIn({ beforeFiles: [onCookie] })).toStrictEqual(['/static']);
    expect(completeIn({ basePath: '/app', beforeFiles: [onCookie] })).toStrictEqual(['/static']);
  });

  it('claims no document when only the router meets its condition', () => {
    const onRouter = { ...claim, has: [{ type: 'header' as const, key: 'next-router-prefetch' }] };

    expect(completeIn({ i18n: true, beforeFiles: [onRouter] })).toStrictEqual(['/static']);
  });
});

/**
 * An application that keeps its pages behind a trailing slash (`trailingSlash`) is asked for each
 * of them with it: `next build` redirects `/about` to `/about/` ahead of everything else, and
 * serves the page there. Judged against the name the build gave each page — which has no slash —
 * that redirect claimed every one of them but the root, which it leaves alone.
 */
/** A shipped file whose name has no extension: a last segment that names no file. */
const MANUAL_BLOB = {
  sha256: 'a'.repeat(64),
  byteLength: 16,
  contentType: 'application/octet-stream',
};

/** The fixture with its pages kept behind a trailing slash, and the redirects that come with it. */
function slashed(basePath = ''): DeploymentBundle {
  return fixtureBundle({
    basePath,
    trailingSlash: true,
    redirects: trailingSlashRedirects(basePath),
  });
}

describe('a build that keeps its pages behind a trailing slash', () => {
  it.each([
    ['', ['/', '/items/[id]', '/static/']],
    ['/docs', ['/docs/', '/docs/items/[id]', '/docs/static/']],
  ])('serves every page at the spelling asked for, base path %j', (basePath, routes) => {
    const bundle = slashed(basePath);
    const served = edgeServablePrerenders(bundle, { complete: true });

    expect(ids(served)).toStrictEqual(['/', '/items/[id]', '/static']);
    // Named for the edge by that spelling, and a class by its template, which no request spells.
    expect(served.map((prerender) => routePathnameOf(bundle, prerender))).toStrictEqual(routes);
  });

  /** A last segment that names a file is asked for without the slash, which Next.js takes off. */
  it('names a page whose last segment names a file without one', () => {
    const bundle = slashed();
    const feed = {
      ...staticPrerender(),
      id: '/feed.xml',
      pathname: '/feed.xml',
      route: '/feed.xml',
      groupId: 9,
    };
    const withFeed = {
      ...bundle,
      entrypoints: [
        ...bundle.entrypoints,
        { id: 'app/feed.xml/page', kind: 'app-page' as const, pathname: '/feed.xml' },
      ],
      prerenders: [...bundle.prerenders, feed],
    };

    expect(ids(completePrerenders(withFeed))).toContain('/feed.xml');
    expect(routePathnameOf(withFeed, feed)).toBe('/feed.xml');
  });

  /**
   * A page of its own that a dynamic route's pattern also matches — `/items/new` beside
   * `/items/[id]` — is listed as one, which Next.js finds decoded whole ahead of the route and the
   * pattern cannot tell from a member; a page no pattern matches is not, nor is a template.
   */
  it('lists the pages of their own a dynamic route also matches', () => {
    const bundle = fixtureBundle();
    const withNew: DeploymentBundle = {
      ...bundle,
      entrypoints: [
        ...bundle.entrypoints,
        { id: '/items/new', kind: 'app-page', pathname: '/items/new' },
      ],
    };

    expect(dynamicRouting(bundle, new Set()).filesystemPages).toStrictEqual([]);
    expect(dynamicRouting(withNew, new Set()).filesystemPages).toStrictEqual(['/items/new']);
  });

  /**
   * Both spellings of a page with no shell resolve to it, ahead of any class that would match
   * either: the one with the slash is the page, and the one without is the redirect to it.
   */
  it('publishes the routing under the spelling asked for', () => {
    const bundle = slashed();
    const routing = dynamicRouting(bundle, new Set(['/', '/items/[id]', '/static/']));

    expect(routing.trailingSlash).toBe(true);
    expect(routing.exactPathnames).toStrictEqual(
      expect.arrayContaining(['/static', '/stream', '/stream/']),
    );
    expect(routing.exactPathnames).not.toContain('/static/');
    expect(routing.exactPathnames).not.toContain('/');
    expect(dynamicRouting(fixtureBundle(), new Set()).trailingSlash).toBeUndefined();
    // Said of a build the edge does not route as well, whose routes are named the same way, and
    // whose files the router finds by the slash as well.
    expect(
      dynamicRouting(fixtureBundle({ i18n: true, trailingSlash: true }), new Set()),
    ).toStrictEqual({ trailingSlash: true, staticFileTrailingSlash: true });
  });

  /**
   * The router finds a shipped file whose last segment names no file by its spelling with the slash
   * as well (`/manual/` is `/manual`): it is exact, and no member of a class that matches it — and
   * the edge's lookup of a file finds the file by it too (`staticFileKey`).
   */
  it('publishes the slashed spelling of a shipped file that names no file as exact', () => {
    const bundle = slashed();
    const manual = { pathname: '/manual', blob: MANUAL_BLOB, immutable: false };
    const routing = dynamicRouting(
      { ...bundle, staticFiles: [...bundle.staticFiles, manual] },
      new Set(['/', '/items/[id]', '/static/']),
    );

    expect(routing.exactPathnames).toContain('/manual/');
    expect(routing.exactPathnames).not.toContain('/manual');
    expect(routing.exactPathnames).not.toContain('/hello.txt/');
  });

  /**
   * Next.js's redirect gives a path under `/.well-known` no slash, but its router finds a page
   * there by its spelling with one all the same: both spellings are exact.
   */
  it('publishes both spellings of a page under .well-known as exact', () => {
    const bundle = slashed();
    const page = { ...staticPrerender(), id: '/.well-known/acme', pathname: '/.well-known/acme' };
    const routing = dynamicRouting(
      { ...bundle, prerenders: [...bundle.prerenders, page] },
      new Set(['/', '/items/[id]', '/static/']),
    );

    expect(routing.exactPathnames).toStrictEqual(
      expect.arrayContaining(['/.well-known/acme', '/.well-known/acme/']),
    );
  });

  /**
   * `skipTrailingSlashRedirect` leaves the redirect out, and Next.js serves a page at both spellings:
   * the edge keeps the one the build named it by, as it did before it knew the other.
   */
  it('keeps the name the build gave a page where the build writes no redirect to the slash', () => {
    const bundle = fixtureBundle({ trailingSlash: true, skipTrailingSlashRedirect: true });
    const served = edgeServablePrerenders(bundle, { complete: true });

    expect(served.map((prerender) => routePathnameOf(bundle, prerender))).toStrictEqual([
      '/',
      '/items/[id]',
      '/static',
    ]);
    expect(dynamicRouting(bundle, new Set()).trailingSlash).toBeUndefined();
    // Its files are still found by the slash: the router finds them so with no redirect at all.
    expect(dynamicRouting(bundle, new Set()).staticFileTrailingSlash).toBe(true);
  });

  /**
   * Without the redirect the router still finds a page, and a shipped file that names no file, by
   * the spelling with the slash (`/stream/` is `/stream`, `/manual/` is `/manual`): that spelling is
   * exact, and the edge keeps the page at the name the build gave it.
   */
  it('publishes the slashed spellings as exact where the build writes no redirect to the slash', () => {
    const bundle = fixtureBundle({ trailingSlash: true, skipTrailingSlashRedirect: true });
    const manual = { pathname: '/manual', blob: MANUAL_BLOB, immutable: false };
    const routing = dynamicRouting(
      { ...bundle, staticFiles: [...bundle.staticFiles, manual] },
      new Set(['/', '/items/[id]', '/static']),
    );

    expect(routing.exactPathnames).toStrictEqual(
      expect.arrayContaining(['/static/', '/stream', '/stream/', '/manual/']),
    );
    expect(routing.exactPathnames).not.toContain('/static');
  });

  /**
   * The redirect leaves a path that begins `/.well-known` alone; under a base path the same name
   * is a path like any other, and gains the slash. Any path that begins so, not only the segment:
   * the redirect's pattern, `(?!\.well-known(?:/.*)?)`, has no boundary after the name, so Next.js
   * 16.3.8 leaves `/.well-knownness/page` without the slash too, and serves it there.
   */
  it.each([
    ['', '/.well-known/change-password', '/.well-known/change-password'],
    ['', '/.well-knownness/page', '/.well-knownness/page'],
    // In any case: the router matches its rules without regard to case.
    ['', '/.WELL-KNOWN/acme', '/.WELL-KNOWN/acme'],
    ['/docs', '/docs/.well-known/change-password', '/docs/.well-known/change-password/'],
  ])('names %j a page under .well-known as the redirect leaves it', (basePath, pathname, key) => {
    const bundle = slashed(basePath);
    const page = { ...staticPrerender(), id: pathname, pathname, route: pathname, groupId: 9 };

    expect(routePathnameOf(bundle, page)).toBe(key);
  });

  /**
   * `next build` redirects the base path's own root to its spelling with the slash by name, whatever
   * its last segment reads like — `/docs.v1` is no file.
   */
  it("names the base path's root behind the slash, a dotted one too", () => {
    const bundle = slashed('/docs.v1');
    const [root] = edgeServablePrerenders(bundle);

    expect(root?.pathname).toBe('/docs.v1');
    expect(root === undefined ? undefined : routePathnameOf(bundle, root)).toBe('/docs.v1/');
  });

  /**
   * A rule is judged against the request, which asks for the page behind the slash: the redirect
   * to it sets no `Location` on the page, or on a route handler's generation, which kept it.
   */
  it('judges the rules of the build against the spelling asked for', () => {
    const bundle = slashed();
    const handler = {
      ...staticPrerender(),
      id: '/api/hello',
      pathname: '/api/hello',
      route: '/api/hello',
      routeType: 'route' as const,
    };

    expect(prerenderResponseHeaders(bundle, staticPrerender()).has('location')).toBe(false);
    expect(prerenderResponseHeaders(bundle, handler).has('location')).toBe(false);
    expect(shellHeaders(bundle, staticPrerender())).not.toHaveProperty('location');
  });
});

/** The `_tree` segment of a route, as the build writes one beside that route's document. */
function treeSegment(route: string, groupId: number): Prerender {
  return {
    id: `${route}.segments/_tree.segment.rsc`,
    pathname: `${route}.segments/_tree.segment.rsc`,
    route,
    parentOutputId: route,
    groupId,
    segmentPath: '/_tree',
    body: ROOT_TREE_SEGMENT,
  };
}

/**
 * The fixture carries the root's own `_tree` segment. This adds the same for the class shell of the
 * dynamic route and for the page complete at build time, so each delivery can be asked which of the
 * three it answers.
 */
function withSegments(options: FixtureBundleOptions = {}): DeploymentBundle {
  const bundle = fixtureBundle(options);
  // Named under the base path, as the build names its documents.
  const base = options.basePath ?? '';
  return {
    ...bundle,
    prerenders: [
      ...bundle.prerenders,
      treeSegment(`${base}/items/[id]`, 2),
      treeSegment(`${base}/static`, 3),
    ],
  };
}

/** Each segment by the document it belongs to and the header value it answers. */
function answered(bundle: DeploymentBundle, options: ServableOptions = {}): string[][] {
  const segments = prefetchSegments(bundle, options);
  return segments.map(({ document, segmentPath }) => [document.pathname, segmentPath]);
}

describe('prefetchSegments', () => {
  it('answers for every document the edge serves, by the header value each segment answers', () => {
    expect(answered(withSegments(), { complete: true })).toStrictEqual([
      ['/', '/_tree'],
      ['/items/[id]', '/_tree'],
      ['/static', '/_tree'],
    ]);
  });

  /** A build with a base path is routed at the edge as any other, and its documents keep parts. */
  it('answers for the documents of a build with a base path, named under it', () => {
    expect(answered(withSegments({ basePath: '/app' }), { complete: true })).toStrictEqual([
      ['/app', '/_tree'],
      ['/app/items/[id]', '/_tree'],
      ['/app/static', '/_tree'],
    ]);
  });

  /**
   * The same question the documents were asked, through the same options. A host serving a page's
   * prefetches while its Function serves the page lets the two disagree about it.
   */
  it('leaves the segments of a page the edge does not serve under this delivery', () => {
    // Without `complete`, the page complete at build time is the Function's, and so are its parts.
    expect(answered(withSegments())).toStrictEqual([
      ['/', '/_tree'],
      ['/items/[id]', '/_tree'],
    ]);
    // `i18n` takes the class shell of the dynamic route off the edge, and only that one: the
    // exact pages keep their documents. Not their parts, though: the rule Next.js writes for every
    // RSC response covers them, and the edge does not route such a build (see below).
    expect(answered(withSegments({ i18n: true }), { complete: true })).toStrictEqual([]);
  });

  /**
   * The RSC and prefetch outputs that travel beside a document are not prefetch segments, and a
   * build that recorded no segment path has none to offer — its Function answers every prefetch.
   */
  it('offers nothing for an output that is not a segment, or a build that recorded none', () => {
    const bundle = fixtureBundle();
    const unrecorded = {
      ...bundle,
      prerenders: bundle.prerenders.map((prerender) => ({ ...prerender, segmentPath: undefined })),
    };

    expect(answered(bundle, { complete: true })).toStrictEqual([['/', '/_tree']]);
    expect(prefetchSegments(unrecorded, { complete: true })).toStrictEqual([]);
  });

  /** Bytes to serve. A segment the build declared but wrote nothing for cannot be answered from. */
  it('offers nothing for a segment with no body', () => {
    const bundle = fixtureBundle();
    const bodiless = {
      ...bundle,
      prerenders: bundle.prerenders.map((prerender) =>
        prerender.segmentPath === undefined ? prerender : { ...prerender, body: undefined },
      ),
    };

    expect(prefetchSegments(bodiless, { complete: true })).toStrictEqual([]);
  });
});

/** The whole payload the build writes beside a page's document: `<pathname>.rsc`, in its group. */
function payloadTwin(document: string, fields: Partial<Prerender> = {}): Prerender {
  return {
    id: `${document}.rsc`,
    pathname: `${document}.rsc`,
    route: document,
    parentOutputId: document,
    groupId: 3,
    body: ROOT_RSC,
    ...fields,
  };
}

/** The fixture, with the payload of its page complete at build time beside that page's document. */
function withPayload(options: FixtureBundleOptions = {}, fields: Partial<Prerender> = {}) {
  const bundle = fixtureBundle(options);
  // Named under the base path, as the build names its documents.
  const twin = payloadTwin(`${options.basePath ?? ''}/static`, fields);
  return { ...bundle, prerenders: [...bundle.prerenders, twin] };
}

/** Each payload by the document it is the payload of and the output it is read from. */
function payloads(bundle: DeploymentBundle, options: ServableOptions = {}): string[][] {
  const found = routePayloads(bundle, options);
  return found.map(({ document, prerender }) => [document.pathname, prerender.pathname]);
}

/** The fixture under `basePath`, its root a page the build finished, its payload beside it. */
function finishedRootUnder(basePath: string): DeploymentBundle {
  const bundle = fixtureBundle({ basePath });
  const root = basePath === '' ? '/' : basePath;
  const twin = `${basePath}/index.rsc`;
  return {
    ...bundle,
    prerenders: bundle.prerenders.map((prerender) => {
      if (prerender.pathname === root) {
        return { ...prerender, postponed: undefined, response: 'complete', compute: 'static' };
      }
      if (prerender.pathname === twin) {
        return { ...prerender, postponed: undefined, body: ROOT_RSC };
      }
      return prerender;
    }),
  };
}

describe('routePayloads', () => {
  it('answers for a page the build finished, from the twin it wrote beside the document', () => {
    expect(payloads(withPayload(), { complete: true })).toStrictEqual([['/static', '/static.rsc']]);
    expect(payloads(withPayload({ basePath: '/app' }), { complete: true })).toStrictEqual([
      ['/app/static', '/app/static.rsc'],
    ]);
  });

  /** The root's payload is named `/index`, as `next build` names it in every file it writes. */
  it('reads the root’s payload under the name the build gives it', () => {
    const finished = finishedRootUnder('');

    expect(payloads(finished, { complete: true })).toContainEqual(['/', '/index.rsc']);
  });

  /** The same question the documents and their parts were asked, through the same options. */
  it('leaves the payload of a page the edge does not serve, or does not route', () => {
    expect(payloads(withPayload())).toStrictEqual([]);
    expect(payloads(withPayload({ i18n: true }), { complete: true })).toStrictEqual([]);
  });

  /**
   * A page a resume completes has its payload rendered for the request, as its document is: the
   * root's twin is left even with bytes and no state of its own, and the class shell of the dynamic
   * route has none.
   */
  it('offers nothing for a page a resume completes', () => {
    const bundle = fixtureBundle();
    const written = {
      ...bundle,
      prerenders: bundle.prerenders.map((prerender) => {
        if (prerender.id !== '/index.rsc') {
          return prerender;
        }
        return { ...prerender, body: ROOT_RSC, postponed: undefined };
      }),
    };

    expect(payloads(written, { complete: true })).toStrictEqual([]);
  });

  it.each([
    ['no bytes', { body: undefined }],
    ['the state of a resume', { postponed: ROOT_TREE_SEGMENT }],
    ['a status of its own', { initialStatus: 404 }],
    ['another group', { groupId: 9 }],
    ['another route', { route: '/other' }],
  ])('offers nothing for a twin with %s', (_name, fields) => {
    expect(payloads(withPayload({}, fields), { complete: true })).toStrictEqual([]);
  });

  /**
   * `next build` names the files beside a document by `normalizePagePath`, under the base path:
   * the root of a build with one is `/app` and its payload `/app/index.rsc`, and a route that
   * begins with `/index` is nested under a second one.
   */
  it('reads a payload under the name the build spells its document by', () => {
    const nested = withPayload();
    const indexPage = {
      ...staticPrerender(),
      id: '/index/about',
      pathname: '/index/about',
      route: '/index/about',
      parentOutputId: '/index/about',
      groupId: 7,
    };
    const indexTwin = payloadTwin('/index/index/about', {
      route: '/index/about',
      parentOutputId: '/index/about',
      groupId: 7,
    });
    const withIndexPage = { ...nested, prerenders: [...nested.prerenders, indexPage, indexTwin] };

    const underBase = finishedRootUnder('/app');

    expect(payloads(underBase, { complete: true })).toContainEqual(['/app', '/app/index.rsc']);
    expect(payloads(withIndexPage, { complete: true })).toContainEqual([
      '/index/about',
      '/index/index/about.rsc',
    ]);
  });

  /**
   * In a build the edge does not route, a rule only the router meets keeps a page's parts and
   * payload with the Function — judged against the spelling the router asks for it by, which for
   * a build that keeps its pages behind a slash is the one with it.
   */
  it('judges a rule only the router meets against the spelling it asks by', () => {
    const rule = {
      source: '/static/',
      sourceRegex: '^/static/$',
      has: [{ type: 'header' as const, key: 'next-router-prefetch' }],
      headers: { 'x-prefetched': '1' },
    };
    const bundle = withPayload({ i18n: true, trailingSlash: true, headerRules: [rule] });
    // Without the rule Next.js writes for every RSC response, which would cover every page.
    const onlyThisRule = {
      ...bundle,
      routing: {
        ...bundle.routing,
        onMatch: bundle.routing.onMatch.filter((route) => route.has === undefined),
      },
    };
    const unruled = {
      ...onlyThisRule,
      routing: { ...onlyThisRule.routing, beforeMiddleware: [] },
    };

    expect(payloads(unruled, { complete: true })).toStrictEqual([['/static', '/static.rsc']]);
    expect(payloads(onlyThisRule, { complete: true })).toStrictEqual([]);
  });

  it('takes a twin that states the status a payload is answered with', () => {
    expect(payloads(withPayload({}, { initialStatus: 200 }), { complete: true })).toStrictEqual([
      ['/static', '/static.rsc'],
    ]);
  });
});

/** The props `next build` writes beside a Pages Router page, as JSON. */
const PAGE_PROPS = { sha256: '7'.repeat(64), byteLength: 60, contentType: 'application/json' };

/**
 * The fixture with its page `/static` one the Pages Router renders, and the props the build wrote
 * beside its document: `<basePath>/_next/data/<buildId>/static.json`, in the document's group.
 */
function pagesBuild(
  options: FixtureBundleOptions = {},
  fields: Partial<Prerender> = {},
): DeploymentBundle {
  const bundle = fixtureBundle(options);
  const page = `${options.basePath ?? ''}/static`;
  const data = `${options.basePath ?? ''}/_next/data/${bundle.buildId}/static.json`;
  const props: Prerender = {
    id: data,
    pathname: data,
    route: page,
    parentOutputId: page,
    groupId: 3,
    body: PAGE_PROPS,
    initialHeaders: { 'content-type': 'application/json' },
    ...fields,
  };
  return {
    ...bundle,
    entrypoints: bundle.entrypoints.map((entry) =>
      entry.pathname === page ? { id: 'pages/static', kind: 'pages', pathname: page } : entry,
    ),
    prerenders: [...bundle.prerenders, props],
  };
}

/** Each page's props by the document they are the props of and the output they are read from. */
function pagesData(bundle: DeploymentBundle, options: ServableOptions = {}): string[][] {
  const found = routePagesData(bundle, options);
  return found.map(({ document, prerender }) => [document.pathname, prerender.pathname]);
}

describe('routePagesData', () => {
  const props = '/_next/data/build-TfctsWXpff2fKS/static.json';

  it('answers for a Pages Router page the build finished, from the props written beside it', () => {
    expect(pagesData(pagesBuild(), { complete: true })).toStrictEqual([['/static', props]]);
    expect(pagesData(pagesBuild({ basePath: '/app' }), { complete: true })).toStrictEqual([
      ['/app/static', `/app${props}`],
    ]);
  });

  /** An App Router page has a payload instead (`routePayloads`), which its client asks for. */
  it('offers nothing for a page the App Router renders', () => {
    const bundle = pagesBuild();
    const appPage = {
      ...bundle,
      entrypoints: fixtureBundle().entrypoints,
    };

    expect(pagesData(appPage, { complete: true })).toStrictEqual([]);
  });

  /** The same question the documents and their parts were asked, through the same options. */
  it('leaves the props of a page the edge does not serve', () => {
    expect(pagesData(pagesBuild())).toStrictEqual([]);
  });

  /**
   * The rules a data request meets are judged against its own URL, which needs every rule in the
   * manifest and a routing that matches the URL as it is: a build with `i18n` publishes no rule but
   * Next.js's own, and one with a middleware matches its rules against the page a data URL names.
   */
  it('offers nothing in a build whose routing does not take a data URL as it is', () => {
    const middleware = pagesBuild();
    const normalized = {
      ...middleware,
      routing: { ...middleware.routing, shouldNormalizeNextData: true },
    };

    expect(pagesData(pagesBuild({ i18n: true }), { complete: true })).toStrictEqual([]);
    expect(pagesData(normalized, { complete: true })).toStrictEqual([]);
  });

  /**
   * Even where nothing the router alone meets covers the page: what `i18n` keeps from the manifest
   * is the rules, which a data request needs judged against its own URL.
   */
  it('offers nothing in a build with `i18n`, whose rules the manifest does not carry', () => {
    const localised = pagesBuild({ i18n: true });
    // Without the rule Next.js writes for every RSC response, which covers every page's parts.
    const unruled = {
      ...localised,
      routing: {
        ...localised.routing,
        onMatch: localised.routing.onMatch.filter((route) => route.has === undefined),
      },
    };

    expect(prefetchSegments(unruled, { complete: true })).not.toStrictEqual([]);
    expect(pagesData(unruled, { complete: true })).toStrictEqual([]);
  });

  /** A request names nothing under `/a/../b` by the names the build gave it: a URL resolves it. */
  it('offers nothing under a base path no request spells as written', () => {
    expect(pagesData(pagesBuild({ basePath: '/a/b' }), { complete: true })).toHaveLength(1);
    expect(pagesData(pagesBuild({ basePath: '/a/../b' }), { complete: true })).toStrictEqual([]);
  });

  /** Nor under a build id that is one: the props are written under it, and asked for under another. */
  it('offers nothing under a build id no request spells as written', () => {
    const bundle = pagesBuild();
    const named = '/_next/data/a/../b/static.json';
    const odd = {
      ...bundle,
      buildId: 'a/../b',
      prerenders: bundle.prerenders.map((prerender) => {
        return prerender.pathname.startsWith('/_next/data/')
          ? { ...prerender, id: named, pathname: named }
          : prerender;
      }),
    };

    expect(pagesData(odd, { complete: true })).toStrictEqual([]);
  });

  it.each([
    ['no bytes', { body: undefined }],
    ['the state of a resume', { postponed: ROOT_TREE_SEGMENT }],
    ['a status of its own', { initialStatus: 404 }],
    ['another group', { groupId: 9 }],
    ['another route', { route: '/other' }],
    ['another build’s name', { pathname: '/_next/data/build-0/static.json' }],
  ])('offers nothing for props with %s', (_name, fields) => {
    expect(pagesData(pagesBuild({}, fields), { complete: true })).toStrictEqual([]);
  });

  it('takes props that state the status they are answered with', () => {
    expect(pagesData(pagesBuild({}, { initialStatus: 200 }), { complete: true })).toStrictEqual([
      ['/static', props],
    ]);
  });
});

describe('cacheablePrerenders', () => {
  it.each([
    { route: '/api/items/[id]', pathname: '/api/items/a', allowQuery: ['nxtPid'] },
    { route: '/api/items/[id]', pathname: '/api/items/a', allowQuery: ['id', 'nxtPid'] },
    { route: '/api/items/[...slug]', pathname: '/api/items/a/b', allowQuery: ['nxtPslug'] },
    { route: '/api/items/[[...slug]]', pathname: '/api/items', allowQuery: ['slug', 'nxtPslug'] },
  ])(
    'seeds concrete route handlers with pathname-derived parameters: $route $allowQuery',
    async ({ route, pathname, allowQuery }) => {
      const prerender = {
        ...rootPrerender(),
        id: pathname,
        route,
        pathname,
        routeType: 'route' as const,
        response: 'complete' as const,
        compute: 'static' as const,
        postponed: undefined,
        initialRevalidate: 60,
        allowQuery,
      };
      const bundle = {
        ...fixtureBundle(),
        entrypoints: [{ id: route, pathname: route, kind: 'app-route' as const }],
        prerenders: [prerender],
      };
      const selected = cacheablePrerenders(bundle);
      const seeds = await Promise.all(
        selected.map((item) => {
          return seedRouteFor(bundle, item, {
            scopeId: 'dpl_routeAliasTest',
            generatedAt: 1_800_000_000_000,
          });
        }),
      );

      expect(selected).toStrictEqual([prerender]);
      expect(seeds).toMatchObject([
        {
          input: {
            descriptor: { kind: 'app-route', route, pathname },
            generation: {
              policy: { revalidateAfter: { kind: 'finite', seconds: 60 } },
              outputs: [{ representationKey: 'route-body', pathname }],
            },
          },
        },
      ]);
    },
  );

  it.each([['variant'], ['nxtPother'], ['nxtPid', 'variant']])(
    'excludes concrete route handlers that also depend on request query keys: %j',
    (...allowQuery) => {
      const prerender = {
        ...rootPrerender(),
        id: '/api/items/a',
        route: '/api/items/[id]',
        pathname: '/api/items/a',
        routeType: 'route' as const,
        response: 'complete' as const,
        compute: 'static' as const,
        allowQuery,
      };

      expect(cacheablePrerenders({ ...fixtureBundle(), prerenders: [prerender] })).toStrictEqual(
        [],
      );
    },
  );

  it('excludes query-dependent route handlers from pathname-only entries', () => {
    const bundle = fixtureBundle();
    const route = {
      ...rootPrerender(),
      routeType: 'route' as const,
      response: 'complete' as const,
      compute: 'static' as const,
    };

    expect(ids(cacheablePrerenders({ ...bundle, prerenders: [route] }))).toStrictEqual(['/']);
    expect(
      cacheablePrerenders({ ...bundle, prerenders: [{ ...route, allowQuery: ['page'] }] }),
    ).toStrictEqual([]);
  });

  it('holds every document the edge may serve whose key is its pathname alone', () => {
    const bundle = fixtureBundle();
    const root = rootPrerender();
    const withQuery = {
      ...bundle,
      prerenders: bundle.prerenders.map((prerender) =>
        prerender.id === root.id ? { ...prerender, allowQuery: ['q'] } : prerender,
      ),
    };

    expect(cacheablePrerenders(bundle).map((p) => p.id)).toStrictEqual([
      '/',
      '/items/[id]',
      '/static',
    ]);
    expect(cacheablePrerenders(withQuery).map((p) => p.id)).toStrictEqual([
      '/items/[id]',
      '/static',
    ]);
  });

  /**
   * A rule ahead of the filesystem that claims a page's path keeps the page off the edge, and the
   * Worker answers it wherever a rewrite or a middleware still leads to it. Left unseeded it had no
   * generation to answer from, and served the build's document for good: no `revalidate` or
   * `revalidatePath` ever reached it.
   */
  it('holds what a rule keeps off the edge, which the Worker answers from a generation', () => {
    const redirect = {
      source: '/',
      sourceRegex: String.raw`^\/(?:\/)?$`,
      destination: '/home',
      status: 308,
    };
    const claimed = fixtureBundle({ beforeFiles: [redirect] });

    expect(ids(edgeServablePrerenders(claimed))).not.toContain('/');
    expect(ids(cacheablePrerenders(claimed))).toContain('/');
  });

  it("leaves a Pages Router route's fallback document to the build: a loading page is not the page", () => {
    const bundle = fixtureBundle();
    const complete = {
      ...bundle,
      prerenders: bundle.prerenders.map((prerender) => {
        return prerender.id === '/items/[id]'
          ? {
              ...prerender,
              response: 'complete' as const,
              compute: 'static' as const,
              postponed: undefined,
            }
          : prerender;
      }),
    };
    const onPages = {
      ...complete,
      entrypoints: complete.entrypoints.map((entry) =>
        entry.pathname === '/items/[id]' ? { ...entry, kind: 'pages' as const } : entry,
      ),
    };

    // An App Router class shell complete in itself is the page for every member; the Pages
    // Router's is not, so neither the cache nor the edge takes it.
    expect(ids(completePrerenders(complete))).toContain('/items/[id]');
    expect(ids(completePrerenders(onPages))).not.toContain('/items/[id]');
    expect(ids(cacheablePrerenders(onPages))).not.toContain('/items/[id]');
    expect(ids(edgeServablePrerenders(onPages, { complete: true }))).not.toContain('/items/[id]');
  });
});

/** What the selector takes from a build whose one page is complete, with these rules over it. */
function completeIn(options: FixtureBundleOptions): string[] {
  return ids(completePrerenders(fixtureBundle(options)));
}

/** The same, for a build whose finished page answers with these headers of its own. */
function completeWithHeaders(headers: Record<string, string>): string[] {
  const bundle = fixtureBundle();
  const page = staticPrerender();
  const prerenders = [{ ...page, initialHeaders: { ...page.initialHeaders, ...headers } }];
  return ids(completePrerenders({ ...bundle, prerenders }));
}

describe('completePrerenders', () => {
  /**
   * Next.js's error documents are rendered for a status, never for a request at their own name —
   * and a base path puts that name under the prefix, as it puts every name of the build.
   */
  it.each(['', '/app'])('leaves out an error document under the base path %j', (basePath) => {
    const bundle = fixtureBundle({ basePath });
    const errorPage = {
      ...staticPrerender(),
      id: '/_error',
      pathname: `${basePath}/_error`,
      route: `${basePath}/_error`,
      parentOutputId: '/_error',
      groupId: 8,
    };
    const withError = { ...bundle, prerenders: [...bundle.prerenders, errorPage] };

    expect(ids(completePrerenders(withError))).toStrictEqual(['/static']);
  });

  /**
   * The edge refuses a page a redirect or a `beforeFiles` rewrite claims, so naming one the rules
   * claim from every request would promise a document the edge never sends — and the deployment
   * run, which asks the edge for a sample of what it named, would be answered with the redirect
   * and refuse its own deployment. A rule with conditions claims some requests and not others,
   * which is a question about a request rather than about a build.
   */
  it('leaves a page every request is claimed from to the Worker', () => {
    const claim = { source: '/static', sourceRegex: String.raw`^\/static(?:\/)?$` };
    const redirect = { ...claim, destination: '/elsewhere', status: 308 };
    const onCookie = { ...redirect, has: [{ type: 'cookie' as const, key: 'beta' }] };
    const onHeader = { ...redirect, has: [{ type: 'header' as const, key: 'accept' }] };
    const unlessCookie = { ...redirect, missing: [{ type: 'cookie' as const, key: 'beta' }] };

    expect(completeIn({ beforeFiles: [redirect] })).toStrictEqual([]);
    // A rule with conditions claims some requests and not others, which the edge judges per
    // request and the deployment run asks of the manifest before it samples one (`validateOne`).
    expect(completeIn({ beforeFiles: [onCookie] })).toStrictEqual(['/static']);
    expect(completeIn({ beforeFiles: [onHeader] })).toStrictEqual(['/static']);
    expect(completeIn({ beforeFiles: [unlessCookie] })).toStrictEqual(['/static']);
    // A header rule of the same phase claims nothing: it answers no request and rewrites none.
    expect(completeIn({ headerRules: [{ ...claim, headers: {} }] })).toStrictEqual(['/static']);
  });

  /**
   * A shell that answers with one of these is caught at request time: the continuation carries
   * the header and the edge condemns the route. A page the build finished starts no continuation,
   * so nothing would ever see the difference — it stays with the Worker instead.
   */
  it('leaves a page whose headers do something the edge would not replay to the Worker', () => {
    const downloads = {
      ...EVERY_PATH,
      has: [{ type: 'cookie' as const, key: 'download' }],
      headers: { 'Content-Disposition': 'attachment' },
    };

    expect(completeWithHeaders({ refresh: '0; url=/elsewhere' })).toStrictEqual([]);
    expect(completeWithHeaders({ 'clear-site-data': '"cache"' })).toStrictEqual([]);
    expect(completeWithHeaders({ 'content-disposition': 'attachment' })).toStrictEqual([]);
    // A disposition that renders the page where it is changes nothing about it.
    expect(completeWithHeaders({ 'content-disposition': 'inline' })).toStrictEqual(['/static']);
    // And a rule of `next.config` says the same thing as a recorded header does — including one
    // with a condition, which the edge would judge per request and then drop the header anyway.
    expect(
      completeIn({ headerRules: [{ ...EVERY_PATH, headers: { Refresh: '0' } }] }),
    ).toStrictEqual([]);
    expect(completeIn({ headerRules: [downloads] })).toStrictEqual([]);
  });
});

describe('shellHeaders', () => {
  it.each([
    [':locale', '^/(?<locale>[^/]+)/docs$'],
    ['$1', '^/([^/]+)/docs$'],
  ])('folds a captured %s value into an exact shell at build time', (value, sourceRegex) => {
    const bundle = fixtureBundle({
      headerRules: [
        {
          source: '/:locale/docs',
          sourceRegex,
          headers: { 'content-language': value },
        },
      ],
    });

    expect(shellHeaders(bundle, { ...rootPrerender(), pathname: '/ja/docs' })).toMatchObject({
      'content-language': 'ja',
    });
  });

  it('lowercases the recorded headers and drops the ones a shell may not carry', () => {
    const root = rootPrerender();
    const headers = shellHeaders(fixtureBundle(), {
      ...root,
      initialHeaders: { ...root.initialHeaders, 'Cache-Control': 's-maxage=1', vary: ['a', 'b'] },
    });

    expect(headers).not.toHaveProperty('cache-control');
    expect(headers['vary']).toBe('a, b');
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('folds in an unconditional header rule that matches, never a conditional one', () => {
    const root = rootPrerender();
    const bundle = fixtureBundle({
      headerRules: [
        { ...EVERY_PATH, headers: { 'X-Frame-Options': 'DENY' } },
        { ...EVERY_PATH, has: [{ type: 'header', key: 'x-beta' }], headers: { 'X-Beta': 'on' } },
        { source: '/other', sourceRegex: '^/other$', headers: { 'X-Other': '1' } },
      ],
    });

    expect(shellHeaders(bundle, root)).toMatchObject({ 'x-frame-options': 'DENY' });
    expect(shellHeaders(bundle, root)).not.toHaveProperty('x-beta');
    expect(shellHeaders(bundle, root)).not.toHaveProperty('x-other');
    // These three, and the three `next build` writes into `onMatch`, for the edge to judge.
    expect(headerRulesOf(bundle)).toHaveLength(6);
    expect(headerRulesOf(fixtureBundle({ i18n: true }))).toStrictEqual([]);
  });

  /** A header rule too: one written for `/STATIC` sets its headers on the page at `/static`. */
  it('folds in a header rule written in another case', () => {
    const bundle = fixtureBundle({
      headerRules: [
        {
          source: '/STATIC',
          sourceRegex: String.raw`^\/STATIC(?:\/)?$`,
          headers: { 'X-Frame-Options': 'DENY' },
        },
      ],
    });

    expect(shellHeaders(bundle, staticPrerender())).toMatchObject({ 'x-frame-options': 'DENY' });
  });

  /**
   * A service worker registers under a broader scope than its own directory, which its script's
   * `Service-Worker-Allowed` allows: a rule `next build` writes itself, whose pattern names the
   * whole path. The edge publishes no rules for a build whose routing it does not reproduce — one
   * with `i18n` — and the worker was refused registration.
   */
  it('publishes the rules next build writes itself for a build the edge does not route', () => {
    const serviceWorker = {
      source: '/base/_next/static/service-worker/:path*',
      sourceRegex: String.raw`^\/base\/_next\/static\/service-worker(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?$`,
      headers: { 'Service-Worker-Allowed': '/base' },
      priority: true,
    };
    const bundle = fixtureBundle({
      basePath: '/base',
      i18n: true,
      headerRules: [serviceWorker, { ...EVERY_PATH, headers: { 'X-Frame-Options': 'DENY' } }],
    });

    expect(headerRulesOf(bundle)).toStrictEqual([
      {
        sourceRegex: serviceWorker.sourceRegex,
        headers: { 'Service-Worker-Allowed': '/base' },
        phase: 'beforeMiddleware',
      },
    ]);
  });

  /**
   * A build the edge does not route publishes the rules it folds in apart as well, for the edge to
   * lay over a regenerated page's own headers: the unconditional ones, in their order. A build the
   * edge routes publishes every rule for it to judge instead, and nothing apart.
   */
  it('publishes apart the rules a build the edge does not route folds in', () => {
    const headerRules = [
      { ...EVERY_PATH, headers: { 'X-Frame-Options': 'DENY' } },
      {
        ...EVERY_PATH,
        has: [{ type: 'header' as const, key: 'x-beta' }],
        headers: { 'X-Beta': 'on' },
      },
      { source: '/other', sourceRegex: '^/other$', headers: { 'X-Other': '1' } },
    ];

    expect(
      foldedHeaderRulesOf(fixtureBundle({ i18n: true, headerRules }))?.map((rule) => rule.headers),
    ).toStrictEqual([
      { 'X-Frame-Options': 'DENY' },
      { 'X-Other': '1' },
      // And the unconditional two `next build` writes into `onMatch`, whose paths are no page's.
      { 'cache-control': 'public,max-age=31536000,immutable' },
      { 'x-nextjs-deployment-id': 'dpl_4Fixture2Minima1AppXy' },
    ]);
    expect(foldedHeaderRulesOf(fixtureBundle({ headerRules }))).toBeUndefined();
    expect(foldedHeaderRulesOf(fixtureBundle({ basePath: '/app', headerRules }))).toBeUndefined();
  });
});

describe('folded header rules', () => {
  /**
   * The edge judges the folded rules against a route's pathname so as to say what the deployment
   * folded into the route: for a render that set nothing, the two agree header for header.
   */
  it('come to what the deployment folds into the route', () => {
    const bundle = fixtureBundle({
      basePath: '/app',
      i18n: true,
      headerRules: [
        { ...EVERY_PATH, headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Language': 'en' } },
        {
          source: '/app/docs/:slug',
          sourceRegex: String.raw`^\/app\/docs\/(?<slug>[^\/]+)$`,
          headers: { 'X-Frame-Options': 'DENY', Link: '</:slug.css>; rel=preload; as=style' },
        },
        // A header a shell carries, so that folding the conditional rule in would show.
        {
          ...EVERY_PATH,
          has: [{ type: 'header' as const, key: 'x-beta' }],
          headers: { 'Content-Language': 'de' },
        },
      ],
    });
    const prerender = { ...rootPrerender(), pathname: '/app/docs/intro', initialHeaders: {} };
    const foldedHeaderRules = foldedHeaderRulesOf(bundle);
    const manifest = parseProjectManifest(
      serializeManifest(
        buildProjectManifest({
          projectId: 'folded',
          runId: 'run',
          generatedAt: '2026-09-24T00:00:00.000Z',
          originHost: 'app.example',
          deployment: { assetSetHash: 'a', observedAt: '2026-09-24T00:00:00.000Z' },
          app: { deploymentId: 'dpl_folded', scriptName: 'app-folded' },
          routes: [],
          foldedHeaderRules,
        }),
      ),
    );
    const folded = foldedHeadersFor(manifest, prerender.pathname) ?? {};

    expect(filterShellResponseHeaders(Object.entries(folded))).toStrictEqual(
      shellHeaders(bundle, prerender),
    );
    expect(folded).toMatchObject({
      'x-frame-options': 'DENY',
      link: '</intro.css>; rel=preload; as=style',
    });
  });

  it("are judged against the route's pathname, the later rule winning", () => {
    const manifest = parseProjectManifest(
      serializeManifest(
        buildProjectManifest({
          projectId: 'folded',
          runId: 'run',
          generatedAt: '2026-09-24T00:00:00.000Z',
          originHost: 'app.example',
          deployment: { assetSetHash: 'a', observedAt: '2026-09-24T00:00:00.000Z' },
          app: { deploymentId: 'dpl_folded', scriptName: 'app-folded' },
          routes: [],
          foldedHeaderRules: [
            {
              sourceRegex: String.raw`^\/app(?:\/(.*))?$`,
              headers: {
                'X-Frame-Options': 'SAMEORIGIN',
                'Content-Security-Policy': "script-src 'self'",
              },
              documentHeaders: {
                'X-Frame-Options': 'SAMEORIGIN',
                'Content-Security-Policy': "script-src 'self' 'sha256-recovery'",
              },
            },
            {
              sourceRegex: String.raw`^\/app\/(?<slug>[^\/]+)$`,
              headers: { 'X-Frame-Options': 'DENY', 'X-Slug': ':slug' },
            },
          ],
        }),
      ),
    );

    expect(foldedHeadersFor(manifest, '/app/docs')).toStrictEqual({
      'x-frame-options': 'DENY',
      'content-security-policy': "script-src 'self' 'sha256-recovery'",
      'x-slug': 'docs',
    });
    expect(foldedHeadersFor(manifest, '/elsewhere')).toStrictEqual({});
    expect(
      foldedHeadersFor({ ...manifest, foldedHeaderRules: undefined }, '/app/docs'),
    ).toBeUndefined();
  });
});

/**
 * The headers a rule gives `pathname` at the edge, for a deployment whose Functions fill a header's
 * references as `routerReferences` says — and as the router before 16.4 did, where it says nothing.
 */
function headersAt(
  rule: Route,
  pathname: string,
  routerReferences?: RouterReferences,
): Record<string, string> {
  const bundle = fixtureBundle({ headerRules: [rule] });
  const manifest = buildProjectManifest({
    projectId: 'headers',
    runId: 'run',
    generatedAt: '2026-09-21T00:00:00.000Z',
    originHost: 'app.example',
    deployment: { assetSetHash: 'a', observedAt: '2026-09-21T00:00:00.000Z' },
    app: { deploymentId: 'dpl_headers', scriptName: 'app-headers' },
    routes: [],
    headerRules: headerRulesOf(bundle),
    routerReferences,
  });
  return headerRulesFor(
    parseProjectManifest(serializeManifest(manifest)),
    new URL(pathname, 'https://app.example'),
    new Headers(),
  ).headers;
}

/** A rule with ten captures, the tenth of which `$1` begins. */
const TEN_CAPTURES: Route = {
  source: '/x/:a/:b/:c/:d/:e/:f/:g/:h/:i/:j',
  sourceRegex: String.raw`^\/x\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)\/([^\/]+?)$`,
  headers: { 'x-tenth': '$10', 'x-first': '$1-$2', 'x-dollar': '$3' },
};

describe('header parameter captures', () => {
  it('preserves escaped colon literals and zero-prefixed dollar literals from compiled rules', () => {
    const rule: Route = {
      source: '/docs/:slug',
      sourceRegex: String.raw`^\/docs(?:\/([^\/]+?))$`,
      // Next convertHeaders turns the original escaped `\:slug` into the literal `:slug`.
      headers: { 'x-literal': ':slug', 'x-zero': '$01', 'x-prefix': '$10' },
    };

    // The router before 16.4 replaced `$1` inside `$10`, and so does the edge for a deployment
    // whose Functions route with it.
    expect(headersAt(rule, '/docs/intro')).toStrictEqual({
      'x-literal': ':slug',
      'x-zero': '$01',
      'x-prefix': 'intro0',
    });
    // `@next/routing` 16.4 reads `$10` as the tenth capture, and there is none: it stays as written.
    expect(headersAt(rule, '/docs/intro', 'one-pass')).toStrictEqual({
      'x-literal': ':slug',
      'x-zero': '$01',
      'x-prefix': '$10',
    });
  });

  it('reads a reference as the longest capture it names, and inserts a capture as it is', () => {
    expect(headersAt(TEN_CAPTURES, '/x/a/b/$1/d/e/f/g/h/i/j', 'one-pass')).toStrictEqual({
      'x-tenth': 'j',
      'x-first': 'a-b',
      'x-dollar': '$1',
    });
  });

  it('replaces each capture in turn for a deployment whose Functions route with the router before', () => {
    // `$1` goes first, inside `$10` as well; the `$1` the third capture puts in is not read again.
    expect(headersAt(TEN_CAPTURES, '/x/a/b/$1/d/e/f/g/h/i/j')).toStrictEqual({
      'x-tenth': 'a0',
      'x-first': 'a-b',
      'x-dollar': '$1',
    });
  });

  it('interpolates the positional references emitted by Next.js 16.3.5 convertHeaders', () => {
    expect(
      headersAt(
        {
          source: '/docs/:slug',
          sourceRegex: String.raw`^\/docs(?:\/([^\/]+?))$`,
          headers: { 'x-slug-$1': '$1', 'x-literal': '$99 :unknown' },
        },
        '/docs/intro',
      ),
    ).toStrictEqual({ 'x-slug-intro': 'intro', 'x-literal': '$99 :unknown' });
  });

  it.each([
    ['/docs/a/b', 'a/b'],
    ['/docs', ''],
  ])('interpolates a repeated or absent optional parameter at %s', (pathname, expected) => {
    expect(
      headersAt(
        {
          source: '/docs/:path*',
          sourceRegex: String.raw`^\/docs(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?$`,
          headers: { 'x-path': '$1' },
        },
        pathname,
      ),
    ).toStrictEqual({ 'x-path': expected });
  });

  it('keeps capture indexes after unnamed groups, nested patterns and escaped literals', () => {
    expect(
      headersAt(
        {
          source: String.raw`/docs/\:literal/(one|two)/:id((?:a|b)\d+)/:slug`,
          sourceRegex: String.raw`^/docs/:literal/(one|two)/((?:a|b)\d+)/([^/]+)$`,
          headers: { 'x-first': '$1', 'x-id': '$2', 'x-slug': '$3' },
        },
        '/docs/:literal/two/a12/intro',
      ),
    ).toStrictEqual({
      'x-first': 'two',
      'x-id': 'a12',
      'x-slug': 'intro',
    });
  });

  it('keeps named captures usable when an older manifest has no original source', () => {
    expect(
      headersAt(
        {
          sourceRegex: '^/docs/(?<slug>[^/]+)$',
          headers: { 'x-legacy': ':slug', 'x-named': '$slug' },
        },
        '/docs/intro',
      ),
    ).toStrictEqual({ 'x-legacy': 'intro', 'x-named': 'intro' });
  });
});

describe('dynamicRouting', () => {
  it('names the class a dynamic route resolves to when it has a shell, and the exact pathnames without one', () => {
    const routing = dynamicRouting(fixtureBundle(), new Set(['/', '/items/[id]']));

    expect(routing.dynamicRoutes).toStrictEqual([
      { sourceRegex: '^[/]?/items/(?<nxtPid>[^/]+?)(?:/)?$', route: '/items/[id]' },
    ]);
    expect(routing.exactPathnames).toStrictEqual(
      expect.arrayContaining(['/static', '/stream', '/_global-error']),
    );
    expect(routing.exactPathnames).not.toContain('/');
    expect(dynamicRouting(fixtureBundle({ i18n: true }), new Set())).toStrictEqual({});
  });

  /**
   * 16.4 collapses a page and its data into one entry by default (`collapseAdapterRoutes`): the
   * class is named on the page's own part of it, and its data's part, ahead of it as before 16.4,
   * names none — a request for the page's RSC payload is not answered with the shell.
   */
  it('names the class of a route 16.4 collapsed with its data, and nothing for the data', () => {
    const bundle = fixtureBundle({ basePath: '/app', redirects: slashRedirects('/app') });
    const collapsed = {
      ...bundle,
      routing: {
        ...bundle.routing,
        dynamicRoutes: [
          {
            source: '/items/[id]',
            sourceRegex: String.raw`^/app[/]?/items/(?<nxtPid>[^/]+?)(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`,
            destination: '/app/items/[id]$2?nxtPid=$nxtPid',
          },
        ],
      },
    };

    expect(dynamicRouting(collapsed, new Set(['/app/items/[id]'])).dynamicRoutes).toStrictEqual([
      {
        sourceRegex: String.raw`^/app[/]?/items/(?<nxtPid>[^/]+?)(\.rsc|\.segments/.+\.segment\.rsc)(?:/)?$`,
      },
      { sourceRegex: '^/app[/]?/items/(?<nxtPid>[^/]+?)(?:/)?$', route: '/app/items/[id]' },
    ]);
  });

  /** The base path is in the pattern `next build` compiled and in the page it names. */
  it('routes a build with a base path by the patterns and the names the build gave it', () => {
    const bundle = fixtureBundle({ basePath: '/app', redirects: slashRedirects('/app') });
    const routing = dynamicRouting(bundle, new Set(['/app', '/app/items/[id]']));

    expect(routing.dynamicRoutes).toStrictEqual([
      { sourceRegex: '^/app[/]?/items/(?<nxtPid>[^/]+?)(?:/)?$', route: '/app/items/[id]' },
    ]);
    expect(routing.exactPathnames).toStrictEqual(
      expect.arrayContaining(['/app/static', '/app/stream']),
    );
    expect(routing.exactPathnames).not.toContain('/app');
    // Its own redirects, the base path's spelling with a slash first, claim ahead of the files;
    // and Next.js's namespace under the prefix is kept from the classes, as `/_next/` is at the root.
    expect(routing.reservedRoutes).toStrictEqual([
      ...slashRedirects('/app').map(({ sourceRegex }) => ({ sourceRegex, beforeFiles: true })),
      { sourceRegex: '^/app/_next/' },
    ]);
    expect(dynamicRouting(fixtureBundle(), new Set()).reservedRoutes).toStrictEqual([]);
  });
});

const KIB = 1024;
const MAX_WORKER_FILE_BYTES = 256 * KIB;

function ships(pathname: string, byteLength: number, basePath = '', exported = false): boolean {
  return travelsWithFunction(
    { pathname, blob: { sha256: 'x', byteLength, contentType: 'text/plain' }, immutable: false },
    basePath,
    exported,
  );
}

describe('travelsWithFunction', () => {
  it('ships error documents, and small files outside _next/static, under the basePath', () => {
    expect(ships('/404', MAX_WORKER_FILE_BYTES + 1)).toBe(true);
    expect(ships('/robots.txt', MAX_WORKER_FILE_BYTES)).toBe(true);
    expect(ships('/large.bin', MAX_WORKER_FILE_BYTES + 1)).toBe(false);
    expect(ships('/_next/static/c.js', 1)).toBe(false);
    expect(ships('/docs/404', MAX_WORKER_FILE_BYTES + 1, '/docs')).toBe(true);
    expect(ships('/docs/_next/static/c.js', 1, '/docs')).toBe(false);
    expect(ships('/docs/robots.txt', 1, '/docs')).toBe(true);
  });

  /**
   * A static export ships the error documents and nothing else. Every page of such a site is a
   * file, the edge serves a file it holds in every mode its pointer can be in, and a middleware
   * rewrite — the one reason the Worker carries a small file — cannot arise without a middleware.
   */
  it('ships only the error documents of a static export', () => {
    expect(ships('/404', 1, '', true)).toBe(true);
    expect(ships('/500', 1, '', true)).toBe(true);
    expect(ships('/docs/404', 1, '/docs', true)).toBe(true);
    expect(ships('/about', 1, '', true)).toBe(false);
    expect(ships('/robots.txt', 1, '', true)).toBe(false);
    expect(ships('/_next/static/c.js', 1, '', true)).toBe(false);
  });

  /**
   * A `trailingSlash` export writes its not-found twice — `404.html` and `404/index.html` — and
   * only the first travels. The second is the one a visitor who types `/404/` is answered with,
   * which makes it a file the edge serves from storage like any other page; the Worker looks the
   * not-found up by the one name Next.js writes it under, and would never open the other.
   */
  it('ships the not-found under the name the runtime looks it up by, not the trailingSlash one', () => {
    expect(ships('/404', 1, '', true)).toBe(true);
    expect(ships('/404/', 1, '', true)).toBe(false);
    expect(ships('/docs/404/', 1, '/docs', true)).toBe(false);
  });
});

/** A `public/` file too large to travel with the Worker: only the edge ever holds its bytes. */
const BIG_FILE = {
  pathname: '/files/app.dmg',
  blob: {
    sha256: 'f'.repeat(64),
    byteLength: MAX_WORKER_FILE_BYTES + 1,
    contentType: 'application/octet-stream',
  },
  immutable: false,
};

function withRewrite(rule: Route, options: FixtureBundleOptions = {}): DeploymentBundle {
  const bundle = fixtureBundle(options);
  return {
    ...bundle,
    routing: { ...bundle.routing, beforeFiles: [rule] },
    staticFiles: [...bundle.staticFiles, BIG_FILE],
  };
}

const DOWNLOAD = {
  source: '/download',
  sourceRegex: String.raw`^\/download(?:\/)?$`,
  destination: '/files/app.dmg',
};

describe('edgeServedRewrites', () => {
  it('answers a rewrite to a file the Worker never carried, and stops reserving it', () => {
    const bundle = withRewrite(DOWNLOAD);

    expect(edgeServedRewrites(bundle)).toStrictEqual([
      { rule: DOWNLOAD, pathname: '/download', file: BIG_FILE },
    ]);
    expect(dynamicRouting(bundle, new Set()).reservedRoutes).toStrictEqual([]);
  });

  it('leaves a rewrite the Worker can resolve itself to the Worker', () => {
    const small = { ...DOWNLOAD, destination: '/hello.txt' };
    const bundle = withRewrite(small);

    expect(edgeServedRewrites(bundle)).toStrictEqual([]);
    expect(dynamicRouting(bundle, new Set()).reservedRoutes).toHaveLength(1);
  });

  /** Anything the edge cannot settle at build time stays with the router that can. */
  it.each([
    ['a parameter in the source', { ...DOWNLOAD, source: '/download/:file' }],
    ['a parameter in the destination', { ...DOWNLOAD, destination: '/files/:file' }],
    ['a condition', { ...DOWNLOAD, has: [{ type: 'header' as const, key: 'x-beta' }] }],
    ['a status of its own', { ...DOWNLOAD, status: 308 }],
    [
      'no source of its own',
      { sourceRegex: DOWNLOAD.sourceRegex, destination: DOWNLOAD.destination },
    ],
    [
      'a destination that is no file of the build',
      { ...DOWNLOAD, destination: '/files/other.dmg' },
    ],
  ])('leaves a rule with %s alone', (_name, rule) => {
    expect(edgeServedRewrites(withRewrite(rule))).toStrictEqual([]);
  });

  it.each(['/static', '/stream', '/hello.txt'])(
    'lets beforeFiles override an existing route at %s, while afterFiles yields to it',
    (source) => {
      const rule = { ...DOWNLOAD, source, sourceRegex: `^${source}$` };
      const before = withRewrite(rule);
      const after = {
        ...before,
        routing: { ...before.routing, beforeFiles: [], afterFiles: [rule] },
      };

      expect(edgeServedRewrites(before)).toStrictEqual([
        { rule, pathname: source, file: BIG_FILE },
      ]);
      expect(dynamicRouting(before, new Set()).reservedRoutes).toStrictEqual([]);
      expect(edgeServedRewrites(after)).toStrictEqual([]);
    },
  );

  it.each(['/', '/static'])(
    'does not publish a document shell hidden by a beforeFiles alias at %s',
    (source) => {
      const rule = { ...DOWNLOAD, source, sourceRegex: `^${source}$` };
      const bundle = withRewrite(rule);
      const routes = edgeServablePrerenders(bundle, { complete: true });
      const keys = new Set(routes.map((prerender) => prerender.pathname));

      expect(ids(routes)).not.toContain(source);
      expect(dynamicRouting(bundle, keys).exactPathnames).toContain(source);
    },
  );

  it('keeps a promoted alias ahead of a dynamic class after a middleware rewrite', () => {
    const bundle = withRewrite(DOWNLOAD);

    expect(dynamicRouting(bundle, new Set(['/items/[id]'])).exactPathnames).toContain('/download');
  });

  it('serves an afterFiles alias before checking reservations for dynamic routes', () => {
    const base = withRewrite(DOWNLOAD);
    const bundle = {
      ...base,
      routing: { ...base.routing, beforeFiles: [], afterFiles: [DOWNLOAD] },
    };

    expect(edgeServedRewrites(bundle)).toStrictEqual([
      { rule: DOWNLOAD, pathname: '/download', file: BIG_FILE },
    ]);

    const manifest = buildProjectManifest({
      projectId: 'project',
      runId: 'run',
      generatedAt: bundle.generatedAt,
      originHost: 'example.test',
      deployment: { assetSetHash: 'assets', observedAt: bundle.generatedAt },
      app: { deploymentId: 'dpl_serving', scriptName: 'app-serving' },
      routes: [],
      ...dynamicRouting(bundle, new Set()),
      staticFiles: { '/download': { ...BIG_FILE.blob, immutable: false } },
    });
    const url = new URL('https://example.test/download');

    expect(
      classifyStaticFile({ method: 'GET', url, manifest, deployment: manifest.deployment }),
    ).toMatchObject({
      kind: 'static-file',
      pathname: '/download',
    });
    // The hosted-file gate checks only what precedes the filesystem. The afterFiles reservation
    // protects dynamic-class routing; it does not send this alias to the Worker's missing file.
    expect(isReserved(manifest, url, new Headers(), true)).toBe(false);
    expect(isReserved(manifest, url, new Headers(), false)).toBe(true);
  });

  it.each(['beforeFiles', 'afterFiles'] as const)(
    'keeps a later afterFiles alias behind an earlier %s rewrite to a small file',
    (phase) => {
      const small = { ...DOWNLOAD, destination: '/hello.txt' };
      const base = withRewrite(DOWNLOAD);
      const bundle = {
        ...base,
        routing: {
          ...base.routing,
          beforeFiles: phase === 'beforeFiles' ? [small] : [],
          afterFiles: phase === 'afterFiles' ? [small, DOWNLOAD] : [DOWNLOAD],
        },
      };

      expect(edgeServedRewrites(bundle)).toStrictEqual([]);
    },
  );

  it.each([
    ['redirect', { ...DOWNLOAD, status: 307, destination: '/login' }],
    ['rewrite', { ...DOWNLOAD, destination: '/hello.txt' }],
    [
      'conditional redirect',
      {
        ...DOWNLOAD,
        status: 307,
        destination: '/login',
        has: [{ type: 'cookie' as const, key: 'session' }],
      },
    ],
    [
      'pattern redirect',
      { source: '/:path*', sourceRegex: '^/.*$', status: 307, destination: '/login' },
    ],
    [
      'case-insensitive redirect',
      { source: '/DOWNLOAD', sourceRegex: '^/DOWNLOAD$', status: 307, destination: '/login' },
    ],
  ])('does not promote an alias ahead of a beforeMiddleware %s', (_name, earlier) => {
    const base = withRewrite(DOWNLOAD);
    const bundle = { ...base, routing: { ...base.routing, beforeMiddleware: [earlier] } };

    expect(edgeServedRewrites(bundle)).toStrictEqual([]);
  });

  it('keeps conditional and patterned earlier rewrites ahead of an afterFiles alias', () => {
    const base = withRewrite(DOWNLOAD);
    const earlier: Route = {
      source: '/:path*',
      sourceRegex: '^/.*$',
      destination: '/hello.txt',
      missing: [{ type: 'header', key: 'x-download' }],
    };
    const bundle = {
      ...base,
      routing: { ...base.routing, beforeFiles: [], afterFiles: [earlier, DOWNLOAD] },
    };

    expect(edgeServedRewrites(bundle)).toStrictEqual([]);
  });

  it('checks later beforeFiles rewrites before treating their earlier target as a file', () => {
    const base = withRewrite(DOWNLOAD);
    const next = {
      source: BIG_FILE.pathname,
      sourceRegex: '^/files/app[.]dmg$',
      destination: '/hello.txt',
    };
    const bundle = {
      ...base,
      routing: { ...base.routing, beforeFiles: [DOWNLOAD, next] },
    };

    expect(edgeServedRewrites(bundle)).toStrictEqual([]);
  });

  it('still promotes an alias past header rules and redirects for another pathname', () => {
    const base = withRewrite(DOWNLOAD);
    const bundle = {
      ...base,
      routing: {
        ...base.routing,
        beforeMiddleware: [
          { ...DOWNLOAD, destination: undefined, headers: { 'x-download': 'yes' } },
          { source: '/other', sourceRegex: '^/other$', status: 307, destination: '/login' },
        ],
      },
    };

    expect(edgeServedRewrites(bundle)).toStrictEqual([
      { rule: DOWNLOAD, pathname: '/download', file: BIG_FILE },
    ]);
  });

  it('leaves everything to the Worker where the edge does not reproduce the routing', () => {
    expect(edgeServedRewrites(withRewrite(DOWNLOAD, { i18n: true }))).toStrictEqual([]);
  });

  /**
   * A rewrite of the spelling a page is asked for by, ahead of the filesystem, hides the page there:
   * the edge serves the file it names, so the page is neither published at that spelling nor seeded
   * — as a page a rewrite of its own name hides is not, where the build keeps no slash.
   */
  it('neither publishes nor seeds a page a rewrite of its spelling hides', () => {
    const bundle = slashed();
    const rule = { ...DOWNLOAD, source: '/static/', sourceRegex: String.raw`^\/static\/$` };
    const rewritten = {
      ...bundle,
      routing: { ...bundle.routing, beforeFiles: [rule] },
      staticFiles: [...bundle.staticFiles, BIG_FILE],
    };

    expect(edgeServedRewrites(rewritten).map((served) => served.pathname)).toStrictEqual([
      '/static/',
    ]);
    expect(ids(edgeServablePrerenders(rewritten, { complete: true }))).not.toContain('/static');
    expect(ids(cacheablePrerenders(rewritten))).not.toContain('/static');
  });

  /**
   * The same of a shipped file: `/manual/` is the file `/manual`, which the router finds before an
   * `afterFiles` rewrite of that spelling is reached — with the build's redirect to the slash or
   * without it (`skipTrailingSlashRedirect`), since the router makes the alias either way.
   */
  it.each([
    ['with the redirect to the slash', slashed()],
    ['without it', fixtureBundle({ trailingSlash: true, skipTrailingSlashRedirect: true })],
  ])('promotes no rewrite of the slashed spelling of a shipped file, %s', (_, bundle) => {
    const rule = { ...DOWNLOAD, source: '/manual/', sourceRegex: String.raw`^\/manual\/$` };
    const manual = { pathname: '/manual', blob: BIG_FILE.blob, immutable: false };
    const rewritten = {
      ...bundle,
      routing: { ...bundle.routing, afterFiles: [rule] },
      staticFiles: [...bundle.staticFiles, manual, BIG_FILE],
    };

    expect(edgeServedRewrites(rewritten)).toStrictEqual([]);
  });

  /**
   * A page is found at the spelling a request asks for it by, so a rewrite written for that
   * spelling to run after the filesystem never reaches it: the page answers first.
   */
  it('promotes no rewrite of the spelling a page is asked for by', () => {
    const bundle = slashed();
    const rule = { ...DOWNLOAD, source: '/static/', sourceRegex: String.raw`^\/static\/$` };
    const rewritten = {
      ...bundle,
      routing: { ...bundle.routing, afterFiles: [rule] },
      staticFiles: [...bundle.staticFiles, BIG_FILE],
    };

    expect(edgeServedRewrites(rewritten)).toStrictEqual([]);
  });
});

/**
 * Next.js's router reads the base path, and the locale behind it, as a path writes them, before it
 * decodes anything: the manifest names both — every locale the router routes, its domains' too —
 * for the edge to read a path as the router does, and decode no page or file out of an escaped one.
 */
describe('spelledPrefixOf', () => {
  it('names the base path, and every locale of an application with i18n', () => {
    const bundle = fixtureBundle({ basePath: '/docs' });
    const i18n = {
      defaultLocale: 'en',
      locales: ['en', 'fr'],
      domains: [{ domain: 'example.nl', defaultLocale: 'nl', locales: ['nl', 'nl-BE'] }],
    };

    expect(spelledPrefixOf(bundle)).toStrictEqual({ basePath: '/docs' });
    expect(spelledPrefixOf({ ...bundle, config: { ...bundle.config, i18n } })).toStrictEqual({
      basePath: '/docs',
      locales: ['en', 'fr', 'nl', 'nl-BE'],
    });
    expect(spelledPrefixOf(fixtureBundle())).toBeUndefined();
  });
});

/**
 * A shipped file behind a default locale. Next.js's middleware puts the locale in front of every
 * path it rewrites to (`forceLocale`), so an application with `i18n` whose middleware rewrites
 * `/_next/static/…` to itself names `/en/_next/static/…`; Next.js's filesystem check takes a
 * default locale out of a static file's path, and serves the file. The edge found no file there,
 * handed the request to the Worker, which carries no `_next/static`, and every script 404'd.
 */
describe('staticFileLocalesOf', () => {
  const I18N = {
    defaultLocale: 'en',
    locales: ['en', 'fr', 'nl'],
    domains: [{ domain: 'example.nl', defaultLocale: 'nl' }],
  };

  it('names the default locales of an application with i18n, its domains included', () => {
    const bundle = fixtureBundle({ basePath: '/docs' });

    expect(
      staticFileLocalesOf({ ...bundle, config: { ...bundle.config, i18n: I18N } }),
    ).toStrictEqual({ basePath: '/docs', locales: ['en', 'nl'] });
    expect(staticFileLocalesOf(bundle)).toBeUndefined();
  });

  /**
   * Where an application has `trailingSlash`, Next.js redirects `/manual` to `/manual/` and answers
   * the file there; with the redirect left out (`skipTrailingSlashRedirect`), its router still finds
   * the file by that spelling. The lookup finds a file whose last segment names no file by it as
   * well, behind a default locale too, where Next.js takes the slash off before the locale. One with
   * an extension it does not, as the redirect takes the slash off it; nor an application without
   * `trailingSlash`.
   */
  it('finds an extensionless file by its slashed spelling where the application has trailingSlash', () => {
    const file = {
      sha256: 'a'.repeat(64),
      byteLength: 300_000,
      contentType: 'application/octet-stream',
      immutable: false,
    };
    const manifestOf = (config: Parameters<typeof fixtureBundle>[0]) => {
      return buildProjectManifest({
        projectId: 'site1',
        runId: 'run1',
        generatedAt: '2026-10-04T00:00:00.000Z',
        originHost: 'example.com',
        deployment: { assetSetHash: 'h', observedAt: '2026-10-04T00:00:00.000Z' },
        routes: [],
        app: { deploymentId: 'dpl_1', scriptName: 'app-1' },
        staticFiles: { '/manual': file, '/hello.txt': file },
        staticFileLocales: { basePath: '', locales: ['en'] },
        ...dynamicRouting(fixtureBundle(config), new Set()),
      });
    };
    // The last escapes the dot that makes the name a file's: it is judged as the file it decodes to.
    const spellings = [
      '/manual',
      '/manual/',
      '/en/manual/',
      '/hello.txt',
      '/hello.txt/',
      '/hello%2Etxt/',
    ];
    const foundIn = (config: Parameters<typeof fixtureBundle>[0]) => {
      const manifest = manifestOf(config);
      return spellings.map((pathname) => findStaticFile(manifest, pathname) !== undefined);
    };
    const keeping = foundIn({ trailingSlash: true });
    const skipping = foundIn({ trailingSlash: true, skipTrailingSlashRedirect: true });
    const plain = foundIn({});

    expect(keeping).toStrictEqual([true, true, true, true, false, false]);
    expect(skipping).toStrictEqual([true, true, true, true, false, false]);
    expect(plain).toStrictEqual([true, false, false, true, false, false]);
  });

  it('finds a shipped file behind a default locale, and behind no other', () => {
    const file = {
      sha256: 'a'.repeat(64),
      byteLength: 1,
      contentType: 'text/javascript',
      immutable: true,
    };
    const manifest = buildProjectManifest({
      projectId: 'site1',
      runId: 'run1',
      generatedAt: '2026-09-24T00:00:00.000Z',
      originHost: 'example.com',
      deployment: { assetSetHash: 'h', observedAt: '2026-09-24T00:00:00.000Z' },
      routes: [],
      app: { deploymentId: 'dpl_1', scriptName: 'app-1' },
      staticFiles: { '/docs/_next/static/chunks/a.js': file, '/docs/robots.txt': file },
      staticFileLocales: { basePath: '/docs', locales: ['en', 'nl'] },
    });
    const found = (pathname: string) => findStaticFile(manifest, pathname) !== undefined;

    expect(
      [
        '/docs/_next/static/chunks/a.js',
        '/docs/en/_next/static/chunks/a.js',
        '/docs/EN/_next/static/chunks/a.js',
        '/docs/nl/robots.txt',
      ].map((pathname) => found(pathname)),
    ).toStrictEqual([true, true, true, true]);
    // Only a default locale, and only one, behind the base path.
    expect(
      [
        '/docs/fr/_next/static/chunks/a.js',
        '/docs/en/en/_next/static/chunks/a.js',
        '/en/docs/_next/static/chunks/a.js',
        '/docs/en',
      ].map((pathname) => found(pathname)),
    ).toStrictEqual([false, false, false, false]);
    expect(
      classifyStaticFile({
        method: 'GET',
        url: new URL('https://example.com/docs/en/_next/static/chunks/a.js'),
        manifest,
        deployment: manifest.deployment,
      }),
    ).toMatchObject({ kind: 'static-file' });
  });
});

/**
 * A shipped file under an application's `assetPrefix`. Its pages load their scripts from
 * `<assetPrefix>/_next/static/…`, which `next build` rewrites to the file before the filesystem is
 * checked. The edge found no file there, handed the request to the Worker, which carries no
 * `_next/static`, and every script 404'd (`app-dir/asset-prefix-with-basepath`).
 */
/** The rewrite `next build` writes, first of its `beforeFiles`, for `assetPrefix: '/assets'`. */
function prefixRewrite(basePath: string): Route {
  return {
    source: '/assets/_next/:path+',
    sourceRegex: String.raw`^\/assets\/_next(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))(?:\/)?$`,
    destination: `${basePath}/_next/$1`,
  };
}

/** An application with `assetPrefix: '/assets'`, and the rules after the prefix's own. */
function prefixed(basePath: string, later: readonly Route[] = []): DeploymentBundle {
  const bundle = fixtureBundle({ basePath, beforeFiles: [prefixRewrite(basePath), ...later] });
  return { ...bundle, config: { ...bundle.config, assetPrefix: '/assets' } };
}

describe('staticFileAssetPrefixOf', () => {
  it('names the prefix of an application with one, beside the base path it rewrites to', () => {
    const bundle = fixtureBundle({ basePath: '/docs' });

    expect(staticFileAssetPrefixOf(prefixed('/docs'))).toStrictEqual({
      basePath: '/docs',
      assetPrefix: '/assets',
    });
    expect(staticFileAssetPrefixOf(bundle)).toBeUndefined();
    // A prefix with no rewrite of it is no path a file is served under.
    expect(
      staticFileAssetPrefixOf({ ...bundle, config: { ...bundle.config, assetPrefix: '/assets' } }),
    ).toBeUndefined();
  });

  /**
   * The rest of `beforeFiles` runs on the path the prefix's rewrite lands on, and the router checks
   * the filesystem after it. A rule there leaves the router the files it may claim, on the requests
   * it claims them for, and no other: decided for the whole build, it sent every script under the
   * prefix to a Worker that carries none of them.
   */
  it('leaves a file under the prefix to the router only where a later rule claims it', () => {
    const elsewhere: Route = {
      source: '/_next/static/chunks/:path*',
      sourceRegex: String.raw`^\/_next\/static\/chunks(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
      destination: '/elsewhere/$1',
      has: [{ type: 'header', key: 'x-team' }],
    };
    const bundle = prefixed('', [elsewhere]);
    const staticFileAssetPrefix = staticFileAssetPrefixOf(bundle);
    const manifest = buildProjectManifest({
      projectId: 'site1',
      runId: 'run1',
      generatedAt: '2026-09-24T00:00:00.000Z',
      originHost: 'example.com',
      deployment: { assetSetHash: 'h', observedAt: '2026-09-24T00:00:00.000Z' },
      routes: [],
      app: { deploymentId: 'dpl_1', scriptName: 'app-1' },
      reservedRoutes: dynamicRouting(bundle, new Set()).reservedRoutes,
      staticFileAssetPrefix,
    });
    const reserved = (pathname: string, headers: Record<string, string> = {}) =>
      isReserved(manifest, new URL(`https://example.com${pathname}`), new Headers(headers), true);

    expect(staticFileAssetPrefix).toStrictEqual({ basePath: '', assetPrefix: '/assets' });
    expect(reserved('/assets/_next/static/chunks/a.js', { 'x-team': 't' })).toBe(true);
    expect(reserved('/assets/_next/static/chunks/a.js')).toBe(false);
    expect(reserved('/assets/_next/static/media/b.png', { 'x-team': 't' })).toBe(false);
  });

  it("reserves the prefix's rewrite from the dynamic routes alone, not from the files", () => {
    const { reservedRoutes } = dynamicRouting(prefixed(''), new Set());

    expect(reservedRoutes).toStrictEqual([{ sourceRegex: prefixRewrite('').sourceRegex }]);
  });

  it("finds a shipped file under the prefix's `_next`, and nowhere else under it", () => {
    const file = {
      sha256: 'a'.repeat(64),
      byteLength: 1,
      contentType: 'text/javascript',
      immutable: true,
    };
    const manifest = buildProjectManifest({
      projectId: 'site1',
      runId: 'run1',
      generatedAt: '2026-09-24T00:00:00.000Z',
      originHost: 'example.com',
      deployment: { assetSetHash: 'h', observedAt: '2026-09-24T00:00:00.000Z' },
      routes: [],
      app: { deploymentId: 'dpl_1', scriptName: 'app-1' },
      staticFiles: { '/docs/_next/static/chunks/a.js': file, '/docs/robots.txt': file },
      staticFileAssetPrefix: { basePath: '/docs', assetPrefix: '/assets' },
    });
    const found = (pathname: string) => findStaticFile(manifest, pathname) !== undefined;

    expect(
      ['/docs/_next/static/chunks/a.js', '/assets/_next/static/chunks/a.js'].map((pathname) =>
        found(pathname),
      ),
    ).toStrictEqual([true, true]);
    // The rewrite is of `_next` alone, and to the base path: nothing else is found under it.
    expect(
      [
        '/assets/robots.txt',
        '/assets/docs/_next/static/chunks/a.js',
        '/docs/assets/_next/static/chunks/a.js',
        '/assets_next/static/chunks/a.js',
      ].map((pathname) => found(pathname)),
    ).toStrictEqual([false, false, false, false]);
    expect(
      classifyStaticFile({
        method: 'GET',
        url: new URL('https://example.com/assets/_next/static/chunks/a.js'),
        manifest,
        deployment: manifest.deployment,
      }),
    ).toMatchObject({ kind: 'static-file' });
  });

  /**
   * A middleware's rewrite of a file under the prefix to itself names it behind the default locale
   * (`forceLocale`), and Next.js takes that locale off before it matches the prefix's rewrite.
   */
  it('finds a file under the prefix behind a default locale, in an application with both', () => {
    const file = {
      sha256: 'a'.repeat(64),
      byteLength: 1,
      contentType: 'text/javascript',
      immutable: true,
    };
    const manifest = buildProjectManifest({
      projectId: 'site1',
      runId: 'run1',
      generatedAt: '2026-09-24T00:00:00.000Z',
      originHost: 'example.com',
      deployment: { assetSetHash: 'h', observedAt: '2026-09-24T00:00:00.000Z' },
      routes: [],
      app: { deploymentId: 'dpl_1', scriptName: 'app-1' },
      staticFiles: { '/_next/static/chunks/a.js': file },
      staticFileLocales: { basePath: '', locales: ['en'] },
      staticFileAssetPrefix: { basePath: '', assetPrefix: '/assets' },
    });
    const found = (pathname: string) => findStaticFile(manifest, pathname) !== undefined;

    expect(found('/en/assets/_next/static/chunks/a.js')).toBe(true);
    // A locale that is no default, and a prefix behind the locale's own path, are not taken off.
    expect(found('/fr/assets/_next/static/chunks/a.js')).toBe(false);
    expect(found('/assets/en/_next/static/chunks/a.js')).toBe(false);
  });
});
