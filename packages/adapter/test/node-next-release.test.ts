import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isReviewedFrameworkSource } from '../src/node-manifest-framework.ts';
import {
  isForeignReleaseSource,
  isReleaseSource,
  NATIVE_NEXT_RELEASES,
  nativeNextReleaseAt,
  nativeNextReleaseOf,
} from '../src/node-next-release.ts';

const require = createRequire(import.meta.url);
/** Each supported release, installed: 16.4.3 to 16.4.5 under their aliases, 16.4.6 as the catalog's. */
const INSTALLED = [
  { version: '16.4.3', root: path.dirname(require.resolve('next-16-4-3/package.json')) },
  { version: '16.4.4', root: path.dirname(require.resolve('next-16-4-4/package.json')) },
  { version: '16.4.5', root: path.dirname(require.resolve('next-16-4-5/package.json')) },
  { version: '16.4.6', root: path.dirname(require.resolve('next/package.json')) },
] as const;
/** Reviewed sources the two releases publish with the same bytes. */
const SHARED = [
  'dist/server/route-modules/app-page/module.compiled.js',
  'dist/server/route-modules/app-page/module.js',
  'dist/server/route-modules/app-route/module.compiled.js',
  'dist/server/route-modules/app-route/module.js',
  'dist/server/load-components.js',
  'dist/server/route-modules/pages-api/module.compiled.js',
  'dist/server/route-modules/pages-api/module.js',
  'dist/server/route-modules/pages/module.compiled.js',
  'dist/server/route-modules/pages/module.js',
  'dist/server/route-modules/route-module.js',
];

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('the Next.js releases the native Node path qualifies', () => {
  it.each(INSTALLED)(
    'pins $version to its installed package, byte for byte',
    ({ version, root }) => {
      const release = NATIVE_NEXT_RELEASES.find((candidate) => candidate.version === version);
      const sources = [...(release?.sources ?? [])].map(([relative, expected]) => {
        return {
          relative,
          expected,
          actual: sha256(path.join(root, relative)),
        };
      });
      const shared = SHARED.filter((relative) => {
        const actual = sha256(path.join(root, relative));
        return !isReviewedFrameworkSource(relative, actual);
      });

      expect(release?.packageJsonSha256).toBe(sha256(path.join(root, 'package.json')));
      expect(nativeNextReleaseAt(root)).toBe(release);
      expect(sources).toHaveLength(13);
      expect(sources.filter(({ expected, actual }) => expected !== actual)).toStrictEqual([]);
      expect(shared).toStrictEqual([]);
    },
  );

  it('holds a release to its own bytes and refuses another release’s', () => {
    const [older, newer] = NATIVE_NEXT_RELEASES;
    const runtime = 'dist/compiled/next-server/pages-turbo.runtime.prod.js';
    const olderRuntime = older?.source(runtime) ?? '';

    expect(newer?.source(runtime)).not.toBe(olderRuntime);
    expect(isReleaseSource(runtime, olderRuntime)).toBe(true);
    expect(isForeignReleaseSource(older!, runtime, olderRuntime)).toBe(false);
    expect(isForeignReleaseSource(newer!, runtime, olderRuntime)).toBe(true);
    expect(isForeignReleaseSource(newer!, runtime, 'f'.repeat(64))).toBe(false);
  });

  it('takes a source two releases publish alike as either one’s own', () => {
    const [, previous, latest] = NATIVE_NEXT_RELEASES;
    const pages = 'dist/compiled/next-server/pages-turbo.runtime.prod.js';
    const appPage = 'dist/compiled/next-server/app-page-turbo.runtime.prod.js';

    // 16.4.5 publishes the Pages runtimes as 16.4.4 does, and the App Router ones anew.
    expect(latest?.source(pages)).toBe(previous?.source(pages));
    expect(isForeignReleaseSource(latest!, pages, previous?.source(pages) ?? '')).toBe(false);
    expect(latest?.source(appPage)).not.toBe(previous?.source(appPage));
    expect(isForeignReleaseSource(latest!, appPage, previous?.source(appPage) ?? '')).toBe(true);
    expect(nativeNextReleaseOf(latest!.packageJsonSha256, '16.4.5')).toBe(latest);
    expect(nativeNextReleaseOf(previous!.packageJsonSha256, '16.4.5')).toBeUndefined();
  });

  it('takes the sources 16.4.6 publishes as 16.4.5 does as either one’s own', () => {
    const previous = NATIVE_NEXT_RELEASES.at(-2);
    const latest = NATIVE_NEXT_RELEASES.at(-1);
    const template = 'dist/build/templates/app-page-runtime.js';
    const pages = 'dist/compiled/next-server/pages.runtime.prod.js';
    const appRoute = 'dist/compiled/next-server/app-route.runtime.prod.js';

    // 16.4.6 publishes the page template and the Pages runtimes as 16.4.5 does, and the App
    // Router ones anew: its header change reaches only those.
    expect([previous?.version, latest?.version]).toStrictEqual(['16.4.5', '16.4.6']);

    for (const shared of [template, pages]) {
      expect(latest?.source(shared)).toBe(previous?.source(shared));
      expect(isForeignReleaseSource(latest!, shared, previous?.source(shared) ?? '')).toBe(false);
    }

    expect(latest?.source(appRoute)).not.toBe(previous?.source(appRoute));
    expect(isForeignReleaseSource(latest!, appRoute, previous?.source(appRoute) ?? '')).toBe(true);
    expect(nativeNextReleaseOf(latest!.packageJsonSha256, '16.4.6')).toBe(latest);
    expect(nativeNextReleaseOf(previous!.packageJsonSha256, '16.4.6')).toBeUndefined();
  });

  it('keeps every release pin immutable to the code that imports it', () => {
    const [older] = NATIVE_NEXT_RELEASES;
    const runtime = 'dist/compiled/next-server/pages-turbo.runtime.prod.js';
    const pinned = older?.source(runtime);
    const pairs = older?.sources ?? [];

    expect(Object.isFrozen(NATIVE_NEXT_RELEASES)).toBe(true);
    expect(NATIVE_NEXT_RELEASES.every((release) => Object.isFrozen(release))).toBe(true);
    expect(Object.isFrozen(pairs)).toBe(true);
    expect(pairs.every((pair) => Object.isFrozen(pair))).toBe(true);
    expect(() => {
      (pairs.find(([relative]) => relative === runtime) as [string, string])[1] = 'f'.repeat(64);
    }).toThrow(TypeError);
    expect(older?.source(runtime)).toBe(pinned);
  });

  it('names a release by its exact package bytes and version together', () => {
    const [older, newer] = NATIVE_NEXT_RELEASES;

    expect(nativeNextReleaseOf(older!.packageJsonSha256, '16.4.3')).toBe(older);
    expect(nativeNextReleaseOf(newer!.packageJsonSha256, '16.4.4')).toBe(newer);
    expect(nativeNextReleaseOf(older!.packageJsonSha256, '16.4.4')).toBeUndefined();
    expect(nativeNextReleaseOf('f'.repeat(64), '16.4.3')).toBeUndefined();
    expect(nativeNextReleaseAt('/no/such/next')).toBeUndefined();
  });
});
