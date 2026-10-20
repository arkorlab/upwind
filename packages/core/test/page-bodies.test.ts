import { describe, expect, it } from 'vitest';

import { completeAppPageBody } from '../src/bundle/page-bodies.ts';
import type { Entrypoint, Prerender } from '../src/bundle/schema.ts';

const DOCUMENT: Prerender = {
  id: 'document',
  pathname: '/docs/item/1',
  route: '/docs/item/[id]',
  parentOutputId: 'page',
  groupId: 1,
  routeType: 'page',
  response: 'complete',
  compute: 'static',
};
const ENTRY: Entrypoint = { id: 'page', kind: 'app-page', pathname: DOCUMENT.route };
const TWIN: Prerender = {
  id: 'flight',
  pathname: `${DOCUMENT.pathname}.rsc`,
  route: DOCUMENT.route,
  parentOutputId: 'page',
  groupId: 1,
};
const BLOB = { sha256: 'a'.repeat(64), byteLength: 1, contentType: 'text/plain' };

function eligible(
  document: Prerender = DOCUMENT,
  prerender: Prerender = document,
  entry: Entrypoint = ENTRY,
): boolean {
  return completeAppPageBody({ document, prerender, entry, basePath: '/docs', rscSuffix: '.rsc' });
}

describe('host-readable completed App page bodies', () => {
  it('admits the completed document and its unclassified whole Flight twin', () => {
    expect(eligible()).toBe(true);
    expect(eligible(DOCUMENT, TWIN)).toBe(true);
  });

  it.each([
    { field: 'routeType', value: 'shell' },
    { field: 'routeType', value: 'fallback' },
    { field: 'routeType', value: 'route' },
    { field: 'routeType', value: undefined },
    { field: 'response', value: 'initial' },
    { field: 'response', value: 'empty' },
    { field: 'response', value: undefined },
    { field: 'compute', value: 'resuming' },
    { field: 'compute', value: 'blocking' },
    { field: 'compute', value: undefined },
    { field: 'postponed', value: BLOB },
    { field: 'initialStatus', value: 404 },
    { field: 'partialFallback', value: true },
    { field: 'pathname', value: DOCUMENT.route },
  ])('keeps a document with $field=$value local', ({ field, value }) => {
    expect(eligible({ ...DOCUMENT, [field]: value })).toBe(false);
  });

  it.each([
    { kind: 'pages' as const },
    { kind: 'pages-api' as const },
    { kind: 'app-route' as const },
    { runtime: 'edge' as const },
    { pathname: '/another-route' },
  ])('keeps an incompatible entry $kind $runtime $pathname local', (change) => {
    expect(eligible(DOCUMENT, TWIN, { ...ENTRY, ...change })).toBe(false);
  });

  it.each([
    { groupId: 2 },
    { route: '/docs/other' },
    { parentOutputId: 'another-page' },
    { segmentPath: '/tree' },
    { pathname: `${DOCUMENT.pathname}.segments/tree.segment.rsc` },
    { postponed: BLOB },
    { initialStatus: 307 },
  ])('keeps an incompatible twin $pathname $groupId local', (change) => {
    expect(eligible(DOCUMENT, { ...TWIN, ...change })).toBe(false);
  });

  it('keeps internal error documents local under a base path', () => {
    for (const name of ['/_error', '/_global-error', '/_not-found']) {
      const route = `/docs${name}`;

      expect(
        eligible({ ...DOCUMENT, route, pathname: route }, undefined, { ...ENTRY, pathname: route }),
      ).toBe(false);
    }
  });

  it.each(
    ['', '/docs'].flatMap((basePath) => {
      return ['/404', '/500'].flatMap((name) => {
        const variants = [false, true];
        return variants.map((dynamic) => ({ basePath, name, dynamic }));
      });
    }),
  )(
    'keeps error output $name under $basePath with dynamic route $dynamic embedded',
    ({ basePath, name, dynamic }) => {
      const pathname = `${basePath}${name}`;
      const route = dynamic ? `${basePath}/[slug]` : pathname;
      const document = { ...DOCUMENT, pathname, route };
      const entry = { ...ENTRY, pathname: route };
      const twin = { ...TWIN, pathname: `${pathname}.rsc`, route };

      expect(
        completeAppPageBody({ document, prerender: document, entry, basePath, rscSuffix: '.rsc' }),
      ).toBe(false);
      expect(
        completeAppPageBody({ document, prerender: twin, entry, basePath, rscSuffix: '.rsc' }),
      ).toBe(false);
    },
  );

  it('keeps a base-path root alias that the current runtime cannot select local', () => {
    const root = { ...DOCUMENT, pathname: '/docs' };

    expect(eligible(root, { ...TWIN, pathname: '/docs/index.rsc' })).toBe(false);
    expect(eligible(root, { ...TWIN, pathname: '/docs.rsc' })).toBe(true);
    expect(eligible(root, { ...TWIN, pathname: '/docs/index.segments/tree.segment.rsc' })).toBe(
      false,
    );
  });

  it('accepts a normalized entry id independently of the raw Next parent output id', () => {
    expect(eligible(DOCUMENT, TWIN, { ...ENTRY, id: DOCUMENT.route })).toBe(true);
  });

  it('recognizes the bare application root Flight spelling selected by the runtime', () => {
    const root = { ...DOCUMENT, pathname: '/', route: '/' };

    expect(
      completeAppPageBody({
        document: root,
        prerender: { ...TWIN, pathname: '/index.rsc', route: '/' },
        entry: { ...ENTRY, pathname: '/', id: '/' },
        basePath: '',
        rscSuffix: '.rsc',
      }),
    ).toBe(true);
  });
});
