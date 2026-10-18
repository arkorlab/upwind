import { describe, expect, it } from 'vitest';

import { partialFallbackUpgradeOf } from '../src/bundle/index.ts';
import type { DeploymentBundle, Entrypoint, Prerender } from '../src/bundle/schema.ts';
import { completedPathname } from '../src/manifest/completion.ts';
import { routeEntrySchema } from '../src/manifest/schema.ts';

const ROUTE = '/[slug]';
const shell: Prerender = {
  id: ROUTE,
  route: ROUTE,
  pathname: ROUTE,
  parentOutputId: ROUTE,
  groupId: 1,
  routeType: 'fallback',
  response: 'initial',
  compute: 'resuming',
  renderingMode: 'PARTIALLY_STATIC',
  partialFallback: true,
  allowQuery: ['nxtPslug'],
  body: { sha256: 'a'.repeat(64), byteLength: 100, contentType: 'text/html' },
  postponed: { sha256: 'b'.repeat(64), byteLength: 10, contentType: 'application/json' },
};
const bundle: Pick<DeploymentBundle, 'config' | 'entrypoints'> = {
  config: {
    basePath: '',
    trailingSlash: false,
    skipTrailingSlashRedirect: false,
    poweredByHeader: false,
    cacheComponents: true,
    partialPrefetching: true,
  },
  entrypoints: [{ id: ROUTE, pathname: ROUTE, kind: 'app-page' }],
};

describe('a partial fallback shell completed behind its first response', () => {
  it('names a concrete entry for the unknown member while retaining the source route', () => {
    expect(partialFallbackUpgradeOf(bundle, shell)).toStrictEqual({ route: ROUTE });
  });

  it('keeps parameters outside the completion key as placeholders', () => {
    const route = '/[category]/[slug]';
    const prerender = { ...shell, route, pathname: route, allowQuery: ['nxtPcategory'] };
    const deployed = {
      ...bundle,
      entrypoints: [{ id: route, pathname: route, kind: 'app-page' as const }],
    };
    const upgrade = partialFallbackUpgradeOf(deployed, prerender);

    expect(upgrade).toStrictEqual({ route, keyedBy: ['category'] });
    expect(completedPathname(route, upgrade?.keyedBy ?? [], '/two/article')).toBe('/two/[slug]');
  });

  it('retains a fixed prefix in the completion key for a narrower class', () => {
    const route = '/[category]/[slug]/[id]';
    const prerender = {
      ...shell,
      route,
      pathname: '/news/[slug]/[id]',
      allowQuery: ['nxtPslug'],
    };
    const deployed = {
      ...bundle,
      entrypoints: [{ id: route, pathname: route, kind: 'app-page' as const }],
    };

    expect(partialFallbackUpgradeOf(deployed, prerender)).toStrictEqual({
      route,
      keyedBy: ['category', 'slug'],
    });
  });

  it.each([
    { partialFallback: undefined },
    { partialFallback: false },
    { body: undefined },
    { postponed: undefined },
    { renderingMode: 'STATIC' as const },
    { routeType: 'route' as const },
    { response: 'complete' as const },
    { compute: 'static' as const },
    { initialStatus: 404 },
    { pathname: '/one' },
    { allowQuery: undefined },
    { allowQuery: [] },
    { allowQuery: ['search'] },
    { allowQuery: ['nxtPslug', 'search'] },
    { allowQuery: ['nxtPother'] },
  ])('leaves a shell without a safe unfinished parameter key unchanged: %j', (fields) => {
    expect(partialFallbackUpgradeOf(bundle, { ...shell, ...fields })).toBeUndefined();
  });

  it.each(['cacheComponents', 'partialPrefetching'] as const)(
    'requires the build to enable %s',
    (flag) => {
      expect(
        partialFallbackUpgradeOf({ ...bundle, config: { ...bundle.config, [flag]: false } }, shell),
      ).toBeUndefined();
    },
  );

  it.each(['pages', 'pages-api', 'app-route'] as const)(
    'does not opt a %s entrypoint into document specialization',
    (kind) => {
      const entry: Entrypoint = { id: ROUTE, pathname: ROUTE, kind };

      expect(partialFallbackUpgradeOf({ ...bundle, entrypoints: [entry] }, shell)).toBeUndefined();
    },
  );

  it('keeps edge-runtime and unknown entrypoints out of specialization', () => {
    const edge: Entrypoint = { id: ROUTE, pathname: ROUTE, kind: 'app-page', runtime: 'edge' };

    expect(partialFallbackUpgradeOf({ ...bundle, entrypoints: [edge] }, shell)).toBeUndefined();
    expect(partialFallbackUpgradeOf({ ...bundle, entrypoints: [] }, shell)).toBeUndefined();
  });

  it.each(['/[...slug]', '/[[...slug]]', '/elsewhere/[slug]'])(
    'does not guess a completion for an unsupported or mismatched route: %s',
    (route) => {
      const deployed = {
        ...bundle,
        entrypoints: [{ id: route, pathname: route, kind: 'app-page' as const }],
      };

      expect(partialFallbackUpgradeOf(deployed, { ...shell, route })).toBeUndefined();
    },
  );
});

describe('the optional partial fallback delivery contract', () => {
  const entry = {
    pathname: ROUTE,
    status: 200,
    shell: { ...shell.body, encoding: 'identity' },
    headers: {},
  };

  it('preserves the completion key while keeping old route entries unchanged', () => {
    const partialFallback = { route: '/[category]/[slug]', keyedBy: ['category'] };

    expect(routeEntrySchema.parse({ ...entry, partialFallback })).toStrictEqual({
      ...entry,
      partialFallback,
    });
    expect(routeEntrySchema.parse(entry)).toStrictEqual(entry);
  });
});
