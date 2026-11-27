import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/artifact/hash.ts';
import { MAX_TAGS_PER_ENTRY } from '../src/cache/keys.ts';
import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import {
  COMPACT_TABLES_SCHEMA_VERSION,
  type RouteEntry,
  type RouteSegment,
} from '../src/manifest/schema.ts';
import { compactStoredManifest, fromStoredManifest } from '../src/manifest/stored.ts';

const STAMP = '2026-11-28T00:00:00.000Z';
const SHELL = {
  sha256: '1'.repeat(64),
  byteLength: 15,
  contentType: 'text/html',
  encoding: 'identity',
} as const;
const CACHE = { entryId: 'id', kind: 'app-page', delivery: 'complete' } as const;
const EXPLICIT = { kind: 'next-explicit', value: '同じ名前' } as const;
const IMPLICIT = { kind: 'next-implicit', value: EXPLICIT.value } as const;
const ARTIFACT = { ...SHELL, contentType: 'text/x-component' };
const ENCODING = { ...ARTIFACT, encoding: 'gzip', byteLength: 20, crc32: 12 } as const;
const SEGMENT: RouteSegment = { artifact: ARTIFACT, encodings: { gzip: ENCODING } };
const SEGMENT_ALT: RouteSegment = {
  artifact: ARTIFACT,
  encodings: { gzip: { ...ENCODING, crc32: 13 } },
};

function route(pathname: string, fields: Partial<RouteEntry> = {}): RouteEntry {
  return { pathname, status: 200, shell: SHELL, headers: {}, ...fields };
}

function site(routes: RouteEntry[]) {
  return buildProjectManifest({
    projectId: 'test',
    runId: 'run',
    generatedAt: STAMP,
    originHost: 'test.example',
    app: { deploymentId: 'deployment', scriptName: 'app' },
    deployment: { assetSetHash: 'assets', observedAt: STAMP },
    routes,
  });
}

const ROUTES = [
  route('/a', {
    cache: { ...CACHE, buildTags: [EXPLICIT, IMPLICIT, EXPLICIT] },
    segments: { '/z': SEGMENT_ALT, '/a': SEGMENT },
  }),
  route('/b', { cache: { ...CACHE, buildTags: [EXPLICIT] }, segments: { '/b': SEGMENT } }),
  route('/empty', { cache: { ...CACHE, buildTags: [] }, segments: {} }),
  route('/absent', { cache: CACHE }),
];

interface Wire {
  routes: Record<
    '/a' | '/b' | '/empty' | '/absent',
    { cache: { buildTags: unknown[] }; segments: Record<string, unknown> }
  >;
  tables: Record<string, unknown[]>;
}

/** Read a separate copy so testing a malformed reference leaves every other case alone. */
function stored(): Wire {
  const candidate = compactStoredManifest(site(ROUTES));
  return JSON.parse(canonicalJson(candidate)) as Wire;
}

describe('compact route tables', () => {
  it('interns matching full values and leaves distinct values inline', () => {
    const wire = stored();
    const a = wire.routes['/a'];

    expect(wire.tables['buildTags']).toStrictEqual([EXPLICIT]);
    expect(wire.tables['segments']).toStrictEqual([SEGMENT]);
    expect(a.cache.buildTags).toStrictEqual([0, IMPLICIT, 0]);
    expect(a.segments).toStrictEqual({ '/a': 0, '/z': SEGMENT_ALT });

    // The empty lists/maps stay inline; the fast edge reader reuses them as parsed.
    const expanded = fromStoredManifest(wire) as ReturnType<typeof site>;

    expect(expanded.routes['/empty']?.cache).toBe(wire.routes['/empty'].cache);
    expect(expanded.routes['/empty']?.segments).toBe(wire.routes['/empty'].segments);
  });

  it('round-trips the canonical bytes, preserves the baseline, and shares objects through both readers', () => {
    const baseline = site(ROUTES);
    const legacy = serializeManifest(baseline);
    const encoded = canonicalJson(compactStoredManifest(baseline));
    const wire = stored();

    expect(encoded.length).toBeLessThan(legacy.length);
    expect(serializeManifest(baseline)).toBe(legacy);

    const parsed = parseProjectManifest(encoded);

    expect(parsed).toStrictEqual({ ...baseline, schemaVersion: COMPACT_TABLES_SCHEMA_VERSION });
    expect(serializeManifest(parsed)).toBe(encoded);

    for (const decoded of [parsed, fromStoredManifest(wire) as typeof parsed]) {
      expect(decoded.routes['/a']?.cache?.buildTags?.[0]).toBe(
        decoded.routes['/b']?.cache?.buildTags?.[0],
      );
      expect(decoded.routes['/a']?.segments?.['/a']).toBe(decoded.routes['/b']?.segments?.['/b']);
    }
  });

  it('assigns places independently of route and segment map insertion order', () => {
    const a = (reverse: boolean) => {
      const segments = reverse
        ? { '/z': SEGMENT_ALT, '/a': SEGMENT }
        : { '/a': SEGMENT, '/z': SEGMENT_ALT };
      return route('/a', { segments });
    };
    const b = route('/b', { segments: { '/also-a': SEGMENT, '/also-z': SEGMENT_ALT } });
    const forward = compactStoredManifest(site([a(false), b]));
    const backward = compactStoredManifest(site([b, a(true)]));

    expect(canonicalJson(forward)).toBe(canonicalJson(backward));
  });

  it('chooses the two tables independently and retains the original version for all-unique values', () => {
    const segments = { '/a': SEGMENT };
    const cache = { ...CACHE, buildTags: [EXPLICIT] };
    const unique = site([route('/a', { segments, cache })]);

    expect(compactStoredManifest(unique)).toBeUndefined();

    const tagsOnly = compactStoredManifest(
      site([route('/a', { cache, segments }), route('/b', { cache })]),
    );
    const segmentsOnly = compactStoredManifest(
      site([route('/a', { cache, segments }), route('/b', { segments })]),
    );

    expect(tagsOnly?.['tables']).toHaveProperty('buildTags');
    expect(tagsOnly?.['tables']).not.toHaveProperty('segments');
    expect(segmentsOnly?.['tables']).toHaveProperty('segments');
    expect(segmentsOnly?.['tables']).not.toHaveProperty('buildTags');
  });

  it.each([-1, 0.5, 9, '0'])('rejects invalid indexes (%s)', (index) => {
    const wire = stored();
    const a = wire.routes['/a'];
    a.cache.buildTags[0] = index;

    expect(() => fromStoredManifest(wire)).toThrow(/buildTags/u);

    a.cache.buildTags[0] = 0;
    a.segments['/a'] = index;

    expect(() => fromStoredManifest(wire)).toThrow(/segments/u);
  });

  it('refuses dangling references, nested references and oversized tag lists', () => {
    const dangling = stored();
    delete dangling.tables['segments'];

    expect(() => fromStoredManifest(dangling)).toThrow(/segments/u);

    const nested = stored();
    nested.tables['buildTags'] = [0];

    expect(() => fromStoredManifest(nested)).toThrow(/buildTags/u);

    const large = stored();
    const a = large.routes['/a'];
    a.cache.buildTags = Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, () => 0);

    expect(() => fromStoredManifest(large)).toThrow(/buildTags/u);
  });
});
