import { describe, expect, it } from 'vitest';

import {
  type DeploymentBundle,
  type Prerender,
  deploymentBundleSchema,
} from '../src/bundle/schema.ts';
import {
  edgeServableStaticPages,
  staticPagePrivacyFor,
  staticPagesPrivacyOf,
} from '../src/bundle/static-pages.ts';
import { staticPageEntrySchema } from '../src/manifest/schema.ts';
import { createId } from '../src/util/index.ts';

const GENERATED_AT = '2026-10-20T00:00:00.000Z';
const PAGE: Prerender = {
  id: 'html',
  pathname: '/something',
  route: '/something',
  parentOutputId: 'page',
  groupId: 1,
  routeType: 'page',
  response: 'complete',
  compute: 'static',
  initialRevalidate: 2,
  body: { sha256: 'a'.repeat(64), byteLength: 8, contentType: 'text/html' },
};
const FUNCTION = {
  mainModule: 'index.mjs',
  modules: [],
  compatibilityDate: '2026-10-01',
  compatibilityFlags: [],
};
function bundleOf(extra: Partial<DeploymentBundle> = {}): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: GENERATED_AT,
    staticPagesPrivacy: 2,
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
      dynamicRoutes: [],
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
    entrypoints: [{ id: 'page', kind: 'pages', pathname: '/something' }],
    prerenders: [PAGE],
    staticFiles: [],
    functions: { app: FUNCTION },
    ...extra,
  };
}

