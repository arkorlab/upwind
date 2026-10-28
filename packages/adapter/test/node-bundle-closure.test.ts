import { describe, expect, it } from 'vitest';

import {
  nodeRawSourceInventory,
  type NodeBundledImport,
  type NodeProofSource,
  type NodeSourceExports,
} from '../src/node-bundle-closure.ts';
import type { ManifestGraphEdge } from '../src/node-manifest-graph.ts';

const ROUTE = '/authored/route.cjs';
const PROJECT_HOOK = '/authored/.next/server/instrumentation.js';
const HOST = '/authored/generated-host.cjs';
const SHARED = '/authored/shared.cjs';
const RUNTIME = '\0rolldown/runtime.js';
const SHA256 = 'a'.repeat(64);

function graph() {
  return {
    sources: new Map<string, NodeProofSource>(),
    retained: new Set<string>(),
    rendered: new Map<string, string>(),
    imports: new Map<string, readonly ManifestGraphEdge[]>(),
    exports: new Map<string, NodeSourceExports>(),
  };
}

function add(
  own: ReturnType<typeof graph>,
  id: string,
  file: string,
  sha256 = SHA256,
): NodeProofSource {
  const source = { file, sha256 };
  own.sources.set(id, source);
  own.retained.add(id);
  own.rendered.set(id, 'module.exports={};');
  own.imports.set(id, []);
  own.exports.set(id, { format: 'cjs', declared: [], rendered: [] });
  return source;
}

function fixture() {
  const own = graph();
  add(own, 'route-id', ROUTE);
  add(own, 'project-hook-id', PROJECT_HOOK);
  const host = add(own, 'host-id', HOST);
  const loader = add(own, 'loader-id', '/authored/instrumentation-loader.cjs');
  add(own, 'shared-id', SHARED);
  add(own, 'host-only-id', '/authored/host-only.tsx');
  own.imports.set('route-id', [{ specifier: './loader', target: 'loader-id' }]);
  own.imports.set('loader-id', [{ specifier: './host', target: 'host-id' }]);
  own.imports.set('host-id', [
    { specifier: './shared', target: 'shared-id' },
    { specifier: './host-only', target: 'host-only-id' },
  ]);
  const bundledImports: readonly [NodeBundledImport] = [{ from: loader, to: host }];
  return { own, bundledImports };
}

function selected(
  own: ReturnType<typeof graph>,
  options: {
    readonly roots?: readonly string[];
    readonly nativeFiles?: ReadonlySet<string>;
    readonly bundledImports?: readonly NodeBundledImport[];
  } = {},
): readonly NodeProofSource[] {
  return nodeRawSourceInventory({
    graph: own,
    exports: own.exports,
    roots: options.roots ?? [ROUTE],
    nativeFiles: options.nativeFiles ?? new Set(),
    ...(options.bundledImports !== undefined && { bundledImports: options.bundledImports }),
  });
}

