import { describe, expect, it } from 'vitest';

import type { DeploymentBundle, Prerender, Route } from '../src/bundle/schema.ts';
import { dynamicRouting } from '../src/bundle/serving.ts';
import { memberRouteFor } from '../src/manifest/dynamic.ts';
import { buildProjectManifest } from '../src/manifest/manifest.ts';
import type { DynamicRoute, ReservedRoute, RouteEntry } from '../src/manifest/schema.ts';
import { fixtureBundle } from './fixtures/bundle.ts';

/**
 * A class the build made no shell of — a page that renders its unknown members blocking — whose
 * members the edge serves from the records their first renders leave: the manifest names the route
 * and kind each member's entry is keyed by (`dynamicRouting`), and the edge finds the class a
 * pathname is a member of as Next.js picks the route (`memberRouteFor`).
 */

const LIST = 'Googlebot|Bingbot';
const ACTION = { type: 'header', key: 'next-action' } as const;
const MULTIPART = { type: 'header', key: 'content-type', value: 'multipart/form-data;.*' } as const;
const CRAWLERS = { type: 'header', key: 'user-agent', value: LIST } as const;
const POSTS = '/posts/[slug]';

function postsRoute(template = POSTS): Route {
  return {
    source: template,
    sourceRegex: '^[/]?/posts/(?<nxtPslug>[^/]+?)(?:/)?$',
    destination: `${template}?nxtPslug=$nxtPslug`,
  };
}

/** The class as `next build` writes one it renders blocking: no body, and the page's conditions. */
function blockingTemplate(fields: Partial<Prerender> = {}): Prerender {
  return {
    id: POSTS,
    pathname: POSTS,
    route: POSTS,
    parentOutputId: POSTS,
    groupId: 8,
    routeType: 'fallback',
    response: 'empty',
    compute: 'blocking',
    renderingMode: 'PARTIALLY_STATIC',
    htmlSize: 0,
    bypassFor: [ACTION, MULTIPART, CRAWLERS],
    ...fields,
  };
}

interface Posts {
  readonly template?: Partial<Prerender> | undefined;
  readonly kind?: 'app-page' | 'pages' | 'app-route' | undefined;
  readonly runtime?: 'edge' | undefined;
}

/** The fixture with a blocking `/posts/[slug]` class after its own routes. */
function withPosts({ template = {}, kind = 'app-page', runtime }: Posts = {}): DeploymentBundle {
  const bundle = fixtureBundle();
  const prerender = blockingTemplate(template);
  return {
    ...bundle,
    config: { ...bundle.config, htmlLimitedBots: LIST },
    routing: {
      ...bundle.routing,
      dynamicRoutes: [...bundle.routing.dynamicRoutes, postsRoute(prerender.pathname)],
    },
    entrypoints: [
      ...bundle.entrypoints,
      {
        id: 'app/posts/[slug]/page',
        kind,
        pathname: prerender.route,
        ...(runtime !== undefined && { runtime }),
      },
    ],
    prerenders: [...bundle.prerenders, prerender],
  };
}

function membersOf(bundle: DeploymentBundle) {
  const routing = dynamicRouting(bundle, new Set(['/', '/items/[id]', '/static']));
  return routing.dynamicRoutes?.map((route) => route.members);
}

