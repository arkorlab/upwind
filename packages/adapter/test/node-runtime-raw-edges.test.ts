import { describe, expect, it } from 'vitest';

import { nodeRawSourceInventory, type NodeBundledImport } from '../src/node-bundle-closure.ts';
import { nodeNextHookRawClosureData } from '../src/node-next-hook-raw-role.ts';

const PREFIX = '/authored/project';
const HASH = 'a'.repeat(64);

function authoredSource(
  id: string,
): readonly [string, { readonly file: string; readonly sha256: string }] {
  return [id, { file: `${PREFIX}/${id}.cjs`, sha256: HASH }];
}

function fixture() {
  const sources = new Map(['entry', 'caller', 'target', 'unused'].map((id) => authoredSource(id)));
  const graph = {
    sources,
    retained: new Set(sources.keys()),
    rendered: new Map([...sources.keys()].map((id) => [id, 'exports.value=17;'])),
    imports: new Map(
      [...sources.keys()].map((id) => [id, [] as { specifier: string; target: string }[]]),
    ),
  };
  const pin = (id: string) => sources.get(id) ?? { file: 'missing', sha256: HASH };
  const edge: NodeBundledImport = { from: pin('caller'), to: pin('target') };
  const input = {
    graph,
    roots: [pin('entry').file],
    nativeFiles: new Set<string>(),
    exports: new Map(
      [...sources.keys()].map((id) => [id, { format: 'cjs' as const, declared: [], rendered: [] }]),
    ),
    runtimeImports: [edge],
  };
  return { input, graph, pin, edge };
}

describe('runtime raw dependency DATA edges', () => {
  it('projects only the startup source and explicit runtime edges from mixed pins', () => {
    const own = fixture();
    const projected = nodeNextHookRawClosureData({
      file: own.pin('entry').file,
      files: new Map([...own.graph.sources.values()].map((source) => [source.file, source])),
      edges: [
        {
          caller: own.pin('caller').file,
          specifier: 'runtime-edge',
          target: own.pin('target').file,
        },
      ],
    });

    expect(projected).toStrictEqual({ root: own.pin('entry'), imports: [own.edge] });
    expect(Object.isFrozen(projected.root)).toBe(true);
    expect(Object.isFrozen(projected.imports[0]?.to)).toBe(true);
  });

  it('refuses a runtime edge missing its original source pin', () => {
    const own = fixture();

    expect(() => {
      return nodeNextHookRawClosureData({
        file: own.pin('entry').file,
        files: new Map([[own.pin('entry').file, own.pin('entry')]]),
        edges: [
          {
            caller: own.pin('caller').file,
            specifier: 'runtime-edge',
            target: own.pin('target').file,
          },
        ],
      });
    }).toThrow('raw load source is missing');
  });

  it('does not promote an edge whose caller is outside the raw closure', () => {
    const own = fixture();

    expect(nodeRawSourceInventory(own.input)).toStrictEqual([own.pin('entry')]);
  });

  it('promotes the exact runtime target when its caller becomes raw reachable', () => {
    const own = fixture();
    own.graph.imports.set('entry', [{ specifier: './caller.cjs', target: 'caller' }]);

    expect(nodeRawSourceInventory(own.input)).toStrictEqual([
      own.pin('caller'),
      own.pin('entry'),
      own.pin('target'),
    ]);
  });

  it('rejects a changed runtime caller digest', () => {
    const own = fixture();
    own.input.roots.push(own.pin('caller').file);
    own.input.runtimeImports = [
      { ...own.edge, from: { ...own.pin('caller'), sha256: 'b'.repeat(64) } },
    ];

    expect(() => nodeRawSourceInventory(own.input)).toThrow('runtime caller source changed');
  });

  it('rejects a changed or missing runtime target', () => {
    const own = fixture();
    own.input.roots.push(own.pin('caller').file);
    own.input.runtimeImports = [
      { ...own.edge, to: { ...own.pin('target'), sha256: 'b'.repeat(64) } },
    ];

    expect(() => nodeRawSourceInventory(own.input)).toThrow('runtime dependency');
  });

  it('keeps the ordinary retained and rendered checks for promoted targets', () => {
    const own = fixture();
    own.input.roots.push(own.pin('caller').file);
    own.graph.rendered.delete('target');

    expect(() => nodeRawSourceInventory(own.input)).toThrow('retained rendered physical proof');
  });

  it('rejects ambiguous physical targets instead of selecting a graph row', () => {
    const own = fixture();
    own.input.roots.push(own.pin('caller').file);
    own.graph.sources.set('other-target-id', own.pin('target'));

    expect(() => nodeRawSourceInventory(own.input)).toThrow('ambiguous runtime dependency');
  });
});