describe('original raw source closure from authored graph DATA', () => {
  it('walks raw route and project-hook roots using actual graph IDs', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    add(own, 'project-hook-id', PROJECT_HOOK);
    add(own, 'dependency-id', SHARED);
    own.imports.set('project-hook-id', [{ specifier: './shared', target: 'dependency-id' }]);

    expect(selected(own, { roots: [ROUTE, PROJECT_HOOK] })).toStrictEqual([
      { file: PROJECT_HOOK, sha256: SHA256 },
      { file: ROUTE, sha256: SHA256 },
      { file: SHARED, sha256: SHA256 },
    ]);
  });

  it('omits host-bundle-only source only across the exact directed boundary', () => {
    const { own, bundledImports } = fixture();

    expect(selected(own, { bundledImports }).map((source) => source.file)).toStrictEqual([
      '/authored/instrumentation-loader.cjs',
      ROUTE,
    ]);
  });

  it('keeps a raw-reachable shared dependency even when the host bundle also imports it', () => {
    const { own, bundledImports } = fixture();
    own.imports.set('project-hook-id', [{ specifier: './shared', target: 'shared-id' }]);

    expect(
      selected(own, { roots: [ROUTE, PROJECT_HOOK], bundledImports }).map((source) => source.file),
    ).toStrictEqual([PROJECT_HOOK, '/authored/instrumentation-loader.cjs', ROUTE, SHARED]);
  });

  it('keeps the same host target raw when another incoming edge imports it directly', () => {
    const { own, bundledImports } = fixture();
    own.imports.set('route-id', [
      { specifier: './loader', target: 'loader-id' },
      { specifier: './direct-host', target: 'host-id' },
    ]);

    expect(selected(own, { bundledImports }).map((source) => source.file)).toContain(HOST);
    expect(selected(own, { bundledImports }).map((source) => source.file)).toContain(
      '/authored/host-only.tsx',
    );
  });

  it('keeps an explicitly selected raw host root despite a separate bundled incoming edge', () => {
    const { own, bundledImports } = fixture();

    expect(
      selected(own, { roots: [ROUTE, HOST], bundledImports }).map((source) => source.file),
    ).toContain(HOST);
  });

  it.each(['from', 'to'] as const)('does not skip a boundary with changed %s digest', (side) => {
    const { own, bundledImports } = fixture();
    const boundary = bundledImports[0];
    const changed = { ...boundary, [side]: { ...boundary[side], sha256: 'b'.repeat(64) } };

    expect(selected(own, { bundledImports: [changed] }).map((source) => source.file)).toContain(
      HOST,
    );
  });

  it('does not treat the reverse boundary as permission to omit an incoming source', () => {
    const { own, bundledImports } = fixture();
    const boundary = bundledImports[0];

    expect(
      selected(own, { bundledImports: [{ from: boundary.to, to: boundary.from }] }).map(
        (source) => source.file,
      ),
    ).toContain(HOST);
  });

  it('requires a normal raw source when no certified-boundary DATA is supplied', () => {
    const { own } = fixture();

    expect(selected(own).map((source) => source.file)).toContain(HOST);
  });

  it('ignores unrelated unrooted code-null sources without granting them a raw role', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    add(own, 'unused-id', '/authored/unretained.tsx');
    own.rendered.delete('unused-id');

    expect(selected(own)).toStrictEqual([{ file: ROUTE, sha256: SHA256 }]);
  });

  it('accepts an ESM module only when every declared public export remains rendered', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    own.exports.set('route-id', {
      format: 'es',
      declared: ['default', 'handler'],
      rendered: ['handler', 'default'],
    });

    expect(selected(own)).toStrictEqual([{ file: ROUTE, sha256: SHA256 }]);
  });

  it('refuses an ESM public export eliminated from rendered analysis', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    own.exports.set('route-id', {
      format: 'es',
      declared: ['handler', 'unusedPublic'],
      rendered: ['handler'],
    });

    expect(() => selected(own)).toThrow('raw source export was eliminated');
  });

  it('refuses a raw module with missing export information', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    own.exports.delete('route-id');

    expect(() => selected(own)).toThrow('raw source');
  });

  it('accepts unknown format only as an empty side-effect-only export inventory', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    own.exports.set('route-id', { format: 'unknown', declared: [], rendered: [] });

    expect(selected(own)).toStrictEqual([{ file: ROUTE, sha256: SHA256 }]);
  });

  it.each(['declared', 'rendered'] as const)(
    'refuses unknown format with a nonempty %s export inventory',
    (field) => {
      const own = graph();
      add(own, 'route-id', ROUTE);
      own.exports.set('route-id', {
        format: 'unknown',
        declared: [],
        rendered: [],
        [field]: ['public'],
      });

      expect(() => selected(own)).toThrow('raw source');
    },
  );

  it.each([
    { kind: 'code-null', inventory: 'rendered' },
    { kind: 'unretained', inventory: 'retained' },
    { kind: 'missing-source', inventory: 'sources' },
    { kind: 'missing-imports', inventory: 'imports' },
  ] as const)('refuses a required target with $kind graph proof', ({ inventory }) => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    add(own, 'target-id', SHARED);
    own.imports.set('route-id', [{ specifier: './shared', target: 'target-id' }]);
    own[inventory].delete('target-id');

    expect(() => selected(own)).toThrow('raw source');
  });

  it.each(['imports', 'rendered'] as const)('refuses an absent %s graph inventory', (field) => {
    const own = graph();
    add(own, 'route-id', ROUTE);

    expect(() => {
      return nodeRawSourceInventory({
        graph: { ...own, [field]: undefined },
        exports: own.exports,
        roots: [ROUTE],
        nativeFiles: new Set(),
      });
    }).toThrow('raw source');
  });

  it.each(['\0unclassified-wrapper', '/authored/unproved.node'])(
    'refuses an unproved nonbuiltin target %s',
    (target) => {
      const own = graph();
      add(own, 'route-id', ROUTE);
      own.imports.set('route-id', [{ specifier: './target', target }]);

      expect(() => selected(own)).toThrow('raw source');
    },
  );

  it.each([
    { file: 'relative.cjs', sha256: SHA256 },
    { file: '/authored/../escaped.cjs', sha256: SHA256 },
    { file: SHARED, sha256: 'not-a-digest' },
  ])('refuses an invalid physical descriptor $file', (source) => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    own.sources.set('route-id', source);

    expect(() => selected(own, { roots: [source.file] })).toThrow('raw source');
  });

  it('refuses a missing or ambiguous physical root instead of guessing a graph ID', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);

    expect(() => selected(own, { roots: [SHARED] })).toThrow('raw root');

    add(own, 'copied-route-id', ROUTE);

    expect(() => selected(own)).toThrow('raw root');
  });

  it('deduplicates the same physical source reached through multiple IDs and cycles', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    add(own, 'shared-first-id', SHARED);
    add(own, 'shared-second-id', SHARED);
    own.imports.set('route-id', [
      { specifier: './first', target: 'shared-first-id' },
      { specifier: './second', target: 'shared-second-id' },
    ]);
    own.imports.set('shared-first-id', [{ specifier: './route', target: 'route-id' }]);

    expect(selected(own, { roots: [ROUTE, ROUTE] })).toStrictEqual([
      { file: ROUTE, sha256: SHA256 },
      { file: SHARED, sha256: SHA256 },
    ]);
  });

  it('refuses conflicting digests for one physical runtime source', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    add(own, 'shared-first-id', SHARED);
    add(own, 'shared-second-id', SHARED, 'b'.repeat(64));
    own.imports.set('route-id', [
      { specifier: './first', target: 'shared-first-id' },
      { specifier: './second', target: 'shared-second-id' },
    ]);

    expect(() => selected(own)).toThrow('conflicting raw source digests');
  });

  it('permits only explicit builtin, exact compiler-helper and retained native leaves', () => {
    const own = graph();
    add(own, 'route-id', ROUTE);
    const binary = '/authored/addon.node';
    own.imports.set('route-id', [
      { specifier: 'node:path', target: 'node:path' },
      { specifier: 'fs', target: 'fs' },
      { specifier: './native', target: binary },
      { specifier: './interop', target: RUNTIME },
    ]);

    expect(selected(own, { nativeFiles: new Set([binary]) })).toStrictEqual([
      { file: ROUTE, sha256: SHA256 },
    ]);
  });

  it('returns frozen source copies without freezing or retaining mutable input descriptors', () => {
    const own = graph();
    const original = add(own, 'route-id', ROUTE);
    const before = { ...original };
    const rows = selected(own);

    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
    expect(rows[0]).not.toBe(original);
    expect(Reflect.set(original, 'sha256', 'b'.repeat(64))).toBe(true);
    expect(rows).toStrictEqual([before]);
    expect(Reflect.set(rows, '0', original)).toBe(false);
  });
});
