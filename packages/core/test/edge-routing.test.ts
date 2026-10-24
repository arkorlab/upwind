import { describe, expect, it } from 'vitest';

import type { DeploymentBundle } from '../src/bundle/schema.ts';
import {
  dynamicRouting,
  edgeServablePrerenders,
  foldedHeaderRulesOf,
  headerRulesOf,
  shellHeaders,
} from '../src/bundle/serving.ts';
import { routePathnameOf } from '../src/bundle/spelling.ts';
import {
  documentHeaderRulesFor,
  headerRulesFor,
  matchDynamicRoute,
  validationPathnameFor,
} from '../src/manifest/dynamic.ts';
import { buildProjectManifest } from '../src/manifest/manifest.ts';
import type { ProjectManifest, RouteEntry, StaticFileEntry } from '../src/manifest/schema.ts';
import { classifyRequest } from '../src/request/classify.ts';
import { NAVIGATION_REQUEST_HEADERS } from '../src/request/constants.ts';
import { fixtureBundle, slashRedirects, trailingSlashRedirects } from './fixtures/bundle.ts';

/**
 * What the edge decides for a request, read off the manifest a build publishes: the same functions
 * a deployment assembles it with, and the same classification the edge runs. The serving tests say
 * which of a build's documents are named; these say that a request reaches them — or does not —
 * once they are, which is the question a base path used to be kept from the edge over.
 */

const OBSERVED_AT = '2026-09-29T00:00:00.000Z';
const HTTP_OK = 200;

function routeEntries(bundle: DeploymentBundle): RouteEntry[] {
  return edgeServablePrerenders(bundle, { complete: true }).flatMap((prerender) => {
    const { body } = prerender;
    return body === undefined
      ? []
      : [
          {
            pathname: routePathnameOf(bundle, prerender),
            status: HTTP_OK,
            shell: { ...body, encoding: 'identity' as const },
            headers: shellHeaders(bundle, prerender),
            prerenderId: prerender.id,
          },
        ];
  });
}

/** The files the build shipped, as the manifest serves them from storage. */
function staticFilesOf(bundle: DeploymentBundle): Record<string, StaticFileEntry> {
  return Object.fromEntries(
    bundle.staticFiles.map((file) => [file.pathname, { ...file.blob, immutable: file.immutable }]),
  );
}

/** The manifest a deployment publishes for `bundle`, as its deployment run assembles one. */
function publishedManifest(bundle: DeploymentBundle): ProjectManifest {
  const routes = routeEntries(bundle);
  const routeKeys = new Set(routes.map((route) => route.pathname));
  const headerRules = headerRulesOf(bundle);
  const foldedHeaderRules = foldedHeaderRulesOf(bundle);
  return buildProjectManifest({
    projectId: 'routing',
    runId: 'run',
    generatedAt: OBSERVED_AT,
    originHost: 'site.example',
    deployment: { dplId: bundle.deploymentId, assetSetHash: 'h', observedAt: OBSERVED_AT },
    routes,
    app: { deploymentId: bundle.deploymentId, scriptName: 'app' },
    staticFiles: staticFilesOf(bundle),
    ...dynamicRouting(bundle, routeKeys),
    ...(headerRules.length > 0 && { headerRules }),
    ...(foldedHeaderRules !== undefined && { foldedHeaderRules }),
  });
}

/** What the edge answers a browser's navigation to `path` with: the route it serves, or why not. */
function servedAt(
  manifest: ProjectManifest,
  path: string,
  headers: Record<string, string> = {},
): string {
  const classified = classifyRequest({
    method: 'GET',
    url: new URL(`https://site.example${path}`),
    headers: new Headers({ ...NAVIGATION_REQUEST_HEADERS, accept: 'text/html', ...headers }),
    manifest,
    deployment: manifest.deployment,
  });
  if (classified.kind === 'document') {
    return classified.entry.pathname;
  }
  return classified.kind === 'passthrough' ? `passthrough: ${classified.reason}` : classified.kind;
}

const RSC_REQUEST = { rsc: '1' };