describe('versioned static Pages ISR admission', () => {
  it('returns both versions in original order using exact output objects', () => {
    const first = { ...PAGE, initialRevalidate: false as const };
    const second = { ...PAGE, id: 'news', pathname: '/news', route: '/news', groupId: 2 };
    const bundle = bundleOf({
      prerenders: [first, second],
      entrypoints: [
        { id: 'page', kind: 'pages', pathname: first.pathname },
        { id: 'news', kind: 'pages', pathname: second.pathname },
      ],
    });
    const admitted = staticPagesPrivacyOf(bundle);

    expect([...admitted]).toStrictEqual([
      [first, 1],
      [second, 2],
    ]);
    expect(edgeServableStaticPages(bundle)).toStrictEqual([...admitted.keys()]);
    expect(admitted.has({ ...first })).toBe(false);
    expect([...admitted.keys()][0]).toBe(first);
  });

  it.each(['/', '/news'])('admits an exact complete Node ISR document at %s', (pathname) => {
    const page = { ...PAGE, pathname, route: pathname };
    const bundle = bundleOf({
      prerenders: [page],
      entrypoints: [{ id: 'page', kind: 'pages', pathname }],
    });

    expect(edgeServableStaticPages(bundle)).toStrictEqual([page]);
    expect(staticPagePrivacyFor(bundle, page)).toBe(2);
    expect(
      staticPageEntrySchema.parse({
        pathname,
        route: pathname,
        entryId: 'entry',
        staticPagePrivacy: 2,
      }),
    ).toHaveProperty('staticPagePrivacy', 2);
  });

  it('keeps false-revalidate build authority at version 1 even in a version 2 bundle', () => {
    const page = { ...PAGE, initialRevalidate: false as const };
    const bundle = bundleOf({ prerenders: [page] });

    expect(staticPagePrivacyFor(bundle, page)).toBe(1);
    expect(
      staticPageEntrySchema.parse({ pathname: PAGE.pathname, route: PAGE.route, entryId: 'entry' }),
    ).not.toHaveProperty('staticPagePrivacy');
  });

  it('preserves fixed-page proof versions instead of inheriting fallback capability 3', () => {
    const finite = bundleOf({ staticPagesPrivacy: 3 });
    const immutable = { ...PAGE, initialRevalidate: false as const };

    expect(staticPagePrivacyFor(finite, PAGE)).toBe(2);
    expect(staticPagePrivacyFor({ ...finite, prerenders: [immutable] }, immutable)).toBe(1);
    expect(deploymentBundleSchema.parse(finite)).toHaveProperty('staticPagesPrivacy', 3);
  });

  it.each([1, undefined] as const)(
    'does not infer ISR permission from capability %s',
    (staticPagesPrivacy) => {
      const bundle = bundleOf({ staticPagesPrivacy });

      expect(staticPagePrivacyFor(bundle, PAGE)).toBeUndefined();
      expect(edgeServableStaticPages(bundle)).toStrictEqual([]);
    },
  );

  it('requires the actual immutable output instead of a matching copied descriptor', () => {
    const bundle = bundleOf();

    expect(staticPagePrivacyFor(bundle, { ...PAGE })).toBeUndefined();
    expect(staticPagePrivacyFor(bundleOf({ prerenders: [] }), PAGE)).toBeUndefined();
  });

  it.each([
    { name: 'zero lifetime', patch: { initialRevalidate: 0 } },
    { name: 'unknown lifetime', patch: { initialRevalidate: undefined } },
    { name: 'fractional lifetime', patch: { initialRevalidate: 0.5 } },
    { name: 'expiry before revalidation', patch: { initialExpiration: 1 } },
    { name: 'query dependency', patch: { allowQuery: ['visitor'] } },
    { name: 'application header dependency', patch: { allowHeader: ['cookie'] } },
    { name: 'partial response', patch: { response: 'initial' } },
    { name: 'dynamic compute', patch: { compute: 'blocking' } },
    { name: 'postponed state', patch: { postponed: PAGE.body } },
    { name: 'error status', patch: { initialStatus: 404 } },
    { name: 'private original policy', patch: { initialHeaders: { 'Cache-Control': 'private' } } },
    { name: 'cookie', patch: { initialHeaders: { 'Set-Cookie': 'session=value' } } },
    { name: 'unrecognized variation', patch: { initialHeaders: { Vary: 'x-visitor' } } },
    {
      name: 'nonce',
      patch: { initialHeaders: { 'Content-Security-Policy': "script-src 'nonce-personal'" } },
    },
  ] satisfies { name: string; patch: Partial<Prerender> }[])('refuses $name', ({ patch }) => {
    const page = { ...PAGE, ...patch };

    expect(staticPagePrivacyFor(bundleOf({ prerenders: [page] }), page)).toBeUndefined();
  });

  it.each(['/[slug]', '/404', '/500'])('refuses a class or reserved route %s', (pathname) => {
    const page = { ...PAGE, pathname, route: pathname };

    expect(
      staticPagePrivacyFor(
        bundleOf({ prerenders: [page], entrypoints: [{ id: 'page', kind: 'pages', pathname }] }),
        page,
      ),
    ).toBeUndefined();
  });

  it('denies unsupported routing and non-Node source entries', () => {
    const bundle = bundleOf();

    expect(
      staticPagePrivacyFor({ ...bundle, config: { ...bundle.config, basePath: '/docs' } }, PAGE),
    ).toBeUndefined();
    expect(
      staticPagePrivacyFor(
        { ...bundle, config: { ...bundle.config, i18n: { locales: ['en'], defaultLocale: 'en' } } },
        PAGE,
      ),
    ).toBeUndefined();
    expect(
      staticPagePrivacyFor({ ...bundle, config: { ...bundle.config, output: 'export' } }, PAGE),
    ).toBeUndefined();
    expect(
      staticPagePrivacyFor(
        {
          ...bundle,
          entrypoints: [{ id: 'page', kind: 'pages', pathname: PAGE.pathname, runtime: 'edge' }],
        },
        PAGE,
      ),
    ).toBeUndefined();
    expect(
      staticPagePrivacyFor(
        { ...bundle, entrypoints: [{ id: 'page', kind: 'app-page', pathname: PAGE.pathname }] },
        PAGE,
      ),
    ).toBeUndefined();
  });

  it('retains capability 2 and refuses unknown schema versions', () => {
    expect(deploymentBundleSchema.parse(bundleOf())).toHaveProperty('staticPagesPrivacy', 2);
    expect(deploymentBundleSchema.safeParse({ ...bundleOf(), staticPagesPrivacy: 4 }).success).toBe(
      false,
    );
    expect(
      staticPageEntrySchema.safeParse({
        pathname: PAGE.pathname,
        route: PAGE.route,
        entryId: 'entry',
        staticPagePrivacy: 3,
      }).success,
    ).toBe(false);
  });
});
