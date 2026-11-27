import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256HexOfText } from '../src/artifact/hash.ts';
import {
  buildProjectManifest,
  computeManifestId,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import {
  type DynamicRoute,
  READ_MANIFEST_SCHEMA_VERSIONS,
  type RouteEntry,
} from '../src/manifest/schema.ts';
import { fromStoredManifest } from '../src/manifest/stored.ts';

/**
 * A manifest as it is stored: each value its routes repeat — their headers, the conditions Next.js
 * would not serve their prerender under, the resources their heads name — held once, in `tables`,
 * and named by its place there. Read, it is the manifest it was built as.
 */

const OBSERVED_AT = '2026-10-08T00:00:00.000Z';
const APP = { deploymentId: 'dpl_1', scriptName: 'app-1' };
const POLICY = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'sha256-abc'",
  'x-frame-options': 'DENY',
  link: '</_next/static/css/a.css>; rel=preload; as=style',
};
const BYPASS = [{ type: 'header' as const, key: 'next-action' }];
const PRELOADS = ['</_next/static/media/font.woff2>; rel=preload; as=font; crossorigin'];

function route(pathname: string, fields: Partial<RouteEntry> = {}): RouteEntry {
  return {
    pathname,
    status: 200,
    shell: {
      sha256: pathname.length.toString(16).padStart(64, '0'),
      byteLength: 1234,
      contentType: 'text/html; charset=utf-8',
      encoding: 'identity',
    },
    headers: POLICY,
    bypassFor: BYPASS,
    ...fields,
  };
}

/** A class with no shell, whose members carry the class's conditions (`MemberRoute`). */
const CLASS: DynamicRoute = {
  sourceRegex: '^/blog/(?<slug>[^/]+?)(?:/)?$',
  members: { route: '/blog/[slug]', kind: 'app-page', bypassFor: BYPASS },
};

function build(routes: readonly RouteEntry[], dynamicRoutes?: readonly DynamicRoute[]) {
  return buildProjectManifest({
    projectId: 'site1',
    runId: 'run1',
    generatedAt: OBSERVED_AT,
    originHost: 'example.com',
    deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
    routes,
    app: APP,
    ...(dynamicRoutes !== undefined && { dynamicRoutes }),
  });
}

/** A page under the layout: its policy, and the font the layout preloads. */
function page(index: number): RouteEntry {
  return route(`/docs/page-${String(index)}`, { preloads: PRELOADS });
}

/** Many pages under one layout, and one that answers with a policy of its own and preloads nothing. */
const SITE = build(
  [
    ...Array.from({ length: 50 }, (_, index) => page(index)),
    route('/admin', { headers: { ...POLICY, 'x-frame-options': 'SAMEORIGIN' } }),
  ],
  [CLASS],
);

/** Whether a manifest of the site, written route by route at `version`, is read at all. */
function readsAt(version: number): boolean {
  try {
    parseProjectManifest(canonicalJson({ ...SITE, schemaVersion: version }));
    return true;
  } catch {
    return false;
  }
}