describe('a build without a base path', () => {
  const manifest = publishedManifest(fixtureBundle({ redirects: slashRedirects('') }));

  it('is served its pages, exact and by class, and nothing its own redirects claim', () => {
    expect(servedAt(manifest, '/')).toBe('/');
    expect(servedAt(manifest, '/static')).toBe('/static');
    expect(servedAt(manifest, '/items/abc')).toBe('/items/[id]');
    expect(servedAt(manifest, '/items/abc/')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/items/abc', RSC_REQUEST)).toBe('rsc');
  });
});

/**
 * `next build` writes a base path into a dynamic route's pattern and destination, into every
 * pathname of the build and into the redirects it adds of its own. The edge matches a request as it
 * arrives, so nothing has to be taken off it first.
 */
describe('a build with a base path', () => {
  const bundle = fixtureBundle({ basePath: '/docs', redirects: slashRedirects('/docs') });
  const manifest = publishedManifest(bundle);

  it('is served its pages under the base path, exact and by class', () => {
    expect(Object.keys(manifest.routes)).toStrictEqual([
      '/docs',
      '/docs/items/[id]',
      '/docs/static',
    ]);
    expect(servedAt(manifest, '/docs')).toBe('/docs');
    expect(servedAt(manifest, '/docs/static')).toBe('/docs/static');
    expect(servedAt(manifest, '/docs/items/abc')).toBe('/docs/items/[id]');
  });

  it('leaves everything the build does not name, or names with no shell, to the Function', () => {
    // A page with no shell is resolved exactly, ahead of the class.
    expect(servedAt(manifest, '/docs/stream')).toBe('passthrough: route-not-proved');
    // The redirects `next build` adds: the base path's spelling with a slash, and any other.
    expect(servedAt(manifest, '/docs/')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/docs/items/abc/')).toBe('passthrough: route-not-proved');
    // Outside the base path there is nothing of the application's to serve.
    expect(servedAt(manifest, '/')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/items/abc')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/docs/items/abc', RSC_REQUEST)).toBe('rsc');
  });

  it('is validated with a member of the class that the class answers', () => {
    const sample = validationPathnameFor('/docs/items/[id]', manifest);
    const url = new URL(`https://site.example${sample ?? ''}`);

    expect(sample).toBe('/docs/items/arkor-validation');
    expect(matchDynamicRoute(manifest, url, new Headers())?.pathname).toBe('/docs/items/[id]');
  });

  /**
   * The rules are judged on each request, as for any build the edge routes: the deployment id's
   * rule gives a response to the client's router its header, and never a document.
   */
  it("judges the build's rules per request, under the base path", () => {
    const url = new URL('https://site.example/docs/items/abc');
    const chunk = new URL('https://site.example/docs/_next/static/chunks/main-abc123.js');

    expect(manifest.foldedHeaderRules).toBeUndefined();
    expect(documentHeaderRulesFor(manifest, url, new Headers()).headers).toStrictEqual({});
    expect(headerRulesFor(manifest, url, new Headers(RSC_REQUEST)).headers).toStrictEqual({
      'x-nextjs-deployment-id': bundle.deploymentId,
    });
    expect(headerRulesFor(manifest, chunk, new Headers()).headers).toStrictEqual({
      'cache-control': 'public,max-age=31536000,immutable',
    });
  });
});

/**
 * The build with a catch-all class besides, as `next build` compiles one under the base path: the
 * class whose pattern takes any path under the prefix, Next.js's own namespace included.
 */
function withCatchAll(bundle: DeploymentBundle): DeploymentBundle {
  const { basePath } = bundle.config;
  const template = `${basePath}/[...slug]`;
  const shell = bundle.prerenders.find((prerender) => prerender.id === '/items/[id]');
  if (shell === undefined) {
    throw new Error('the fixture has no class shell');
  }
  return {
    ...bundle,
    routing: {
      ...bundle.routing,
      dynamicRoutes: [
        ...bundle.routing.dynamicRoutes,
        {
          source: '/[...slug]',
          sourceRegex: `^${basePath}[/]?/(?<nxtPslug>.+?)(?:/)?$`,
          destination: `${template}?nxtPslug=$nxtPslug`,
        },
      ],
    },
    entrypoints: [
      ...bundle.entrypoints,
      { id: 'app/[...slug]/page', kind: 'app-page', pathname: template },
    ],
    prerenders: [
      ...bundle.prerenders,
      { ...shell, id: '/[...slug]', pathname: template, route: template, groupId: 7 },
    ],
  };
}

/**
 * At the root the edge leaves `/_next/` to the Function before it looks for a route; under a base
 * path Next.js's namespace is `<basePath>/_next/`, and a catch-all class matches it as a path like
 * any other. A file the build shipped there is served from storage, ahead of every rule; one it did
 * not is the Function's to answer, not the class's.
 */
describe('the namespace Next.js keeps under a base path', () => {
  const bundle = fixtureBundle({ basePath: '/docs', redirects: slashRedirects('/docs') });
  const manifest = publishedManifest(withCatchAll(bundle));

  it('is no member of a catch-all class', () => {
    expect(servedAt(manifest, '/docs/any/page')).toBe('/docs/[...slug]');
    expect(servedAt(manifest, '/docs/_next/static/chunks/missing.js')).toBe(
      'passthrough: route-not-proved',
    );
    expect(servedAt(manifest, '/docs/_next/data/build/index.json')).toBe(
      'passthrough: route-not-proved',
    );
  });

  it('still serves the files the build shipped there', () => {
    expect(servedAt(manifest, '/docs/_next/static/chunks/main-abc123.js')).toBe('static-file');
  });
});

/**
 * With `i18n` Next.js matches a request that names no locale under the default one, which the edge
 * does not: such a build is served its exact pages, and its dynamic routes are the Function's.
 */
describe('a build with i18n', () => {
  const manifest = publishedManifest(fixtureBundle({ i18n: true, redirects: slashRedirects('') }));

  it('is served its exact pages, and leaves its classes to the Function', () => {
    expect(Object.keys(manifest.routes)).toStrictEqual(['/', '/static']);
    expect(servedAt(manifest, '/static')).toBe('/static');
    expect(servedAt(manifest, '/items/abc')).toBe('passthrough: route-not-proved');
    expect(manifest.dynamicRoutes).toBeUndefined();
  });
});

/**
 * `trailingSlash`: `next build` redirects a path whose last segment names no file to the same path
 * with a slash, ahead of everything else, and serves the page there. The edge serves it there too,
 * under the name a request asks for it by, and leaves the spelling without the slash to the
 * Function, which redirects — the manifest carries that redirect, and the page's own name.
 */
describe('a build that keeps its pages behind a trailing slash', () => {
  const manifest = publishedManifest(
    fixtureBundle({ trailingSlash: true, redirects: trailingSlashRedirects('') }),
  );

  it('is served its pages at the spelling with the slash, exact and by class', () => {
    expect(Object.keys(manifest.routes)).toStrictEqual(['/', '/items/[id]', '/static/']);
    expect(manifest.trailingSlash).toBe(true);
    expect(servedAt(manifest, '/')).toBe('/');
    expect(servedAt(manifest, '/static/')).toBe('/static/');
    expect(servedAt(manifest, '/items/abc/')).toBe('/items/[id]');
  });

  /**
   * A member whose last segment names a file is asked for without the slash: Next.js adds none to
   * it, and takes the one a request gives it off with the redirect for files. The flag admits one
   * trailing slash; it does not require it.
   */
  it('serves a member whose last segment names a file at its spelling without the slash', () => {
    expect(servedAt(manifest, '/items/report.pdf')).toBe('/items/[id]');
    expect(servedAt(manifest, '/items/report.pdf/')).toBe('passthrough: route-not-proved');
  });

  it('leaves the spelling without the slash to the Function, and a page with no shell', () => {
    expect(servedAt(manifest, '/static')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/items/abc')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/stream/')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/items/abc//')).toBe('passthrough: repeated-slash');
    expect(servedAt(manifest, '/items/abc/', RSC_REQUEST)).toBe('rsc');
  });

  it('is validated at the spelling a visitor asks for', () => {
    const sample = validationPathnameFor('/items/[id]', manifest);
    const url = new URL(`https://site.example${sample ?? ''}`);

    expect(sample).toBe('/items/arkor-validation/');
    expect(matchDynamicRoute(manifest, url, new Headers())?.pathname).toBe('/items/[id]');
    expect(validationPathnameFor('/static/', manifest)).toBe('/static/');
  });

  /**
   * Without the slash where the class's last segment names a file: the build's redirect takes the
   * slash off such a path, and a sample spelled with one would be answered with that redirect.
   */
  it('is validated without the slash where the class ends in a file’s name', () => {
    expect(validationPathnameFor('/items/[id]/feed.xml', manifest)).toBe(
      '/items/arkor-validation/feed.xml',
    );
  });
});

/** With a base path as well: its root is asked for with the slash, as every other page is. */
describe('a build with a base path that keeps its pages behind a trailing slash', () => {
  const manifest = publishedManifest(
    fixtureBundle({
      basePath: '/docs',
      trailingSlash: true,
      redirects: trailingSlashRedirects('/docs'),
    }),
  );

  it('is served its pages at the spelling with the slash, under the base path', () => {
    expect(Object.keys(manifest.routes)).toStrictEqual([
      '/docs/',
      '/docs/items/[id]',
      '/docs/static/',
    ]);
    expect(servedAt(manifest, '/docs/')).toBe('/docs/');
    expect(servedAt(manifest, '/docs/static/')).toBe('/docs/static/');
    expect(servedAt(manifest, '/docs/items/abc/')).toBe('/docs/items/[id]');
  });

  it("leaves the spelling without the slash to the Function, the base path's own included", () => {
    expect(servedAt(manifest, '/docs')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/docs/static')).toBe('passthrough: route-not-proved');
    expect(servedAt(manifest, '/docs/items/abc')).toBe('passthrough: route-not-proved');
  });
});

/**
 * A build without the setting keeps its pages without the slash, as it always did: a member asked
 * for with one is Next.js's to redirect, and the manifest says nothing of a slash.
 */
describe('a build that keeps its pages without a trailing slash', () => {
  const manifest = publishedManifest(fixtureBundle());

  it('matches no member asked for with the slash', () => {
    expect(manifest.trailingSlash).toBeUndefined();
    expect(servedAt(manifest, '/items/abc/')).toBe('passthrough: route-not-proved');
  });
});
