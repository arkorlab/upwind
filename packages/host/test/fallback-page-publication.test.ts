import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import { deriveEntry } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import { cacheEntryIdsOf } from '../../deploy/src/cache-seed.ts';
import { assembleManifest } from '../../deploy/src/manifest.ts';
import { shellsOf } from '../../deploy/src/shells.ts';
import { pagesFallbacksOf, staticPagesOf } from '../../deploy/src/static-pages.ts';
import { seedRouteFor } from '../src/bundle/cache-seed.ts';
import { commitRequestSchema } from '../src/cache/gateway-contract.ts';
import {
  BUILT_PATH,
  FALLBACK_NOW,
  FALLBACK_ROUTE,
  fallbackPageFixture,
} from './fallback-page-fixture.ts';

function assertAssembled(
  value: Awaited<ReturnType<typeof assembleManifest>>,
): asserts value is Extract<Awaited<ReturnType<typeof assembleManifest>>, { kind: 'assembled' }> {
  if (value.kind !== 'assembled') throw new Error(value.reason);
}

function assemble(bundle: DeploymentBundle): ReturnType<typeof assembleManifest> {
  return assembleManifest({
    bundle,
    previous: undefined,
    projectId: 'site',
    runId: 'run',
    originHost: 'site.example',
    deploymentId: bundle.deploymentId,
    fingerprint: {
      dplId: bundle.deploymentId,
      buildId: 'build',
      assetSetHash: 'a'.repeat(64),
      observedAt: bundle.generatedAt,
    },
    app: { deploymentId: bundle.deploymentId, scriptName: 'app-script' },
    generatedAt: bundle.generatedAt,
    encodings: new Map(),
    preloads: {},
    recoverySource: "'sha256-recovery'",
    nextVersionJudged: true,
  });
}

