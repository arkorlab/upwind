import { createHash } from 'node:crypto';

import { assert, describe, expect, it } from 'vitest';

import { nodeManifestHandlerActualData } from '../src/node-manifest-handler-actual.ts';
import { withNodeManifestRegistrationPass } from '../src/node-manifest-registration-pass.ts';
import { createNodeManifestRegistrationViews } from '../src/node-manifest-registration-views.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
} from '../src/node-manifest-turbopack-graph.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';

function source(code: string) {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
function fixture(external = false) {
  const body = external ? 'const v=ctx.x("pinned",()=>require("pinned"));ctx.v(v);' : 'ctx.v(42);';
  const original = source(
    `module.exports=[1,2,(ctx)=>{const v=ctx.i(3);ctx.v(v,1);ctx.v(v,2);},3,(ctx)=>{${body}}];`,
  );
  const physical = { id: 'chunk', file: '/authored/chunk.js', source: original, imports: [] };
  const leaf = {
    id: 'leaf',
    file: '/authored/next/dist/pin.js',
    source: source('module.exports=42;'),
    imports: [],
  };
  const runtime = {
    id: 'runtime',
    file: '/authored/runtime.js',
    source: source('authoredRuntime;'),
    imports: [],
  };
  const rows: NodeManifestTurbopackGraphFactory[] = [1, 2, 3].map((id) => {
    const projection = projectNodeManifestTurbopackFactory(original, id, 'dependencies');
    return {
      id: `factory:${id}`,
      runtimeId: runtime.id,
      physicalId: physical.id,
      projection,
      imports: projection.imports.map((entry) => {
        return {
          specifier: entry.specifier,
          target: entry.targetId === undefined ? leaf.id : `factory:${entry.targetId}`,
        };
      }),
    };
  });
  const root = rows[0];
  assert(root !== undefined);
  const graph: NodeManifestTurbopackBootGraph = {
    physicalId: 'entry',
    runtimeId: runtime.id,
    exportedId: root.id,
    evaluations: [],
    initialChunks: [physical.id],
    factories: rows,
    runtime,
    requiresReviewedRuntime: true,
  };
  const sources = [physical, runtime, leaf];
  const views = createNodeManifestRegistrationViews([graph], sources);
  return { rows, root, graph, sources, views, nextRoot: '/authored/next' };
}

describe('complete actual handler comparison DATA', () => {
  it('retains every selected coalesced alias and its complete original callback', () => {
    const own = fixture();
    const data = withNodeManifestRegistrationPass(own.views, (pass) =>
      nodeManifestHandlerActualData({ ...own, pass }),
    );

    expect(new Set(data?.graph.rows.map((row) => row.moduleId))).toStrictEqual(new Set([1, 2, 3]));
    expect(data?.graph.rows[0]?.whole.factory.ids).toStrictEqual([1, 2]);
    expect(data?.graph.rows[0]?.whole.canonical).toContain('callback');
    expect(data?.sources.map((item) => item.id)).toStrictEqual(['chunk']);
    expect(data).not.toHaveProperty('member');
  });

  it('uses the actual resolved source object and exact common Next root for a leaf', () => {
    const own = fixture(true);
    const data = withNodeManifestRegistrationPass(own.views, (pass) =>
      nodeManifestHandlerActualData({ ...own, pass }),
    );
    const leaf = data?.graph.rows.find((row) => row.moduleId === 3)?.imports[0]?.target;

    expect(leaf).toMatchObject({
      kind: 'next-source',
      root: own.nextRoot,
      relative: 'dist/pin.js',
      file: '/authored/next/dist/pin.js',
    });
    expect(data?.sources.map((item) => item.id)).toContain('leaf');
  });

  it('declines an initially supplied duplicate selected ID instead of choosing a physical winner', () => {
    const own = fixture();
    const duplicate = { ...own.root, id: 'another-physical-registration', physicalId: 'other' };
    const data = withNodeManifestRegistrationPass(own.views, (pass) =>
      nodeManifestHandlerActualData({ ...own, rows: [...own.rows, duplicate], pass }),
    );

    expect(data).toBeUndefined();
  });

  it('declines a missing coalesced sibling row, copied root or copied original source object', () => {
    const own = fixture();
    withNodeManifestRegistrationPass(own.views, (pass) => {
      expect(
        nodeManifestHandlerActualData({
          ...own,
          rows: own.rows.filter((row) => row.projection.moduleId !== 2),
          pass,
        }),
      ).toBeUndefined();
      expect(
        nodeManifestHandlerActualData({ ...own, root: { ...own.root }, pass }),
      ).toBeUndefined();
      expect(
        nodeManifestHandlerActualData({
          ...own,
          sources: own.sources.map((item) => ({ ...item, source: { ...item.source } })),
          pass,
        }),
      ).toBeUndefined();
    });
  });

  it('declines an external source from another Next root', () => {
    const own = fixture(true);
    const data = withNodeManifestRegistrationPass(own.views, (pass) =>
      nodeManifestHandlerActualData({ ...own, nextRoot: '/other/next', pass }),
    );

    expect(data).toBeUndefined();
  });

  it('refuses a returned pass after its active source scope ends', () => {
    const own = fixture();
    const pass = withNodeManifestRegistrationPass(own.views, (active) => active);

    expect(() => nodeManifestHandlerActualData({ ...own, pass })).toThrow(
      'inactive or uncertified scope',
    );
  });
});
