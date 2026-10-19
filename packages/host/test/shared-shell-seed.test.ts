import type { Prerender } from '@stayingupwind/core/bundle';
import { deriveEntry } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import { buildTagsOf, seedRouteFor } from '../src/bundle/cache-seed.ts';
import { SHARED_SHELL, shellBundle, taggedShell } from './shared-shell-fixture.ts';

const CONTEXT = { scopeId: 'dpl_shared', generatedAt: 1_800_000_000_000 };

async function sharedTag(prerender = SHARED_SHELL) {
  const { entryId } = await deriveEntry(CONTEXT.scopeId, {
    kind: 'app-page',
    route: prerender.route,
    pathname: prerender.pathname,
  });
  return `_N_T_upwind:shared-shell:${entryId}`;
}

describe('seeding the shared identity of a reusable terminal shell', () => {
  it.each<Partial<Prerender>>([
    {},
    { response: undefined },
    { compute: undefined },
    { allowQuery: ['nxtPone'] },
    { partialFallback: false },
  ])('adds the runtime identity once for an eligible shell %j', async (changes) => {
    const prerender = { ...SHARED_SHELL, ...changes };
    const seeded = await seedRouteFor(shellBundle(prerender), prerender, CONTEXT);
    const value = await sharedTag(prerender);

    expect(seeded?.input.generation.tags).toStrictEqual([
      ...buildTagsOf('app-page', prerender),
      { kind: 'next-implicit', value },
    ]);
    expect(seeded?.cache?.entryId).toBe(value.slice('_N_T_upwind:shared-shell:'.length));
  });

  it.each<Partial<Prerender>>([
    { postponed: undefined },
    { renderingMode: 'STATIC' },
    { routeType: 'route' },
    { response: 'complete' },
    { compute: 'blocking' },
    { partialFallback: true },
    { allowQuery: ['nxtPtwo'] },
    { allowQuery: ['search'] },
    { pathname: '/prefix/b/value' },
    { pathname: '/prefix/b/[literal]', routeType: undefined },
    { routeType: 'page', parentFallbackMode: false },
  ])('keeps the existing tags of an incompatible or concrete output %j', async (changes) => {
    const prerender = { ...SHARED_SHELL, ...changes };
    const seeded = await seedRouteFor(shellBundle(prerender), prerender, CONTEXT);

    expect(seeded?.input.generation.tags).toStrictEqual(buildTagsOf('app-page', prerender));
  });

  it.each([undefined, false])(
    'keeps the existing seed when Cache Components is %s',
    async (cacheComponents) => {
      const bundle = shellBundle();
      bundle.config.cacheComponents = cacheComponents;
      const seeded = await seedRouteFor(bundle, SHARED_SHELL, CONTEXT);

      expect(seeded?.input.generation.tags).toStrictEqual(buildTagsOf('app-page', SHARED_SHELL));
    },
  );

  it.each(['pages', 'app-route'] as const)('keeps %s tags unchanged', async (kind) => {
    const seeded = await seedRouteFor(shellBundle(SHARED_SHELL, kind), SHARED_SHELL, CONTEXT);

    expect(seeded?.input.generation.tags).toStrictEqual(buildTagsOf(kind, SHARED_SHELL));
  });

  it('adds nothing for an unknown entrypoint and continues to skip missing bodies or Pages APIs', async () => {
    const bundle = { ...shellBundle(), entrypoints: [] };

    await expect(seedRouteFor(bundle, SHARED_SHELL, CONTEXT)).resolves.toHaveProperty(
      'input.generation.tags',
      buildTagsOf('app-page', SHARED_SHELL),
    );
    await expect(
      seedRouteFor(shellBundle(), { ...SHARED_SHELL, body: undefined }, CONTEXT),
    ).resolves.toBeUndefined();
    await expect(
      seedRouteFor(shellBundle(SHARED_SHELL, 'pages-api'), SHARED_SHELL, CONTEXT),
    ).resolves.toBeUndefined();
  });

  it('deduplicates an identity already recorded by the build', async () => {
    const value = await sharedTag();
    const prerender = {
      ...SHARED_SHELL,
      initialHeaders: { 'x-next-cache-tags': `${value},${value}` },
    };
    const seeded = await seedRouteFor(shellBundle(prerender), prerender, CONTEXT);

    expect(seeded?.input.generation.tags).toStrictEqual(buildTagsOf('app-page', prerender));
    expect(seeded?.input.generation.tags.filter((tag) => tag.value === value)).toHaveLength(1);
  });

  it.each([1023, 1024])(
    'keeps all %i pre-existing tags and adds the identity without raising the quota',
    async (count) => {
      const prerender = taggedShell(count);
      const original = buildTagsOf('app-page', prerender);
      const seeded = await seedRouteFor(shellBundle(prerender), prerender, CONTEXT);

      expect(original).toHaveLength(count);
      expect(seeded?.input.generation.tags).toStrictEqual([
        ...original,
        { kind: 'next-implicit', value: await sharedTag() },
      ]);
      expect(seeded?.input.generation.tags).toHaveLength(count + 1);
    },
  );
});