describe('the members of a class the build made no shell of', () => {
  it('are named with the route and kind their entries are keyed by', () => {
    // The conditions as the class's own, less the list of crawlers: a visitor it holds for is
    // passed on before any member is looked up.
    expect(membersOf(withPosts())).toStrictEqual([
      undefined,
      { route: POSTS, kind: 'app-page', bypassFor: [ACTION, MULTIPART] },
    ]);
  });

  it('are keyed by the route the build filed the class under, not the template matched', () => {
    const locale = withPosts({
      template: { pathname: '/en/posts/[slug]', route: '/[locale]/posts/[slug]' },
    });

    expect(membersOf(locale)?.[1]).toMatchObject({ route: '/[locale]/posts/[slug]' });
  });

  it('are named for a Pages Router page rendered blocking', () => {
    expect(membersOf(withPosts({ kind: 'pages' }))?.[1]).toMatchObject({ kind: 'pages' });
  });

  /**
   * Next.js 16.4 keys a class's entries by the parameters `generateStaticParams` may still provide
   * (`allowQuery`), the root parameters among them: a member is kept under the shell those complete
   * to, and the edge reads that record.
   */
  it('are keyed by the parameters the build keys the class by, where they are some of its own', () => {
    const route = '/[locale]/posts/[slug]';
    const keyed = withPosts({ template: { pathname: route, route, allowQuery: ['nxtPlocale'] } });

    expect(membersOf(keyed)?.[1]).toMatchObject({ route, keyedBy: ['locale'] });
  });

  /** A class narrower than its route: what it resolved keys its members as much as the rest. */
  it('are keyed by what a narrower class resolved, beside what the build names', () => {
    const route = '/[locale]/[team]/posts/[slug]';
    const narrower = withPosts({
      template: { pathname: '/en/[team]/posts/[slug]', route, allowQuery: ['nxtPteam'] },
    });

    expect(membersOf(narrower)?.[1]).toMatchObject({ route, keyedBy: ['locale', 'team'] });
  });

  it('are each their own entry where the build keys the class by every parameter', () => {
    const route = '/[locale]/posts/[slug]';
    const allowQuery = ['nxtPlocale', 'nxtPslug'];
    const every = withPosts({ template: { pathname: route, route, allowQuery } });

    expect(membersOf(every)?.[1]).not.toHaveProperty('keyedBy');
  });

  it.each<[string, Posts]>([
    // A class with a body is a shell; under the Pages Router, the loading page of `fallback: true`,
    // which the runtime keeps no member of.
    [
      'a class with a body',
      { template: { body: { sha256: 'e'.repeat(64), byteLength: 9, contentType: 'text/html' } } },
    ],
    ['a route handler', { kind: 'app-route' }],
    ['a page on the edge runtime', { runtime: 'edge' }],
    // Its members' entries would be keyed by a query key their pathnames do not carry.
    ['a class that varies on a query key', { template: { allowQuery: ['page'] } }],
    ['a class whose build answers other than 200', { template: { initialStatus: 404 } }],
  ])('are not named for %s', (_label, posts) => {
    expect(membersOf(withPosts(posts))?.[1]).toBeUndefined();
  });

  /** A member spelled as its own placeholder shares the class's pathname, and is not the class. */
  it('are named past a member whose value is spelled as its placeholder', () => {
    const bundle = withPosts();
    const literal: Prerender = {
      ...blockingTemplate(),
      id: '/posts/[slug]-literal',
      groupId: 9,
      routeType: 'page',
      response: 'complete',
      compute: 'static',
      parentFallbackMode: null,
      body: { sha256: 'e'.repeat(64), byteLength: 9, contentType: 'text/html' },
    };

    expect(
      membersOf({ ...bundle, prerenders: [...bundle.prerenders, literal] })?.[1],
    ).toMatchObject({ route: POSTS, kind: 'app-page' });
  });

  it('are not named where the class has a shell', () => {
    expect(membersOf(withPosts())?.[0]).toBeUndefined();
  });
});

function entryAt(pathname: string): RouteEntry {
  return {
    pathname,
    status: 200,
    shell: {
      sha256: 'a'.repeat(64),
      byteLength: 10,
      contentType: 'text/html',
      encoding: 'identity',
    },
    headers: {},
  };
}

const MEMBERS = { route: '/[locale]/posts/[slug]', kind: 'app-page' } as const;

function manifestWith(dynamicRoutes: DynamicRoute[], reservedRoutes?: ReservedRoute[]) {
  const observedAt = '2026-10-07T00:00:00.000Z';
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: observedAt,
    originHost: 'app.example.app',
    deployment: { dplId: 'dpl_active', assetSetHash: 'h', observedAt },
    routes: [entryAt('/en/posts/pinned'), entryAt('/en/[orgSlug]')],
    app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
    dynamicRoutes,
    exactPathnames: ['/en/posts/drafts'],
    ...(reservedRoutes !== undefined && { reservedRoutes }),
  });
}

function memberAt(manifest: ReturnType<typeof manifestWith>, pathname: string) {
  return memberRouteFor(manifest, new URL(`https://app.example.app${pathname}`), new Headers());
}

describe('the class a pathname is a member of', () => {
  const POSTS_ROUTE = {
    sourceRegex: '^[/]?/en/posts/(?<nxtPslug>[^/]+?)(?:/)?$',
    members: MEMBERS,
  };

  it('is the class Next.js picks, with what serves its members', () => {
    const manifest = manifestWith([POSTS_ROUTE]);

    expect(memberAt(manifest, '/en/posts/hello')?.members).toStrictEqual(MEMBERS);
    expect(memberAt(manifest, '/en/other/hello')).toBeUndefined();
  });

  it('is none for a pathname an exact route or Next.js names first', () => {
    const manifest = manifestWith([POSTS_ROUTE]);

    expect(memberAt(manifest, '/en/posts/pinned')).toBeUndefined();
    expect(memberAt(manifest, '/en/posts/drafts')).toBeUndefined();
  });

  it('is none for a pathname a rule of `next.config` claims ahead of the routes', () => {
    const manifest = manifestWith(
      [POSTS_ROUTE],
      [{ sourceRegex: '^/en/posts/claimed$', beforeFiles: true }],
    );

    expect(memberAt(manifest, '/en/posts/claimed')).toBeUndefined();
    expect(memberAt(manifest, '/en/posts/hello')?.members).toStrictEqual(MEMBERS);
  });

  it('is none where an earlier class with no members matches first', () => {
    const manifest = manifestWith([
      { sourceRegex: '^[/]?/en/posts/(?<nxtPslug>[^/]+?)(?:/)?$' },
      POSTS_ROUTE,
    ]);

    expect(memberAt(manifest, '/en/posts/hello')).toBeUndefined();
  });

  it('is none for a class with a shell', () => {
    const manifest = manifestWith([
      {
        sourceRegex: '^[/]?/en/(?<nxtPorgSlug>[^/]+?)(?:/)?$',
        route: '/en/[orgSlug]',
        members: MEMBERS,
      },
    ]);

    expect(memberAt(manifest, '/en/acme')).toBeUndefined();
  });
});