describe('a stored manifest', () => {
  it('reads as the manifest it was built as', () => {
    expect(parseProjectManifest(serializeManifest(SITE))).toStrictEqual(SITE);
  });

  it('holds each repeated value once, and names it by its place', () => {
    const stored = JSON.parse(serializeManifest(SITE)) as {
      readonly tables: Record<string, readonly unknown[]>;
      readonly routes: Record<string, Record<string, unknown>>;
      readonly dynamicRoutes: readonly { readonly members: Record<string, unknown> }[];
    };

    expect(stored.tables['headers']).toHaveLength(2);
    expect(stored.tables['conditions']).toHaveLength(1);
    expect(stored.tables['preloads']).toHaveLength(1);
    // Placed in the order the routes are listed in: `/admin` before `/docs/…`.
    expect(stored.routes['/docs/page-7']).toMatchObject({ headers: 1, bypassFor: 0, preloads: 0 });
    expect(stored.routes['/admin']?.['headers']).toBe(0);
    expect(stored.routes['/admin']?.['preloads']).toBeUndefined();
    // A class's members name the conditions their routes name, from the same table.
    expect(stored.dynamicRoutes[0]?.members['bypassFor']).toBe(0);
  });

  /** What the tables are for: a manifest a fraction of the size, for the same routes. */
  it('comes to a fraction of the manifest written out route by route', () => {
    const stored = serializeManifest(SITE).length;
    const inline = canonicalJson(SITE).length;

    expect(stored).toBeLessThan(inline * 0.6);
  });

  /**
   * One value, one object: what every route sharing it is handed where nothing copies it after —
   * the edge's own reading, which takes a digest for the schema (`vouchedManifest`).
   */
  it('hands every route sharing a value the one object', () => {
    const read = fromStoredManifest(JSON.parse(serializeManifest(SITE))) as typeof SITE;

    expect(read.routes['/docs/page-1']?.headers).toBe(read.routes['/docs/page-2']?.headers);
    expect(read.routes['/docs/page-1']?.bypassFor).toBe(
      read.dynamicRoutes?.[0]?.members?.bypassFor,
    );
  });

  /** The id names the stored bytes, which is what the edge checks a copy against. */
  it('is named by the digest of its stored bytes', async () => {
    await expect(computeManifestId(SITE)).resolves.toBe(
      await sha256HexOfText(serializeManifest(SITE)),
    );
  });

  /**
   * Every manifest published before the tables writes its values out route by route, and is read
   * as it is: at each version a reader reads — its own, and every one a manifest still serving was
   * published at, back to the 3 a deployment made before 2026-10-04 still serves. Spelled out
   * rather than taken from `READ_MANIFEST_SCHEMA_VERSIONS`, so that a version dropped from that
   * list fails here instead of taking its case with it (greptile).
   */
  it.each([3, 4, 5, 6, 7, 8])(
    'reads a manifest of version %i written route by route',
    (version) => {
      const written = canonicalJson({ ...SITE, schemaVersion: version });

      expect(parseProjectManifest(written)).toStrictEqual({ ...SITE, schemaVersion: version });
    },
  );

  /**
   * And no other. Version 5 means a header's `$` references filled in one pass
   * (`routerReferences`): a reader that does not know a version refuses it rather than fill those
   * headers in turn. The versions are ones no reader reads — before the earliest still served, and
   * after the latest — named outright so that the case cannot become empty (greptile).
   */
  it.each([1, 2, 10])('refuses version %i, which it does not read', (version) => {
    expect(READ_MANIFEST_SCHEMA_VERSIONS).not.toContain(version);
    expect(readsAt(version)).toBe(false);
  });

  /**
   * Its places are given in the order the stored JSON lists the routes, so it stores the same bytes
   * however its routes were inserted, and again once it is read back: its id is a fact about what
   * it says, as it was before the tables.
   */
  it('is named the same once read back, and whatever order its routes were added in', async () => {
    const id = await computeManifestId(SITE);
    const reversed = build(Object.values(SITE.routes).toReversed(), [CLASS]);

    const readBack = parseProjectManifest(serializeManifest(SITE));

    await expect(computeManifestId(readBack)).resolves.toBe(id);
    await expect(computeManifestId(reversed)).resolves.toBe(id);
  });

  /** A class whose members are left no conditions carries none (`memberRoutesOf`). */
  it('stores a class whose members carry no conditions as it is', () => {
    const plain: DynamicRoute = { ...CLASS, members: { route: '/blog/[slug]', kind: 'app-page' } };
    const site = build([route('/docs')], [plain]);

    expect(parseProjectManifest(serializeManifest(site))).toStrictEqual(site);
  });

  /**
   * A manifest of an earlier version — one read back from storage, say — is stored route by route,
   * as it was written: it keeps its bytes and its id, and a reader of its version reads it.
   */
  it('stores a manifest of an earlier version route by route', async () => {
    const written = canonicalJson({ ...SITE, schemaVersion: 4 });
    const earlier = parseProjectManifest(written);

    expect(serializeManifest(earlier)).toBe(written);
    await expect(computeManifestId(earlier)).resolves.toBe(await sha256HexOfText(written));
  });

  /**
   * No writer of a version before the tables wrote one: a `tables` beside such a manifest names
   * nothing, and its routes are read as they are.
   */
  it('reads the routes of an earlier version as they are, whatever it carries beside them', () => {
    const earlier = { ...SITE, schemaVersion: 4 as const };
    const written = canonicalJson({ ...earlier, tables: { headers: [{ 'x-other': '1' }] } });

    expect(parseProjectManifest(written)).toStrictEqual(earlier);
  });

  /** A route naming a place its table does not hold is no manifest a writer wrote. */
  it('refuses a route that names a place its table does not hold', () => {
    const stored = JSON.parse(serializeManifest(SITE)) as {
      routes: Record<string, Record<string, unknown>>;
    };
    stored.routes['/admin'] = { ...stored.routes['/admin'], headers: 9 };

    expect(() => fromStoredManifest(stored)).toThrow(/headers 9/u);
  });
});
