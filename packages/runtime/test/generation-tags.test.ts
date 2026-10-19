import type { Prerender } from '@stayingupwind/core/bundle';
import { IMPLICIT_TAG_PREFIX, sharedShellTagOf } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import type { CapturedRender } from '../src/cache/capture.ts';
import { generationClassShell, generationTagValues } from '../src/cache/generation-tags.ts';

const ENTRY_ID = 'entry-bracket-member';
const ROUTE = '/blog/[slug]';

function selected(fields: Partial<Prerender> = {}): Prerender {
  return {
    id: 'prerender-bracket',
    parentOutputId: 'output-bracket',
    groupId: 0,
    pathname: ROUTE,
    route: ROUTE,
    ...fields,
  };
}

function rendered(tags?: string): CapturedRender {
  return {
    html: new Uint8Array(),
    postponed: undefined,
    rscData: undefined,
    segments: new Map(),
    headers: tags === undefined ? {} : { 'x-next-cache-tags': tags },
    status: 200,
    cacheControl: { revalidate: 60, expire: 600 },
    data: undefined,
  };
}

describe('the implicit identities a regeneration supplies beside captured tags', () => {
  it.each([
    { route: ROUTE, pathname: '/blog/[literal]' },
    { route: ROUTE, pathname: '/en/blog/[literal]' },
    { route: '/[category]/[slug]', pathname: '/news/[category]' },
    { route: '/static[bracket]', pathname: '/static[bracket]' },
  ])('keeps the exact identity of concrete $pathname', ({ route, pathname }) => {
    const tags = generationTagValues({ kind: 'app-page', route, pathname }, rendered(), ENTRY_ID);

    expect(tags.has(`${IMPLICIT_TAG_PREFIX}${pathname}`)).toBe(true);
    expect(tags.has(sharedShellTagOf(ENTRY_ID))).toBe(false);
  });

  it.each([ROUTE, '/en/blog/[slug]'])(
    'leaves the unresolved shell %s without an exact identity',
    (pathname) => {
      const tags = generationTagValues(
        { kind: 'app-page', route: ROUTE, pathname },
        rendered(),
        ENTRY_ID,
      );

      expect(tags.has(`${IMPLICIT_TAG_PREFIX}${pathname}`)).toBe(false);
      expect(tags.has(sharedShellTagOf(ENTRY_ID))).toBe(true);
    },
  );

  it('unions recorded tags, including an exact native tag, without duplicating them', () => {
    const pathname = '/blog/[literal]';
    const exact = `${IMPLICIT_TAG_PREFIX}${pathname}`;
    const tags = generationTagValues(
      { kind: 'app-page', route: ROUTE, pathname },
      rendered(`product-1,${exact},product-1`),
      ENTRY_ID,
    );

    expect(tags.has('product-1')).toBe(true);
    expect([...tags].filter((tag) => tag === exact)).toHaveLength(1);
  });

  it('keeps the existing implicit-tag behavior of Pages Router entries', () => {
    const tags = generationTagValues(
      { kind: 'pages', route: ROUTE, pathname: '/blog/[literal]' },
      rendered('recorded-page'),
      ENTRY_ID,
    );

    expect([...tags]).toStrictEqual(['recorded-page']);
  });

  it.each([null, false, true, 'blocking'])(
    'keeps a member spelled as its placeholder when its parent fallback is %s',
    (parentFallbackMode) => {
      const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname: ROUTE };
      const isClass = generationClassShell(
        descriptor,
        selected({
          routeType: 'page',
          parentFallbackMode,
        }),
      );
      const tags = generationTagValues(descriptor, rendered(), ENTRY_ID, isClass);

      expect(isClass).toBe(false);
      expect(tags.has(`${IMPLICIT_TAG_PREFIX}${ROUTE}`)).toBe(true);
      expect(tags.has(sharedShellTagOf(ENTRY_ID))).toBe(false);
    },
  );

  it.each(['shell', 'fallback'] as const)(
    'uses explicit %s metadata for the same selected entry',
    (routeType) => {
      const pathname = '/blog/member';
      const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname };
      const isClass = generationClassShell(descriptor, selected({ pathname, routeType }));
      const tags = generationTagValues(descriptor, rendered(), ENTRY_ID, isClass);

      expect(isClass).toBe(true);
      expect(tags.has(`${IMPLICIT_TAG_PREFIX}${pathname}`)).toBe(false);
      expect(tags.has(sharedShellTagOf(ENTRY_ID))).toBe(true);
    },
  );

  it.each([
    { label: 'missing', shell: undefined },
    { label: 'legacy', shell: selected() },
    { label: 'another route', shell: selected({ route: '/another', parentFallbackMode: false }) },
    {
      label: 'another pathname',
      shell: selected({ pathname: '/blog/other', parentFallbackMode: false }),
    },
  ])('uses the route-aware fallback for $label metadata', ({ shell }) => {
    const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname: ROUTE };
    const isClass = generationClassShell(descriptor, shell);
    const tags = generationTagValues(descriptor, rendered(), ENTRY_ID, isClass);

    expect(isClass).toBe(true);
    expect(tags.has(`${IMPLICIT_TAG_PREFIX}${ROUTE}`)).toBe(false);
    expect(tags.has(sharedShellTagOf(ENTRY_ID))).toBe(true);
  });
});
