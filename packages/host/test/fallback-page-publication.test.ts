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

describe('version-three Pages build publication', () => {
  it('assembles native parameter descriptors without creating a class generation', async () => {
    const fixture = await fallbackPageFixture();
    const manifest = await assembleManifest({
      bundle: fixture.bundle,
      previous: undefined,
      projectId: 'site',
      runId: 'run',
      originHost: 'site.example',
      deploymentId: fixture.bundle.deploymentId,
      fingerprint: {
        dplId: fixture.bundle.deploymentId,
        buildId: 'build',
        assetSetHash: 'a'.repeat(64),
        observedAt: fixture.bundle.generatedAt,
      },
      app: { deploymentId: fixture.bundle.deploymentId, scriptName: 'app-script' },
      generatedAt: fixture.bundle.generatedAt,
      encodings: new Map(),
      preloads: {},
      recoverySource: "'sha256-recovery'",
      nextVersionJudged: true,
    });

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