describe('concrete pathname tags and class metadata in a seed', () => {
  it.each<{
    name: string;
    changes: Partial<Prerender>;
    classed: boolean;
  }>([
    {
      name: 'ordinary static output',
      changes: { route: '/about', pathname: '/about', routeType: 'page' },
      classed: false,
    },
    {
      name: 'literal bracket in a static segment',
      changes: { route: '/literal[brackets]', pathname: '/literal[brackets]', routeType: 'page' },
      classed: false,
    },
    {
      name: 'bracket-valued member of a dynamic route',
      changes: {
        route: '/blog/[slug]',
        pathname: '/blog/[literal]',
        routeType: 'page',
        parentFallbackMode: null,
      },
      classed: false,
    },
    {
      name: 'member whose value equals its own placeholder',
      changes: {
        route: '/blog/[slug]',
        pathname: '/blog/[slug]',
        routeType: 'page',
        parentFallbackMode: false,
      },
      classed: false,
    },
    {
      name: 'legacy bracket-valued member without class metadata',
      changes: { route: '/blog/[slug]', pathname: '/blog/[literal]', routeType: undefined },
      classed: false,
    },
    {
      name: 'legacy member whose value spells another parameter',
      changes: { route: '/[category]/[slug]', pathname: '/news/[category]', routeType: undefined },
      classed: false,
    },
    {
      name: 'unresolved reusable terminal shell',
      changes: {},
      classed: true,
    },
    {
      name: 'fallback class',
      changes: { route: '/blog/[slug]', pathname: '/blog/[slug]', routeType: 'fallback' },
      classed: true,
    },
    {
      name: 'blocking class entry labelled as a page',
      changes: {
        route: '/blog/[slug]',
        pathname: '/blog/[slug]',
        routeType: 'page',
        compute: 'blocking',
      },
      classed: true,
    },
    {
      name: 'empty optional catch-all member',
      changes: {
        route: '/docs/[[...slug]]',
        pathname: '/docs',
        routeType: 'page',
        parentFallbackMode: null,
      },
      classed: false,
    },
    {
      name: 'bracket-valued optional catch-all member',
      changes: {
        route: '/docs/[[...slug]]',
        pathname: '/docs/[literal]/tail',
        routeType: 'page',
        parentFallbackMode: false,
      },
      classed: false,
    },
    {
      name: 'optional catch-all class shell',
      changes: {
        route: '/docs/[[...slug]]',
        pathname: '/docs/[[...slug]]',
        routeType: 'shell',
      },
      classed: true,
    },
  ])('classifies $name', async ({ changes, classed }) => {
    const prerender = { ...SHARED_SHELL, ...changes };
    const seeded = await seedRouteFor(shellBundle(prerender), prerender, CONTEXT);
    const pathnameTag = `_N_T_${prerender.pathname}`;

    expect(seeded).toBeDefined();
    expect(seeded?.input.generation.tags.some((tag) => tag.value === pathnameTag)).toBe(!classed);
    expect(seeded?.cache?.route).toBe(classed ? prerender.route : undefined);
  });

  it('keeps recorded Pages tags without adding App Router pathname tags', () => {
    const prerender = {
      ...SHARED_SHELL,
      pathname: '/prefix/b/[literal]',
      initialHeaders: { 'x-next-cache-tags': 'from-build' },
    };

    expect(buildTagsOf('pages', prerender)).toStrictEqual([
      { kind: 'next-explicit', value: 'from-build' },
    ]);
  });
});
