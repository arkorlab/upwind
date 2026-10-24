import { standsForClass } from '@stayingupwind/core/bundle';
import { describe, expect, it } from 'vitest';

import { isClassShell } from '../src/store.ts';

/**
 * Which prerender stands for a class of its route's URLs. A value of a parameter may
 * hold brackets — `getStaticPaths` and `generateStaticParams` may name a page `/blog/[post3]` — and
 * read as a placeholder it was served for every post of the route. Only a segment spelled as the
 * route's own parameter at the same place is one; Next.js 16.3 says so outright (`routeType`).
 */

const POST = '/blog/[post]';

describe('a prerender that stands for its class', () => {
  it('is the route’s own template', () => {
    expect(standsForClass({ pathname: POST, route: POST })).toBe(true);
    expect(isClassShell(POST, POST)).toBe(true);
  });

  it('is not a page whose value holds brackets', () => {
    expect(standsForClass({ pathname: '/blog/[post3]', route: POST })).toBe(false);
    expect(isClassShell('/blog/[post3]', POST)).toBe(false);
  });

  it('is not a page whose value is spelled as another of the route’s parameters', () => {
    const route = '/[category]/[slug]';

    expect(standsForClass({ pathname: '/news/[category]', route })).toBe(false);
    expect(isClassShell('/news/[category]', route)).toBe(false);
  });

  /** A locale's pathname leads with a segment its route does not have. */
  it('is a locale’s template, read from the end', () => {
    expect(standsForClass({ pathname: '/en/blog/[post]', route: POST })).toBe(true);
  });

  it('is what the build says it is, where the build says', () => {
    expect(standsForClass({ pathname: '/blog/x', route: POST, routeType: 'fallback' })).toBe(true);
    expect(standsForClass({ pathname: '/blog/x', route: POST, routeType: 'shell' })).toBe(true);
  });

  /**
   * Next.js 16.3 calls a blocking route's own entry a `page` (`response: 'empty'`,
   * `compute: 'blocking'`): it is still the class its members are rendered from.
   */
  it('is a blocking route’s own entry, which Next.js 16.3 calls a page', () => {
    const entry = { pathname: POST, route: POST, routeType: 'page' as const };

    expect(standsForClass(entry)).toBe(true);
  });

  /** A member a dynamic route prerendered names that route's fallback; the route's entry does not. */
  it('is not a member, which names its route’s fallback, however it is spelled', () => {
    const member = { pathname: POST, route: POST, routeType: 'page' as const };

    expect(standsForClass({ ...member, parentFallbackMode: null })).toBe(false);
    expect(standsForClass({ ...member, parentFallbackMode: false })).toBe(false);
    expect(standsForClass({ pathname: POST, route: POST, parentFallbackMode: null })).toBe(false);
  });
});