describe('version-three Pages build publication', () => {
  it('assembles native parameter descriptors without creating a class generation', async () => {
    const fixture = await fallbackPageFixture();
    const manifest = await assemble(fixture.bundle);

    expect(manifest.kind).toBe('assembled');

    assertAssembled(manifest);

    expect(manifest.manifest.staticPages?.[BUILT_PATH]?.staticPagePrivacy).toBe(3);
    expect(manifest.manifest.pagesFallbacks?.[FALLBACK_ROUTE]?.staticPagePrivacy).toBe(3);
    expect(manifest.manifest.routes[FALLBACK_ROUTE]?.cache).toBeUndefined();
    expect(cacheEntryIdsOf(fixture.bundle)).toContain(fixture.page.id);
    expect(cacheEntryIdsOf(fixture.bundle)).not.toContain(fixture.fallback.id);
    expect(new Set(shellsOf(fixture.bundle).map((shell) => shell.sha256))).toStrictEqual(
      new Set([
        fixture.fallback.body?.sha256,
        fixture.page.body?.sha256,
        fixture.twin.body?.sha256,
      ]),
    );
  });

  it('seeds paired concrete outputs and publishes a separate class loading blob', async () => {
    const fixture = await fallbackPageFixture();
    const seeded = await seedRouteFor(fixture.bundle, fixture.page, {
      scopeId: 'deployment',
      generatedAt: FALLBACK_NOW,
    });
    const entries = await staticPagesOf(fixture.bundle, 'deployment');
    const fallbacks = pagesFallbacksOf(fixture.bundle);
    const committed = commitRequestSchema.parse({
      fencingToken: 1,
      observedTagRevision: 0,
      generation: { ...seeded?.input.generation, dependencies: [] },
    });

    expect(committed.generation.outputs.map((output) => output.staticPagePrivacy)).toStrictEqual([
      3, 3,
    ]);

    expect(
      seeded?.input.generation.outputs.map((output) => {
        return {
          representation: output.representationKey,
          pathname: output.pathname,
          marker: output.staticPagePrivacy,
          compute: output.compute,
          response: output.response,
        };
      }),
    ).toStrictEqual([
      {
        representation: 'html',
        pathname: BUILT_PATH,
        marker: 3,
        compute: 'static',
        response: 'complete',
      },
      {
        representation: 'pages-data',
        pathname: fixture.twin.pathname,
        marker: 3,
        compute: 'static',
        response: 'complete',
      },
    ]);
    expect(entries).toMatchObject([
      {
        pathname: BUILT_PATH,
        route: FALLBACK_ROUTE,
        staticPagePrivacy: 3,
        parameters: { slug: 'first' },
        dataPathname: fixture.twin.pathname,
      },
    ]);
    expect(fallbacks).toMatchObject([
      {
        route: FALLBACK_ROUTE,
        staticPagePrivacy: 3,
        dataPathname: '/_next/data/build/fallback-true/[slug].json',
        shell: { artifact: fixture.fallback.body },
      },
    ]);
    expect(fallbacks.every((entry) => !Object.hasOwn(entry, 'entryId'))).toBe(true);
  });

  it.each([false, 2] as const)(
    'keeps fixed build proof independently versioned for revalidate %j',
    async (initialRevalidate) => {
      const fixture = await fallbackPageFixture();
      const page = {
        ...fixture.page,
        pathname: '/news',
        route: '/news',
        allowQuery: [],
        parentFallbackMode: undefined,
        initialRevalidate,
        initialExpiration: undefined,
      };
      const bundle = {
        ...fixture.bundle,
        entrypoints: [{ id: 'page', kind: 'pages' as const, pathname: '/news' }],
        prerenders: [page],
      };
      const seeded = await seedRouteFor(bundle, page, {
        scopeId: 'deployment',
        generatedAt: FALLBACK_NOW,
      });
      const entries = await staticPagesOf(bundle, 'deployment');

      expect(seeded?.input.generation.outputs[0]?.staticPagePrivacy).toBe(
        initialRevalidate === false ? 1 : 2,
      );
      expect(entries[0]?.staticPagePrivacy).toBe(initialRevalidate === false ? undefined : 2);
      expect(pagesFallbacksOf(bundle)).toStrictEqual([]);
    },
  );

  it.each([1, 2] as const)(
    'never borrows member or loading authority from capability %i',
    async (staticPagesPrivacy) => {
      const fixture = await fallbackPageFixture();
      const bundle = { ...fixture.bundle, staticPagesPrivacy };

      await expect(staticPagesOf(bundle, 'deployment')).resolves.toStrictEqual([]);
      expect(pagesFallbacksOf(bundle)).toStrictEqual([]);
    },
  );

  it.each([false, 2] as const)(
    'preserves native routing and raw seed identity without trailing-slash sharing for revalidate %j',
    async (initialRevalidate) => {
      const fixture = await fallbackPageFixture();
      const page = {
        ...fixture.page,
        route: '/news',
        pathname: '/news',
        allowQuery: [],
        parentFallbackMode: undefined,
        initialRevalidate,
        initialExpiration: undefined,
      };
      const bundle = {
        ...fixture.bundle,
        config: { ...fixture.bundle.config, trailingSlash: true },
        entrypoints: [{ id: 'page', kind: 'pages' as const, pathname: '/news' }],
        prerenders: [page],
      };
      const seeded = await seedRouteFor(bundle, page, {
        scopeId: bundle.deploymentId,
        generatedAt: FALLBACK_NOW,
      });
      const { entryId } = await deriveEntry(bundle.deploymentId, {
        kind: 'pages',
        route: '/news',
        pathname: '/news',
      });
      const manifest = await assemble(bundle);

      assertAssembled(manifest);

      expect(seeded?.input.descriptor).toStrictEqual({
        kind: 'pages',
        route: '/news',
        pathname: '/news',
      });
      expect(manifest.manifest.staticPages).toBeUndefined();
      expect(manifest.manifest.routes['/news/']?.cache?.entryId).toBe(entryId);
      expect(manifest.manifest.pagesFallbacks).toBeUndefined();
    },
  );

  it.each([
    { name: 'another group', groupId: 99 },
    { name: 'another source', parentOutputId: 'foreign-page' },
    { name: 'same owner', groupId: 1, parentOutputId: 'page' },
  ])('imports no paired props for duplicate-path ambiguity: $name', async (changes) => {
    const fixture = await fallbackPageFixture();
    const foreign = {
      ...fixture.twin,
      ...changes,
      id: 'foreign-props',
      body: { sha256: 'd'.repeat(64), byteLength: 30, contentType: 'application/json' },
    };
    const bundle = {
      ...fixture.bundle,
      prerenders: [fixture.page, foreign, fixture.twin, fixture.fallback],
    };
    const props = shellsOf(bundle).filter((shell) => shell.kind === 'static-data');

    await expect(staticPagesOf(bundle, 'deployment')).resolves.toStrictEqual([]);
    expect(props).toStrictEqual([]);
  });

  it('keeps parameter fallback authority disabled for trailing-slash builds', async () => {
    const fixture = await fallbackPageFixture();
    const bundle = {
      ...fixture.bundle,
      config: { ...fixture.bundle.config, trailingSlash: true },
    };

    await expect(staticPagesOf(bundle, 'deployment')).resolves.toStrictEqual([]);
    expect(pagesFallbacksOf(bundle)).toStrictEqual([]);
  });

  it('keeps a missing or private props twin outside concrete sharing authority', async () => {
    const fixture = await fallbackPageFixture();
    for (const prerenders of [
      [fixture.page, fixture.fallback],
      [
        fixture.page,
        { ...fixture.twin, initialHeaders: { 'set-cookie': 'visitor=one' } },
        fixture.fallback,
      ],
    ]) {
      const bundle = { ...fixture.bundle, prerenders };

      await expect(staticPagesOf(bundle, 'deployment')).resolves.toStrictEqual([]);

      const seeded = await seedRouteFor(bundle, fixture.page, {
        scopeId: 'deployment',
        generatedAt: FALLBACK_NOW,
      });

      expect(
        seeded?.input.generation.outputs.every((output) => output.staticPagePrivacy === undefined),
      ).toBe(true);
    }
  });
});
