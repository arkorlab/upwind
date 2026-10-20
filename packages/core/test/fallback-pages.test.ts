import { describe, expect, it } from 'vitest';

import {
  staticFallbackPageFor,
  staticFallbackPagesOf,
  staticFallbackParametersFor,
  staticPagesMembersOf,
} from '../src/bundle/fallback-pages.ts';
import type { Prerender } from '../src/bundle/schema.ts';
import { staticPagesPrivacyOf } from '../src/bundle/static-pages.ts';
import { staticPageDataHeadersAllowSharing } from '../src/cache/static-pages.ts';
import {
  FALLBACK_DATA,
  FALLBACK_MEMBER,
  FALLBACK_PAGE,
  FALLBACK_ROUTE,
  fallbackBundle,
} from './fallback-pages-fixtures.ts';

describe('build-owned Pages fallback authority', () => {
  it('separates the complete HTML/data member from its immutable loading shell', () => {
    const bundle = fallbackBundle();
    const member = staticFallbackPageFor(bundle, FALLBACK_ROUTE, '/fallback-true/first');
    const lazy = staticFallbackPageFor(bundle, FALLBACK_ROUTE, '/fallback-true/second');

    expect(member).toStrictEqual({
      kind: 'member',
      page: FALLBACK_MEMBER,
      params: { slug: 'first' },
      dataPathname: '/_next/data/build/fallback-true/first.json',
      privacy: 3,
    });
    expect(lazy).toStrictEqual({
      kind: 'fallback',
      page: FALLBACK_PAGE,
      params: { slug: 'second' },
      dataPathname: '/_next/data/build/fallback-true/second.json',
      privacy: 3,
    });
    expect(staticPagesMembersOf(bundle).get(FALLBACK_MEMBER)).toBe(member);
    expect(staticPagesMembersOf(bundle).has({ ...FALLBACK_MEMBER })).toBe(false);
    expect(staticFallbackPagesOf(bundle)).toStrictEqual([FALLBACK_PAGE]);
    expect(staticPagesPrivacyOf(bundle).size).toBe(0);
  });

  it.each([undefined, 1, 2] as const)(
    'does not borrow version %s authority',
    (staticPagesPrivacy) => {
      const bundle = fallbackBundle({ staticPagesPrivacy });

      expect(staticPagesMembersOf(bundle).size).toBe(0);
      expect(
        staticFallbackPageFor(bundle, FALLBACK_ROUTE, '/fallback-true/second'),
      ).toBeUndefined();
    },
  );

  it.each([
    ['/x/[slug]', '/x/hello', { slug: 'hello' }],
    ['/x/[slug]', 'ignored/x/hello', undefined],
    ['/x/[category]/[slug]', '/x/news/post-1', { category: 'news', slug: 'post-1' }],
    ['/x/[slug]', '/x/%66irst', undefined],
    ['/x/[slug]', '/x/a%2Fb', undefined],
    ['/x/[slug]', '/x/a/', undefined],
    ['/x/[slug]', '/x//a', undefined],
    ['/x/[slug]', '/x/..', undefined],
    ['/x/[slug]', '/x/[slug]', undefined],
    ['/x/[...slug]', '/x/a', undefined],
    ['/x/[[...slug]]', '/x/a', undefined],
    ['/x/[slug]/[slug]', '/x/a/b', undefined],
    ['/x/[__proto__]', '/x/a', undefined],
  ])('matches only a supported canonical member: %s %s', (route, pathname, expected) => {
    expect(staticFallbackParametersFor(route, pathname)).toStrictEqual(expected);
  });

  it.each([
    { name: 'missing props', data: undefined },
    {
      name: 'private raw JSON',
      data: { ...FALLBACK_DATA, initialHeaders: { 'Cache-Control': 'private' } },
    },
    {
      name: 'JSON cookie',
      data: { ...FALLBACK_DATA, initialHeaders: { 'Set-Cookie': 'session=1' } },
    },
    { name: 'different generation group', data: { ...FALLBACK_DATA, groupId: 10 } },
    { name: 'different source owner', data: { ...FALLBACK_DATA, parentOutputId: 'other' } },
    { name: 'different lifetime', data: { ...FALLBACK_DATA, initialRevalidate: 3 } },
    {
      name: 'wrong build',
      data: { ...FALLBACK_DATA, pathname: '/_next/data/other/fallback-true/first.json' },
    },
    { name: 'dynamic props', data: { ...FALLBACK_DATA, compute: 'blocking' as const } },
    { name: 'visitor query', data: { ...FALLBACK_DATA, allowQuery: ['visitor'] } },
  ])('does not replace an unproved built member with loading bytes: $name', ({ data }) => {
    const prerenders = [FALLBACK_MEMBER, FALLBACK_PAGE, ...(data === undefined ? [] : [data])];
    const bundle = fallbackBundle({ prerenders });

    expect(staticPagesMembersOf(bundle).size).toBe(0);
    expect(staticFallbackPageFor(bundle, FALLBACK_ROUTE, FALLBACK_MEMBER.pathname)).toBeUndefined();
  });

  it('rejects duplicate paired outputs independently of their order', () => {
    for (const data of [
      [FALLBACK_DATA, { ...FALLBACK_DATA, id: 'duplicate' }],
      [{ ...FALLBACK_DATA, id: 'duplicate' }, FALLBACK_DATA],
    ]) {
      const bundle = fallbackBundle({ prerenders: [FALLBACK_MEMBER, ...data, FALLBACK_PAGE] });

      expect(staticPagesMembersOf(bundle).size).toBe(0);
    }
  });

  it('rejects duplicate source owners and class outputs rather than choosing the last', () => {
    const base = fallbackBundle();
    const duplicateSource = { ...base.entrypoints[0]!, id: 'another-owner' };
    for (const entrypoints of [
      [...base.entrypoints, duplicateSource],
      [duplicateSource, ...base.entrypoints],
    ]) {
      const bundle = { ...base, entrypoints };

      expect(staticFallbackPagesOf(bundle)).toStrictEqual([]);
      expect(staticPagesMembersOf(bundle).size).toBe(0);
    }
    const duplicate = { ...FALLBACK_PAGE, id: 'duplicate', groupId: 3 };

    expect(
      staticFallbackPagesOf({ ...base, prerenders: [...base.prerenders, duplicate] }),
    ).toStrictEqual([]);
  });

  it.each([
    { routeType: 'page' },
    { response: 'complete' },
    { compute: 'blocking' },
    { initialHeaders: { 'Cache-Control': 'private' } },
    { allowQuery: ['visitor'] },
    { initialStatus: 404 },
    { postponed: FALLBACK_PAGE.body },
  ] satisfies Partial<Prerender>[])('does not use an untrusted loading shell: %j', (patch) => {
    const bundle = fallbackBundle({
      prerenders: [FALLBACK_MEMBER, FALLBACK_DATA, { ...FALLBACK_PAGE, ...patch }],
    });

    expect(staticFallbackPagesOf(bundle)).toStrictEqual([]);
    expect(staticFallbackPageFor(bundle, FALLBACK_ROUTE, '/fallback-true/second')).toBeUndefined();
  });

  it('requires the native first owner and leaves exact routes and configured rewrites alone', () => {
    const base = fallbackBundle();
    const earlier = {
      sourceRegex: '^/fallback-true/([^/]+?)(?:/)?$',
      destination: '/other/[slug]',
    };

    expect(
      staticFallbackPageFor(
        {
          ...base,
          routing: { ...base.routing, dynamicRoutes: [earlier, ...base.routing.dynamicRoutes] },
        },
        FALLBACK_ROUTE,
        '/fallback-true/second',
      ),
    ).toBeUndefined();
    expect(
      staticFallbackPageFor(
        {
          ...base,
          entrypoints: [
            ...base.entrypoints,
            { id: 'exact', pathname: '/fallback-true/second', kind: 'pages' },
          ],
        },
        FALLBACK_ROUTE,
        '/fallback-true/second',
      ),
    ).toBeUndefined();
    expect(
      staticFallbackPageFor(
        {
          ...base,
          routing: {
            ...base.routing,
            beforeFiles: [{ sourceRegex: '^/fallback-true/second$', destination: '/private' }],
          },
        },
        FALLBACK_ROUTE,
        '/fallback-true/second',
      ),
    ).toBeUndefined();
  });

  it('keeps every privacy veto for paired JSON without allowing HTML or an encoded body', () => {
    expect(
      staticPageDataHeadersAllowSharing([['content-type', 'application/json; charset=utf-8']]),
    ).toBe(true);

    for (const pair of [
      ['content-type', 'text/html'],
      ['content-encoding', 'gzip'],
      ['cache-control', 'private'],
      ['set-cookie', 's=1'],
      ['vary', 'cookie'],
      ['content-disposition', 'attachment'],
    ] as [string, string][]) {
      expect(staticPageDataHeadersAllowSharing([pair])).toBe(false);
    }
  });
});
