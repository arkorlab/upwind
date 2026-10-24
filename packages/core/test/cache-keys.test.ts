import { describe, expect, it } from 'vitest';

import {
  appPathFor,
  cacheKeyDigestOf,
  canonicalEntryMaterial,
  deriveEntry,
  entryIdFor,
  implicitTagsFor,
  kvDataKey,
  kvGenerationKey,
  kvScopeKey,
  parseCacheTagsHeader,
  r2BlobKey,
  r2EventPayloadKey,
  r2RecordKey,
  r2RecordPrefix,
  tagKindOf,
} from '../src/cache/keys.ts';
import { compareCodeUnits } from '../src/util/bytes.ts';
import { isId } from '../src/util/id.ts';

const SCOPE = 'dpl_4Fixture2Minima1AppXy';
const OTHER_SCOPE = 'dpl_3Qk9mWpZ2rT7bX1vN8sLd';
const SHA = 'a'.repeat(64);
const SEVEN = 7;
const TEN = 10;
const HUNDRED = 100;

describe('entry keys', () => {
  it('are taken over versioned material with the pathname as Next.js keys it', () => {
    expect(
      canonicalEntryMaterial({ kind: 'app-page', route: '/blog/[slug]', pathname: '/blog/first/' }),
    ).toBe(
      '{"keySchemaVersion":1,"kind":"app-page","pathname":"/blog/first","route":"/blog/[slug]"}',
    );
    expect(canonicalEntryMaterial({ kind: 'app-page', route: '/', pathname: '/' })).toContain(
      '"pathname":"/"',
    );
  });

  it('give the same digest to the same descriptor and different ones to different material', async () => {
    const first = await cacheKeyDigestOf({
      kind: 'app-page',
      route: '/blog/[slug]',
      pathname: '/blog/first',
    });
    const again = await cacheKeyDigestOf({
      kind: 'app-page',
      pathname: '/blog/first',
      route: '/blog/[slug]',
    });
    const other = await cacheKeyDigestOf({
      kind: 'app-page',
      route: '/blog/[slug]',
      pathname: '/blog/second',
    });
    const route = await cacheKeyDigestOf({
      kind: 'app-route',
      route: '/blog/[slug]',
      pathname: '/blog/first',
    });

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(route).not.toBe(first);
  });

  it('never cross a scope, even for the same digest', async () => {
    const digest = await cacheKeyDigestOf({ kind: 'app-page', route: '/', pathname: '/' });
    const mine = await entryIdFor(SCOPE, 'app-page', digest);
    const theirs = await entryIdFor(OTHER_SCOPE, 'app-page', digest);

    expect(isId('ent', mine)).toBe(true);
    expect(theirs).not.toBe(mine);
    await expect(entryIdFor(SCOPE, 'app-page', digest)).resolves.toBe(mine);
  });

  it('describe a route entry without header or query values', async () => {
    const derived = await deriveEntry(
      SCOPE,
      { kind: 'pages', route: '/legacy/[slug]', pathname: '/legacy/one' },
      ['slug'],
    );

    expect(derived.keyDescriptor).toStrictEqual({
      kind: 'pages',
      route: '/legacy/[slug]',
      pathname: '/legacy/one',
      allowQuery: ['slug'],
    });
    expect(derived.cacheKeyDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('describe a data entry by kind and handler, never by its key', async () => {
    const key = 'https://api.example.test/secret?token=hunter2';
    const derived = await deriveEntry(SCOPE, { kind: 'data:use-cache', handler: 'remote', key });
    const digest = await cacheKeyDigestOf({ kind: 'data:use-cache', handler: 'remote', key });

    expect(derived.keyDescriptor).toStrictEqual({ kind: 'data:use-cache', handler: 'remote' });
    expect(JSON.stringify(derived)).not.toContain('hunter2');
    expect(derived.cacheKeyDigest).toBe(digest);
  });
});

describe('tags', () => {
  it('derives the tags Next.js does for a page', () => {
    expect(implicitTagsFor('/blog/[slug]/page', '/blog/first')).toStrictEqual([
      '_N_T_/layout',
      '_N_T_/blog/layout',
      '_N_T_/blog/[slug]/layout',
      '_N_T_/blog/[slug]/page',
      '_N_T_/blog/first',
    ]);
    // The root gets its `/index` twin, and a class shell (unresolved params) gets no pathname tag.
    expect(implicitTagsFor('/page', '/')).toStrictEqual([
      '_N_T_/layout',
      '_N_T_/page',
      '_N_T_/',
      '_N_T_/index',
    ]);
    expect(implicitTagsFor('/blog/[slug]/page')).not.toContain('_N_T_/blog/[slug]');
  });

  it('starts from the app path Next.js keeps for a route, which a Pages route does not have', () => {
    expect(appPathFor('app-page', '/blog/[slug]')).toBe('/blog/[slug]/page');
    expect(appPathFor('app-page', '/')).toBe('/page');
    expect(appPathFor('app-route', '/api/feed')).toBe('/api/feed/route');
    expect(appPathFor('pages', '/legacy/[slug]')).toBe('/legacy/[slug]');
    expect(implicitTagsFor(appPathFor('app-page', '/'), '/')).toContain('_N_T_/index');
  });

  it('reads a cache tags header in order, once each', () => {
    expect(parseCacheTagsHeader('posts, _N_T_/layout,,posts , post:1')).toStrictEqual([
      'posts',
      '_N_T_/layout',
      'post:1',
    ]);
    expect(parseCacheTagsHeader(undefined)).toStrictEqual([]);
  });

  it('tells an explicit tag from one Next.js derived', () => {
    expect(tagKindOf('posts')).toBe('next-explicit');
    expect(tagKindOf('_N_T_/blog/layout')).toBe('next-implicit');
  });
});

describe('storage keys', () => {
  it('name what the edge, the gateway and the index each read', () => {
    expect(kvGenerationKey(SCOPE, 'ent_1')).toBe(`gen:${SCOPE}:ent_1`);
    expect(kvDataKey(SCOPE, SHA)).toBe(`data:${SCOPE}:${SHA}`);
    expect(kvScopeKey(SCOPE)).toBe(`scope:${SCOPE}`);
    expect(r2BlobKey(SCOPE, SHA)).toBe(`cache/${SCOPE}/blobs/${SHA}`);
    expect(r2RecordPrefix(SCOPE)).toBe(`cache/${SCOPE}/records/`);
    expect(r2RecordKey(SCOPE, SEVEN)).toBe(`cache/${SCOPE}/records/000000000007.json`);
    expect(r2EventPayloadKey(SCOPE, 'evt_1')).toBe(`cache/${SCOPE}/events/evt_1.json`);
  });

  it('orders records by revision when listed by name', () => {
    const listed = [1, TEN, 2, HUNDRED]
      .map((revision) => r2RecordKey(SCOPE, revision))
      .toSorted(compareCodeUnits);

    expect(listed).toStrictEqual(
      [1, 2, TEN, HUNDRED].map((revision) => r2RecordKey(SCOPE, revision)),
    );
  });
});
