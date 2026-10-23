import type { Prerender } from '@stayingupwind/core/bundle';
import { deriveEntry } from '@stayingupwind/core/cache';
import { RSC_VARY } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Exercise the actual host and private table writers without exporting an internal API. */
import { assembleManifest } from '../../deploy/src/manifest.ts';
import { staticPagesOf } from '../../deploy/src/static-pages.ts';
import { seedRouteFor } from '../src/bundle/cache-seed.ts';
import { seedOutputSchema } from '../src/cache/scope-contract.ts';
import { STATIC_PAGE as PAGE, staticPageBundle as bundleOf } from './static-page-fixture.ts';

const SCOPE = 'dpl_static_pages';
const GENERATED_AT = 1_800_000_000_000;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('The fixture is missing a required value');
  return value;
}

function assembled(result: Awaited<ReturnType<typeof assembleManifest>>) {
  if (result.kind !== 'assembled') throw new Error(result.reason);
  return result;
}

describe('the host carries static Pages authority from the build to its current record', () => {
  it('uses the seeded Pages identity and preserves the marker through the seed schema', async () => {
    const bundle = bundleOf();
    const seed = required(
      await seedRouteFor(bundle, PAGE, { scopeId: SCOPE, generatedAt: GENERATED_AT }),
    );
    const document = required(seed.input.generation.outputs[0]);
    const expected = await deriveEntry(SCOPE, seed.input.descriptor);

    expect(seed.input.descriptor.kind).toBe('pages');
    expect(seedOutputSchema.parse(document).staticPagePrivacy).toBe(1);
    await expect(staticPagesOf(bundle, SCOPE)).resolves.toStrictEqual([
      { pathname: PAGE.pathname, route: PAGE.route, entryId: expected.entryId },
    ]);
  });

  it('marks only the HTML output, leaving the Pages data representation private', async () => {
    const data: Prerender = {
      ...PAGE,
      id: 'something-data',
      pathname: '/_next/data/build/something.json',
      body: { sha256: 'b'.repeat(64), byteLength: 20, contentType: 'application/json' },
    };
    const bundle = { ...bundleOf(), prerenders: [PAGE, data] };
    const seed = await seedRouteFor(bundle, PAGE, { scopeId: SCOPE, generatedAt: GENERATED_AT });

    expect(seed?.input.generation.outputs.map((output) => output.staticPagePrivacy)).toStrictEqual([
      1,
      undefined,
    ]);
    await expect(staticPagesOf(bundle, SCOPE)).resolves.toHaveLength(1);
  });

  it('retains the concrete Function placement and bypass conditions', async () => {
    const prerender = {
      ...PAGE,
      bypassFor: [{ type: 'header' as const, key: 'x-preview', value: 'yes' }],
    };
    const bundle = bundleOf(prerender);
    bundle.entrypoints = bundle.entrypoints.map((entry) => ({ ...entry, function: 'app-2' }));
    const [entry] = await staticPagesOf(bundle, SCOPE);

    expect({ function: entry?.function, bypassFor: entry?.bypassFor }).toStrictEqual({
      function: 'app-2',
      bypassFor: prerender.bypassFor,
    });
  });

  it('keeps old bundles unmarked even when reassembled by the new host', async () => {
    const legacy = bundleOf();
    delete legacy.staticPagesPrivacy;
    const seed = await seedRouteFor(legacy, PAGE, { scopeId: SCOPE, generatedAt: GENERATED_AT });

    expect(seed?.input.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
    await expect(staticPagesOf(legacy, SCOPE)).resolves.toStrictEqual([]);
  });

  it('does not bless a substituted output that is not the eligible bundle member', async () => {
    const bundle = bundleOf();
    const substituted = { ...PAGE, initialHeaders: { 'set-cookie': 'visitor=one' } };
    const seed = await seedRouteFor(bundle, substituted, {
      scopeId: SCOPE,
      generatedAt: GENERATED_AT,
    });

    expect(seed?.input.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
  });

  it('retains a configured no-transform prohibition without copying CDN freshness', async () => {
    const bundle = bundleOf();
    bundle.routing.beforeMiddleware = [
      {
        sourceRegex: '^/something$',
        headers: { 'CDN-Cache-Control': 's-maxage=600, no-transform' },
      },
    ];
    const seed = await seedRouteFor(bundle, PAGE, { scopeId: SCOPE, generatedAt: GENERATED_AT });

    expect(seed?.input.generation.outputs[0]?.staticPagePrivacy).toBe(1);
    expect(seed?.input.generation.headers).toStrictEqual({
      'content-type': 'text/html; charset=utf-8',
      vary: RSC_VARY,
      'cache-control': 'no-transform',
    });
  });

  it.each<Partial<Prerender>>([
    { initialRevalidate: 2 },
    { initialRevalidate: undefined },
    { initialStatus: 500 },
    { response: 'initial' },
    { compute: 'blocking' },
    { routeType: 'fallback' },
    { postponed: { sha256: 'b'.repeat(64), byteLength: 1, contentType: 'application/json' } },
    { initialHeaders: { 'cache-control': 'private' } },
    { initialHeaders: { 'set-cookie': 'visitor=one' } },
    { initialHeaders: { vary: '*' } },
    { allowHeader: ['x-visitor'] },
    { allowQuery: ['visitor'] },
  ])('does not mark or map an incompatible build output %j', async (changes) => {
    const prerender = { ...PAGE, ...changes };
    const bundle = bundleOf(prerender);
    const seed = await seedRouteFor(bundle, prerender, {
      scopeId: SCOPE,
      generatedAt: GENERATED_AT,
    });

    expect(seed?.input.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
    await expect(staticPagesOf(bundle, SCOPE)).resolves.toStrictEqual([]);
  });

  it.each([true, false])('assembles the table only when runtime cache is %s', async (cached) => {
    const bundle = bundleOf();
    const result = await assembleManifest({
      bundle,
      previous: undefined,
      projectId: 'site',
      runId: 'run_static_pages',
      originHost: 'site.example',
      deploymentId: SCOPE,
      fingerprint: {
        assetSetHash: 'b'.repeat(64),
        dplId: SCOPE,
        buildId: bundle.buildId,
        observedAt: '2026-10-18T00:00:00.000Z',
      },
      app: { deploymentId: SCOPE, scriptName: 'static-pages-app' },
      generatedAt: '2026-10-18T00:00:00.000Z',
      encodings: new Map(),
      preloads: {},
      recoverySource: "'sha256-recovery'",
      runtimeCache: cached,
    });
    const built = assembled(result);

    expect(Object.keys(built.manifest.staticPages ?? {})).toStrictEqual(
      cached ? [PAGE.pathname] : [],
    );
    expect(built.serialized.includes('staticPages')).toBe(cached);
  });
});
