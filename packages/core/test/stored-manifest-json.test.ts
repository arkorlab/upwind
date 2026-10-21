import { describe, expect, it } from 'vitest';

import { parseStoredManifest as publicReader } from '../src/manifest/index.ts';
import { parseProjectManifest, serializeManifest } from '../src/manifest/manifest.ts';
import { projectManifestSchema, READ_MANIFEST_SCHEMA_VERSIONS } from '../src/manifest/schema.ts';
import {
  fromStoredManifest,
  parseStoredManifest,
  toStoredManifest,
} from '../src/manifest/stored.ts';
import {
  baseline,
  capturedRead,
  compactGraph,
  freezeGraph,
  outcome,
  publishedManifest,
  type CompactGraph,
  type RouteGraph,
} from './stored-manifest-fixtures.ts';

const IMAGES = {
  path: '/_next/image',
  basePath: '',
  sizes: [64],
  formats: [],
  minimumCacheTTL: 60,
  maximumRedirects: 3,
  maximumResponseBody: 1024,
  remotePatterns: [],
  domains: [],
  localPatterns: [],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

describe('JSON-owned stored manifest restoration', () => {
  it('exports the raw reader without replacing the validated parser', () => {
    expect(publicReader).toBe(parseStoredManifest);
    expect(
      projectManifestSchema.parse(publicReader(serializeManifest(publishedManifest()))),
    ).toStrictEqual(parseProjectManifest(serializeManifest(publishedManifest())));
  });

  it.each(READ_MANIFEST_SCHEMA_VERSIONS)(
    'keeps stored and inline version %s graphs',
    (schemaVersion) => {
      const manifest = projectManifestSchema.parse({ ...publishedManifest(), schemaVersion });
      const stored = serializeManifest(manifest);
      const inline = JSON.stringify(manifest);

      expect(parseStoredManifest(stored)).toStrictEqual(baseline(stored));
      expect(parseStoredManifest(inline)).toStrictEqual(baseline(inline));
      expect(projectManifestSchema.parse(parseStoredManifest(stored))).toStrictEqual(
        parseProjectManifest(stored),
      );
      expect(serializeManifest(projectManifestSchema.parse(parseStoredManifest(stored)))).toBe(
        stored,
      );
    },
  );

  it.each([3, 4, 5, 6, 6.5, 8, 9])(
    'does not replace raw version rules at %s with admission',
    (schemaVersion) => {
      const json = JSON.stringify({ ...compactGraph(), schemaVersion });

      expect(parseStoredManifest(json)).toStrictEqual(baseline(json));
      expect(outcome(parseProjectManifest, json)).toHaveProperty('error');
    },
  );

  it('does not admit an unsupported version of otherwise valid stored data', () => {
    const schemaVersion = Math.max(...READ_MANIFEST_SCHEMA_VERSIONS) + 1;
    const json = JSON.stringify({ ...toStoredManifest(publishedManifest()), schemaVersion });

    expect(parseStoredManifest(json)).toStrictEqual(baseline(json));
    expect(projectManifestSchema.safeParse(parseStoredManifest(json)).success).toBe(false);
    expect(outcome(parseProjectManifest, json)).toHaveProperty('error');
  });

  it.each([
    'null',
    'false',
    '0',
    '"text"',
    '[]',
    '{}',
    '{"schemaVersion":6,"tables":{}}',
    '{"schemaVersion":6,"tables":{},"routes":null}',
    '{"schemaVersion":6,"tables":[],"routes":{}}',
    '{"schemaVersion":6,"tables":null,"routes":{}}',
    '{"schemaVersion":6,"tables":{"headers":[{}]},"routes":{"/a":{"headers":0}},"dynamicRoutes":[{"members":{}}]}',
  ])('retains unknown/nonrecord and absent-table behavior: %s', (json) => {
    expect(outcome(parseStoredManifest, json)).toStrictEqual(outcome(baseline, json));
  });

  it('preserves the compact missing-routes own undefined property', () => {
    const restored = parseStoredManifest('{"schemaVersion":6,"tables":{}}');

    expect(restored).toStrictEqual({ schemaVersion: 6, routes: undefined });
    expect(Object.hasOwn(restored as Record<string, unknown>, 'routes')).toBe(true);
  });

  it('parses once and reuses only the newly parsed route and member containers', () => {
    const read = capturedRead(JSON.stringify(compactGraph()));
    const parsed = read.parsed as CompactGraph;
    const restored = read.value as RouteGraph;

    expect(read.argumentCounts).toStrictEqual([1]);
    expect(restored).not.toBe(parsed);
    expect(restored.routes).toBe(parsed.routes);
    expect(restored.routes['/first']).toBe(parsed.routes['/first']);
    expect(restored.dynamicRoutes).toBe(parsed.dynamicRoutes);
    expect(restored.dynamicRoutes[0]?.members).toBe(parsed.dynamicRoutes[0]?.members);
    expect(Object.hasOwn(restored, 'tables')).toBe(false);
    expect(Object.hasOwn(parsed, 'tables')).toBe(true);
  });

  it('shares exact table indices without merging equal values or separate routes', () => {
    const read = capturedRead(JSON.stringify(compactGraph()));
    const parsed = read.parsed as CompactGraph;
    const restored = read.value as RouteGraph;

    expect(restored.routes['/first']?.headers).toBe(parsed.tables.headers[0]);
    expect(restored.routes['/first']?.headers).toBe(restored.routes['/second']?.headers);
    expect(restored.routes['/first']?.headers).not.toBe(restored.routes['/equal']?.headers);
    expect(restored.routes['/first']?.bypassFor).toBe(
      restored.dynamicRoutes[0]?.members?.bypassFor,
    );
    expect(restored.routes['/first']?.preloads).toBe(parsed.tables.preloads[0]);
    expect(restored.routes['/first']).not.toBe(restored.routes['/second']);
    expect(restored.dynamicRoutes[0]?.members).not.toBe(restored.dynamicRoutes[1]?.members);
  });

  it('retains the generic parsed-input nonmutation and shared-table contract', () => {
    const input = compactGraph();
    const before = JSON.stringify(input);
    freezeGraph(input);
    const restored = fromStoredManifest(input) as RouteGraph;

    expect(JSON.stringify(input)).toBe(before);
    expect(restored.routes).not.toBe(input.routes);
    expect(restored.routes['/first']).not.toBe(input.routes['/first']);
    expect(restored.dynamicRoutes).not.toBe(input.dynamicRoutes);
    expect(restored.dynamicRoutes[0]?.members).not.toBe(input.dynamicRoutes[0]?.members);
    expect(restored.routes['/first']?.headers).toBe(input.tables.headers[0]);
  });

  it('retains generic earlier-version, nonrecord and null-prototype behavior', () => {
    const legacy = { ...compactGraph(), schemaVersion: 5 };
    const record = Object.assign(Object.create(null) as Record<string, unknown>, compactGraph());
    const restored = fromStoredManifest(record) as RouteGraph;

    expect(fromStoredManifest(legacy)).toBe(legacy);
    expect(fromStoredManifest(null)).toBeNull();
    expect(record['routes']).toStrictEqual(compactGraph().routes);
    expect(restored.routes['/first']?.headers).toStrictEqual({ 'x-policy': 'shared' });
    expect(Object.getPrototypeOf(record)).toBeNull();
  });

  it.each([
    { routes: { '/a': null, '/b': [], '/c': 7 }, dynamicRoutes: [null, [], 7, { members: null }] },
    { routes: [], dynamicRoutes: null },
    { routes: { '/a': { headers: 0 } }, dynamicRoutes: [{ members: {} }] },
    { routes: { '/a': { headers: 0 } }, dynamicRoutes: [{ members: { bypassFor: 0 } }] },
  ])('keeps optional fields and nonrecord entries without adding validation: %j', (fields) => {
    const json = JSON.stringify({ ...compactGraph(), ...fields });

    expect(outcome(parseStoredManifest, json)).toStrictEqual(outcome(baseline, json));
  });
});

describe('the raw reader retains table refusals before schema validation', () => {
  it.each(['headers', 'bypassFor', 'preloads'])(
    'retains invalid %s indices and their exact refusal',
    (field) => {
      for (const index of [null, false, '0', {}, [], -1, 0.5, 2, Number.MAX_SAFE_INTEGER + 1]) {
        const json = JSON.stringify({
          ...compactGraph(),
          routes: { '/a': { headers: 0, [field]: index } },
        });

        expect(outcome(parseStoredManifest, json)).toStrictEqual(outcome(baseline, json));
        expect(outcome(parseStoredManifest, json)).toHaveProperty('error');
      }
    },
  );

  it.each([
    '{"schemaVersion":6,"tables":{"headers":[{}]},"routes":{"/a":{}}}',
    '{"schemaVersion":6,"tables":{},"routes":{"/a":{"headers":0}}}',
    '{"schemaVersion":6,"tables":{"headers":null},"routes":{"/a":{"headers":0}}}',
    '{"schemaVersion":6,"tables":{"headers":{}},"routes":{"/a":{"headers":0}}}',
    '{"schemaVersion":6,"tables":{"headers":[{}]},"routes":{"/a":{"headers":0,"bypassFor":0}}}',
    '{"schemaVersion":6,"tables":{"headers":[{}]},"routes":{"/a":{"headers":0,"preloads":0}}}',
    '{"schemaVersion":6,"tables":{"headers":[{}]},"routes":{"/a":{"headers":1e400}}}',
    '{"schemaVersion":6,"tables":{"headers":[{}]},"routes":{"/a":{"headers":0}},"dynamicRoutes":[{"members":{"bypassFor":0}}]}',
  ])('keeps missing tables and numeric boundaries as failures: %s', (json) => {
    expect(outcome(parseStoredManifest, json)).toStrictEqual(outcome(baseline, json));
    expect(outcome(parseStoredManifest, json)).toHaveProperty('error');
  });

  it('accepts the same negative-zero table index', () => {
    const json = '{"schemaVersion":6,"tables":{"headers":[{}]},"routes":{"/a":{"headers":-0}}}';

    expect(parseStoredManifest(json)).toStrictEqual(baseline(json));
    expect(parseStoredManifest(json)).toHaveProperty(['routes', '/a', 'headers'], {});
  });

  it('does not validate a table element that the generic reader leaves to the schema', () => {
    const json = JSON.stringify({
      ...compactGraph(),
      tables: { headers: [null, 4] },
      routes: { '/a': { headers: 0 }, '/b': { headers: 1 } },
      dynamicRoutes: [],
    });

    expect(outcome(parseStoredManifest, json)).toStrictEqual(outcome(baseline, json));
    expect(parseStoredManifest(json)).toHaveProperty(['routes', '/a', 'headers'], null);
    expect(parseStoredManifest(json)).toHaveProperty(['routes', '/b', 'headers'], 4);
  });

  it('retains the first refusal even after a previous route has been restored', () => {
    const json = JSON.stringify({
      ...compactGraph(),
      routes: { '/first': { headers: 0 }, '/bad': { headers: 8, bypassFor: -1 } },
      dynamicRoutes: [{ members: { bypassFor: -1 } }],
    });

    expect(outcome(parseStoredManifest, json)).toStrictEqual(outcome(baseline, json));
    expect(outcome(parseStoredManifest, json)).toStrictEqual({
      error: {
        name: 'Error',
        message: "a route names headers 8, which the manifest's table does not hold",
      },
    });
  });

  it.each(['', '{', '{"routes":}', '{"schemaVersion":6,}'])(
    'keeps native JSON errors: %s',
    (json) => {
      expect(outcome(parseStoredManifest, json)).toStrictEqual(outcome(baseline, json));
    },
  );

  it('leaves all image defaults to the existing full schema', () => {
    const json = JSON.stringify({
      ...toStoredManifest(publishedManifest()),
      images: IMAGES,
    });
    const raw = parseStoredManifest(json) as { images: Record<string, unknown> };
    const validated = projectManifestSchema.parse(raw);

    expect(Object.hasOwn(raw.images, 'dangerouslyAllowLocalIP')).toBe(false);
    expect(validated.images?.dangerouslyAllowLocalIP).toBe(false);
    expect(validated).toStrictEqual(parseProjectManifest(json));
  });

  it.each([true, false])('preserves an explicit image local-IP policy %s', (allowance) => {
    const json = JSON.stringify({
      ...toStoredManifest(publishedManifest()),
      images: { ...IMAGES, dangerouslyAllowLocalIP: allowance },
    });
    const validated = projectManifestSchema.parse(parseStoredManifest(json));

    expect(validated.images?.dangerouslyAllowLocalIP).toBe(allowance);
    expect(validated).toStrictEqual(parseProjectManifest(json));
  });

  it('does not turn a malformed image policy into a default', () => {
    const json = JSON.stringify({
      ...toStoredManifest(publishedManifest()),
      images: { ...IMAGES, dangerouslyAllowLocalIP: null },
    });
    const raw = parseStoredManifest(json) as { images: Record<string, unknown> };

    expect(raw.images['dangerouslyAllowLocalIP']).toBeNull();
    expect(projectManifestSchema.safeParse(raw).success).toBe(false);
    expect(outcome(parseProjectManifest, json)).toHaveProperty('error');
  });
});
