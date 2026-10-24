import {
  buildGenerationIdFor,
  deriveEntry,
  MAX_TAG_LENGTH,
  sharedShellTagOf,
} from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import type { Prerender } from '../../core/src/bundle/schema.ts';
import { fixtureBundle, rootPrerender, staticPrerender } from '../../core/test/fixtures/bundle.ts';
import { buildTagsOf, prerenderEntryKind, seedRouteFor } from '../src/bundle/cache-seed.ts';

const SCOPE = 'dpl_seedScopeForTests000';
const GENERATED_AT = 1_800_000_000_000;
const CONTEXT = { scopeId: SCOPE, generatedAt: GENERATED_AT };
/** Enough Pages Router pages that a scan of the bundle for each reads many times as many. */
const COUNTED_PAGES = 40;
const INDEX = /^\d+$/u;

/** A copy of `items` that counts how many of its elements are read. */
function counted<T>(items: readonly T[]): { readonly list: T[]; readonly reads: () => number } {
  let reads = 0;
  const list = new Proxy([...items], {
    get(target, key, receiver): unknown {
      reads += Number(typeof key === 'string' && INDEX.test(key));
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { list, reads: () => reads };
}

function prerenderNamed(id: string): Prerender {
  const found = fixtureBundle().prerenders.find((prerender) => prerender.id === id);
  if (found === undefined) {
    throw new Error(`the fixture has no prerender ${id}`);
  }
  return found;
}

async function seeded(prerender: Prerender, bundle = fixtureBundle()) {
  const route = await seedRouteFor(bundle, prerender, CONTEXT);
  if (route === undefined) {
    throw new Error(`${prerender.id} has no document to seed`);
  }
  return route;
}

function sharedShellBundle(route: string) {
  const bundle = fixtureBundle();
  return {
    ...bundle,
    config: { ...bundle.config, cacheComponents: true },
    entrypoints: [
      ...bundle.entrypoints,
      { id: 'app/shared/page', kind: 'app-page' as const, pathname: route },
    ],
  };
}

describe("the build's generation of a route", () => {
  it('carries the query names the build allowed without changing the entry or record', async () => {
    const prerender = rootPrerender();
    const plain = await seeded(prerender);
    const allowed = await seeded({ ...prerender, allowQuery: ['lang', 'sort'] });

    expect(allowed.input.allowQuery).toStrictEqual(['lang', 'sort']);
    expect(allowed).toStrictEqual({
      ...plain,
      input: { ...plain.input, allowQuery: ['lang', 'sort'] },
    });
  });

  it('leaves an empty allowed-query list out of the seed as before', async () => {
    const prerender = rootPrerender();

    await expect(seeded({ ...prerender, allowQuery: [] })).resolves.toStrictEqual(
      await seeded(prerender),
    );
    expect((await seeded(prerender)).input).not.toHaveProperty('allowQuery');
  });

  it.each(['', '/docs'])('seeds a Pages data generation under base path %s', async (basePath) => {
    const bundle = fixtureBundle();
    const pathname = basePath || '/';
    const page = { ...staticPrerender(), pathname, route: pathname };
    const data = {
      ...staticPrerender(),
      pathname: `${basePath}/_next/data/${bundle.buildId}/index.json`,
      route: pathname,
    };
    const result = await seedRouteFor(
      {
        ...bundle,
        config: { ...bundle.config, basePath },
        entrypoints: [{ id: 'pages/index', kind: 'pages', pathname }],
        prerenders: [page, data],
      },
      page,
      CONTEXT,
    );

    expect(result?.input.generation.outputs[1]).toMatchObject({
      representationKey: 'pages-data',
      pathname: data.pathname,
      artifacts: [{ role: 'pages-data' }],
    });
  });

  it('retains route-handler output headers while removing transport and internal state', async () => {
    const bundle = fixtureBundle();
    const route = {
      ...rootPrerender(),
      initialHeaders: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="feed.json"',
        'access-control-allow-origin': '*',
        etag: '"v1"',
        'x-app': 'retained',
        connection: 'x-private',
        'x-private': 'removed',
        'set-cookie': 'private=1',
        'content-encoding': 'gzip',
        'content-length': '12',
        'x-next-cache-tags': 'feed',
      },
    };
    const result = await seedRouteFor(
      { ...bundle, entrypoints: [{ id: 'route', kind: 'app-route', pathname: '/' }] },
      route,
      CONTEXT,
    );

    expect(result?.input.generation.headers).toStrictEqual({
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="feed.json"',
      'access-control-allow-origin': '*',
      etag: '"v1"',
      'x-app': 'retained',
    });
  });

  it('is the document and its resume state under their build keys, with the lifetime the build gave', async () => {
    const root = rootPrerender();
    const derived = await deriveEntry(SCOPE, { kind: 'app-page', route: '/', pathname: '/' });

    const route = await seeded({ ...root, initialRevalidate: 60, initialExpiration: 600 });
    const output = route.input.generation.outputs[0];

    expect(route.cache).toStrictEqual({
      entryId: derived.entryId,
      kind: 'app-page',
      delivery: 'resume',
      buildTags: [
        { kind: 'next-implicit', value: '_N_T_/layout' },
        { kind: 'next-implicit', value: '_N_T_/page' },
        { kind: 'next-implicit', value: '_N_T_/' },
        { kind: 'next-implicit', value: '_N_T_/index' },
      ],
    });
    expect(route.input.descriptor).toStrictEqual({ kind: 'app-page', route: '/', pathname: '/' });
    expect(route.input.generation).toMatchObject({
      generationId: await buildGenerationIdFor(SCOPE, derived.entryId),
      cacheTimestamp: GENERATED_AT,
      producedAt: GENERATED_AT,
      status: 200,
      policy: {
        revalidateAfter: { kind: 'finite', seconds: 60 },
        expireAfter: { kind: 'finite', seconds: 600 },
        source: 'build-output',
      },
      dependencyCoverage: 'complete',
    });
    expect(output?.artifacts.map((artifact) => [artifact.role, artifact.storageRef])).toStrictEqual(
      [
        ['html', `blobs/${root.body?.sha256 ?? ''}`],
        ['postponed', `blobs/${root.postponed?.sha256 ?? ''}`],
      ],
    );
    expect(output).toMatchObject({
      representationKey: 'html',
      compute: 'resuming',
      response: 'initial',
    });
  });

  /**
   * A class shell names the route the build filed it under, which a member's own entry beside it is
   * keyed by: for a localised class, not its template. A route that is no class names none.
   */
  it('names the route of a class shell, which its members are keyed by', async () => {
    const item = prerenderNamed('/items/[id]');
    const localised = await seeded({
      ...item,
      pathname: '/en/items/[id]',
      route: '/[locale]/items/[id]',
    });

    expect((await seeded(item)).cache?.route).toBe('/items/[id]');
    expect(localised.cache?.route).toBe('/[locale]/items/[id]');
    expect((await seeded(rootPrerender())).cache).not.toHaveProperty('route');
  });

  it('records an unknown lifetime for a bundle that carries none, never an unbounded one', async () => {
    const route = await seeded(rootPrerender());

    expect(route.input.generation.policy).toMatchObject({
      revalidateAfter: { kind: 'unknown' },
      expireAfter: { kind: 'unknown' },
      source: 'build-output',
    });
  });

  it('is whole for a page complete at build time', async () => {
    const route = await seeded(prerenderNamed('/static'));

    expect(route.cache?.delivery).toBe('complete');
    expect(route.input.generation.outputs[0]?.artifacts.map((a) => a.role)).toStrictEqual(['html']);
  });

  it('carries the tags the build recorded and the ones Next.js derives from the route', () => {
    const root = rootPrerender();
    const tagged = {
      ...root,
      initialHeaders: { ...root.initialHeaders, 'x-next-cache-tags': 'home,_N_T_/layout' },
    };

    expect(buildTagsOf('app-page', tagged).map((tag) => [tag.kind, tag.value])).toStrictEqual([
      ['next-explicit', 'home'],
      ['next-implicit', '_N_T_/layout'],
      ['next-implicit', '_N_T_/page'],
      ['next-implicit', '_N_T_/'],
      ['next-implicit', '_N_T_/index'],
    ]);
  });

  it('gives a class shell no pathname tag, and a Pages route no derived tag at all', () => {
    const itemsShell = prerenderNamed('/items/[id]');

    expect(buildTagsOf('app-page', itemsShell).map((tag) => tag.value)).toStrictEqual([
      '_N_T_/layout',
      '_N_T_/items/layout',
      '_N_T_/items/[id]/layout',
      '_N_T_/items/[id]/page',
    ]);
    expect(buildTagsOf('pages', itemsShell)).toStrictEqual([]);
  });

  it('lets manual revalidation invalidate one shared shell without invalidating another class', async () => {
    const source = '/prefix/[one]/[two]';
    const bundle = sharedShellBundle(source);
    const shell = {
      ...prerenderNamed('/items/[id]'),
      pathname: '/prefix/b/[two]',
      route: source,
    };
    const other = { ...shell, pathname: '/prefix/c/[two]' };
    const entry = await deriveEntry(SCOPE, {
      kind: 'app-page',
      route: source,
      pathname: shell.pathname,
    });
    const identity = sharedShellTagOf(entry.entryId);
    const tagged = {
      ...shell,
      initialHeaders: { 'x-next-cache-tags': identity },
    };
    const [first, sibling, duplicate] = await Promise.all([
      seeded(shell, bundle),
      seeded(other, bundle),
      seeded(tagged, bundle),
    ]);

    expect(first.input.generation.tags.filter((tag) => tag.value === identity)).toStrictEqual([
      { kind: 'next-implicit', value: identity },
    ]);
    expect(sibling.input.generation.tags.map((tag) => tag.value)).not.toContain(identity);
    expect(duplicate.input.generation.tags.filter((tag) => tag.value === identity)).toHaveLength(1);
    expect(first.input.descriptor.pathname).toBe('/prefix/b/[two]');
  });

  it('keeps shared-shell identity tags bounded for long resolved parameter values', async () => {
    const shell = {
      ...prerenderNamed('/items/[id]'),
      pathname: `/prefix/${'b'.repeat(MAX_TAG_LENGTH * 2)}/[two]`,
      route: '/prefix/[one]/[two]',
    };
    const result = await seeded(shell, sharedShellBundle(shell.route));
    const values = result.input.generation.tags.map((tag) => tag.value);

    expect(values.some((value) => value.startsWith('_N_T_upwind:shared-shell:'))).toBe(true);
    expect(values.every((value) => value.length <= MAX_TAG_LENGTH)).toBe(true);
    expect(values).not.toContain(`_N_T_${shell.pathname}`);
  });

  it.each([
    { postponed: undefined },
    { allowQuery: ['nxtPtwo'] },
    { partialFallback: true },
    { renderingMode: 'STATIC' as const },
  ])('leaves other built output tags unchanged for %j', async (change) => {
    const shell = {
      ...prerenderNamed('/items/[id]'),
      pathname: '/prefix/b/[two]',
      route: '/prefix/[one]/[two]',
      ...change,
    };

    // The bundle a shared shell is tagged under, so the changed field is what keeps the tag off.
    expect(
      (await seeded(shell, sharedShellBundle(shell.route))).input.generation.tags,
    ).toStrictEqual(buildTagsOf('app-page', shell));
  });

  it("records a route handler's own headers, and a page's as its shell replays them", async () => {
    const answered = {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="feed.csv"',
      'access-control-allow-origin': '*',
      'x-feed-version': '3',
    };
    const recorded = {
      ...answered,
      'set-cookie': 'visitor=1',
      'x-next-cache-tags': '_N_T_/api/feed',
    };
    const bundle = fixtureBundle();
    const withHandler = {
      ...bundle,
      entrypoints: [
        ...bundle.entrypoints,
        { id: 'app/api/feed/route', kind: 'app-route' as const, pathname: '/api/feed' },
      ],
    };
    const feed: Prerender = {
      ...staticPrerender(),
      id: '/api/feed',
      pathname: '/api/feed',
      route: '/api/feed',
      parentOutputId: '/api/feed',
      routeType: 'route',
      initialRevalidate: 60,
      initialHeaders: recorded,
    };

    const handler = await seedRouteFor(withHandler, feed, CONTEXT);
    const page = await seeded({ ...rootPrerender(), initialHeaders: recorded });

    expect(handler?.input.generation.headers).toStrictEqual({
      ...answered,
      'cache-control': 'private, no-store',
    });
    expect(page.input.generation.headers).toStrictEqual({ 'content-type': 'text/csv' });
  });

  it('records where a redirect the build wrote leads, which a shell has no place for', async () => {
    const moved = await seeded({
      ...staticPrerender(),
      initialStatus: 307,
      initialHeaders: {
        'content-type': 'text/html',
        location: '/elsewhere',
        'x-nextjs-prerender': '1',
      },
    });
    const page = await seeded({
      ...staticPrerender(),
      initialHeaders: { 'content-type': 'text/html', location: '/elsewhere' },
    });

    expect(moved.input.generation.status).toBe(307);
    expect(moved.input.generation.headers).toStrictEqual({
      'content-type': 'text/html',
      location: '/elsewhere',
    });
    expect(page.input.generation.headers).toStrictEqual({ 'content-type': 'text/html' });
  });

  /** Under a base path the build writes a page's props there too, and the seed keeps them beside it. */
  it('keeps a Pages Router page’s props beside it under the base path', async () => {
    const bundle = fixtureBundle();
    const page: Prerender = {
      id: '/docs/gsp/first',
      pathname: '/docs/gsp/first',
      route: '/docs/gsp/[post]',
      parentOutputId: '/docs/gsp/[post]',
      groupId: 9,
      body: { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/html' },
    };
    const data: Prerender = {
      ...page,
      id: `/docs/_next/data/${bundle.buildId}/gsp/first.json`,
      pathname: `/docs/_next/data/${bundle.buildId}/gsp/first.json`,
      body: { sha256: 'b'.repeat(64), byteLength: 1, contentType: 'application/json' },
    };
    const underBase = {
      ...bundle,
      config: { ...bundle.config, basePath: '/docs' },
      entrypoints: [
        { id: 'pages/gsp/[post]', kind: 'pages' as const, pathname: '/docs/gsp/[post]' },
      ],
      prerenders: [page, data],
    };

    const route = await seedRouteFor(underBase, page, CONTEXT);

    expect(route?.input.generation.outputs.map((output) => output.representationKey)).toStrictEqual(
      ['html', 'pages-data'],
    );
  });

  /**
   * A bundle may name one data pathname in more than one prerender group, and only the page's own
   * group holds the props it was rendered with.
   */
  it('keeps the props of the page’s own group, not of another group at the same pathname', async () => {
    const bundle = fixtureBundle();
    const page: Prerender = {
      id: '/gsp/first',
      pathname: '/gsp/first',
      route: '/gsp/[post]',
      parentOutputId: '/gsp/[post]',
      groupId: 9,
      body: { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/html' },
    };
    const dataPathname = `/_next/data/${bundle.buildId}/gsp/first.json`;
    const own: Prerender = {
      ...page,
      id: dataPathname,
      pathname: dataPathname,
      body: { sha256: 'b'.repeat(64), byteLength: 1, contentType: 'application/json' },
    };
    const otherGroup: Prerender = {
      ...own,
      id: `${dataPathname}#other`,
      groupId: 10,
      body: { sha256: 'c'.repeat(64), byteLength: 1, contentType: 'application/json' },
    };
    const otherRoute: Prerender = {
      ...own,
      id: `${dataPathname}#route`,
      route: '/gsp/[...rest]',
      body: { sha256: 'd'.repeat(64), byteLength: 1, contentType: 'application/json' },
    };
    const withPages = {
      ...bundle,
      entrypoints: [{ id: 'pages/gsp/[post]', kind: 'pages' as const, pathname: '/gsp/[post]' }],
      prerenders: [page, otherGroup, otherRoute, own],
    };

    const route = await seedRouteFor(withPages, page, CONTEXT);

    expect(route?.input.generation.outputs[1]?.artifacts.map((a) => a.sha256)).toStrictEqual([
      'b'.repeat(64),
    ]);
  });

  /**
   * Every cacheable prerender is seeded on its own. Each one going through the whole bundle for its
   * entrypoint, and a Pages Router page for its data, made a deployment's seeding grow with the
   * square of its routes.
   */
  it('reads a bundle’s entrypoints and prerenders once, however many routes it seeds', async () => {
    const bundle = fixtureBundle();
    const pages = Array.from({ length: COUNTED_PAGES }, (_, index): Prerender => {
      return {
        id: `/gsp/${index}`,
        pathname: `/gsp/${index}`,
        route: `/gsp/${index}`,
        parentOutputId: `/gsp/${index}`,
        groupId: index,
        body: { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/html' },
      };
    });
    const data = pages.map((page): Prerender => {
      return {
        ...page,
        id: `/_next/data/${bundle.buildId}${page.pathname}.json`,
        pathname: `/_next/data/${bundle.buildId}${page.pathname}.json`,
      };
    });
    const entrypoints = counted(
      pages.map(({ route }) => ({ id: `pages${route}`, kind: 'pages' as const, pathname: route })),
    );
    const prerenders = counted([...pages, ...data]);
    const withPages = { ...bundle, entrypoints: entrypoints.list, prerenders: prerenders.list };

    const routes = await Promise.all(
      pages.map(async (page) => seedRouteFor(withPages, page, CONTEXT)),
    );

    expect(routes.map((route) => route?.input.generation.outputs.length)).toStrictEqual(
      pages.map(() => 2),
    );
    expect(entrypoints.reads()).toBe(COUNTED_PAGES);
    expect(prerenders.reads()).toBe(2 * COUNTED_PAGES);
  });

  /**
   * A Pages Router API route is never rendered by the build and never cached by Next.js. One a
   * bundle names all the same is no page and no handler a Function would regenerate.
   */
  it('seeds nothing of a Pages Router API route', async () => {
    const bundle = fixtureBundle();
    const api: Prerender = {
      ...staticPrerender(),
      id: '/api/feed',
      pathname: '/api/feed',
      route: '/api/feed',
      parentOutputId: '/api/feed',
    };
    const withApi = {
      ...bundle,
      entrypoints: [{ id: 'pages/api/feed', kind: 'pages-api' as const, pathname: '/api/feed' }],
      prerenders: [api],
    };

    await expect(seedRouteFor(withApi, api, CONTEXT)).resolves.toBeUndefined();
  });

  it('tells a Pages Router page by its entrypoint', () => {
    const bundle = fixtureBundle();
    const withPages = {
      ...bundle,
      entrypoints: [{ id: 'pages/index', kind: 'pages' as const, pathname: '/' }],
    };

    expect(prerenderEntryKind(bundle, rootPrerender())).toBe('app-page');
    expect(prerenderEntryKind(withPages, rootPrerender())).toBe('pages');
  });
});
