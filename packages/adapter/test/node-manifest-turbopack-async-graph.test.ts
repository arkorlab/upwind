import { readFile } from 'node:fs/promises';

import { compareCodeUnits } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { inspectNodeManifestReachability } from '../src/node-manifest-reachability.ts';
import { certifyNodeManifestRuntimeCallers } from '../src/node-manifest-runtime-callers.ts';
import { prepareNodeManifestRuntimeGraphs } from '../src/node-manifest-runtime-cohort.ts';
import {
  nodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackGraphFile,
} from '../src/node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackModuleId } from '../src/node-manifest-turbopack.ts';
import { manifestTemplateSource as source } from './fixtures/node-manifest-turbopack-template.ts';

const DIST = '/project/.next';
const ENTRY = `${DIST}/server/app/native/page.js`;
const RUNTIME = `${DIST}/server/chunks/[turbopack]_runtime.js`;
const MAIN = `${DIST}/server/chunks/app.js`;
const DEFERRED = `${DIST}/server/chunks/dep.js`;
const ENTRY_METADATA = {
  file: ENTRY,
  page: '/native/page',
  pathname: '/native',
  kind: 'app-page',
} as const;

function loader(
  target: NodeManifestTurbopackModuleId,
  chunkData = '"server/chunks/dep.js"',
): string {
  return `ctx.v(parentImport=>Promise.all([${chunkData}].map(chunk=>ctx.l(chunk))).then(()=>parentImport(${jsLiteral(target)})));`;
}
function fixture(
  loaderId: NodeManifestTurbopackModuleId = 3,
  targetId: NodeManifestTurbopackModuleId = 2,
) {
  const sources: readonly NodeManifestTurbopackGraphFile[] = [
    {
      id: ENTRY,
      file: ENTRY,
      source: source(
        'var R=require("../../chunks/[turbopack]_runtime.js")("server/app/native/page.js");R.c("server/chunks/app.js");R.m(1);module.exports=R.m(1).exports;',
      ),
      imports: [{ specifier: '../../chunks/[turbopack]_runtime.js', target: RUNTIME }],
    },
    {
      id: RUNTIME,
      file: RUNTIME,
      source: source('module.exports=unprovedRuntime;'),
      imports: [
        { specifier: MAIN, target: MAIN },
        { specifier: DEFERRED, target: DEFERRED },
      ],
    },
    {
      id: MAIN,
      file: MAIN,
      source: source(
        `module.exports=[1,ctx=>{ctx.v(ctx.A(${jsLiteral(loaderId)}));},${jsLiteral(loaderId)},ctx=>{${loader(targetId)}}];`,
      ),
      imports: [],
    },
    {
      id: DEFERRED,
      file: DEFERRED,
      source: source(`module.exports=[${jsLiteral(targetId)},ctx=>{ctx.v(42);}];`),
      imports: [],
    },
  ];
  return { distDir: DIST, entry: ENTRY_METADATA, sources };
}
type Fixture = ReturnType<typeof fixture>;
function requiredFactory(
  graph: ReturnType<typeof nodeManifestTurbopackEntryGraph>,
  id: NodeManifestTurbopackModuleId,
) {
  const factory = graph.factories.find((candidate) => candidate.projection.moduleId === id);
  if (factory === undefined) throw new Error('Expected a closed graph factory');
  return factory;
}
function edit(input: Fixture, file: string, change: (code: string) => string): Fixture {
  return {
    ...input,
    sources: input.sources.map((record) =>
      record.file === file ? { ...record, source: source(change(record.source.code)) } : record,
    ),
  };
}
function noTargetTable(input: Fixture): Fixture {
  return {
    ...input,
    sources: input.sources.map((record) => {
      return record.file === RUNTIME
        ? { ...record, imports: record.imports.filter((edge) => edge.target !== DEFERRED) }
        : record;
    }),
  };
}

describe('finite async loader runtime graph closure', () => {
  it.each([
    [3, 2],
    ['3', '2'],
  ] as const)('retains exact caller→loader→target identities for %j→%j', (loaderId, targetId) => {
    const graph = nodeManifestTurbopackEntryGraph(fixture(loaderId, targetId));
    const caller = requiredFactory(graph, 1);
    const selected = requiredFactory(graph, loaderId);
    const target = requiredFactory(graph, targetId);
    const reachability = inspectNodeManifestReachability({
      factories: graph.factories,
      graphs: [graph],
      callers: [],
      physicalIds: new Set(graph.factories.map((factory) => factory.physicalId)),
      runtimeIds: new Set([RUNTIME]),
    });

    expect(caller.imports.map((edge) => edge.target)).toStrictEqual([selected.id]);
    expect(selected.imports.map((edge) => edge.target)).toStrictEqual([target.id]);
    expect(selected.projection.source.code).toContain('ctx.l(chunk)');
    expect(caller.projection.source.code).toContain('ctx.A(');
    expect(graph.requiresReviewedRuntime).toBe(true);
    expect(reachability.reached).toStrictEqual(
      [caller.id, selected.id, target.id].toSorted(compareCodeUnits),
    );
  });

  it('checks every unused certified loader rather than only ctx.A-reachable factories', () => {
    const input = edit(fixture(), MAIN, (code) => {
      return code
        .replace('ctx.v(ctx.A(3));', 'ctx.v(42);')
        .replace('server/chunks/dep.js', 'server/chunks/missing.js');
    });

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow('unclosed literal chunk table');
  });

  it('does not turn a physical source outside the actual runtime table into a chunk target', () => {
    const input = noTargetTable(fixture());

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow('unregistered loader target');
  });

  it('binds chunk paths independently of the target module registry', () => {
    const input = edit(fixture(), MAIN, (code) =>
      code.replace('server/chunks/dep.js', 'server/chunks/missing.js'),
    );

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow('unclosed literal chunk table');
  });

  it('does not let serde metadata hints stand in for the Node-loaded path', () => {
    const input = edit(fixture(), MAIN, (code) => {
      return code.replace(
        '"server/chunks/dep.js"',
        '{path:"server/chunks/missing.js",included:[2],moduleChunks:["server/chunks/dep.js"]}',
      );
    });

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow('unclosed literal chunk table');
  });

  it('does not let a runtime module act as a registration table for ctx.l', () => {
    const input = edit(fixture(), MAIN, (code) =>
      code.replace('server/chunks/dep.js', 'server/chunks/[turbopack]_runtime.js'),
    );

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow('unclosed literal chunk table');
  });

  it('requires an actual loader certificate for the exact selected registration ID', () => {
    const input = edit(fixture(), MAIN, (code) =>
      code.replace('3,ctx=>{', '3,4,ctx=>{').replace('parentImport(2)));', 'parentImport(2)),4);'),
    );

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow(
      'unregistered or uncertified loader',
    );
  });

  it('refuses an ordinary value factory used through ctx.A', () => {
    const input = edit(
      fixture(),
      MAIN,
      () => 'module.exports=[1,ctx=>{ctx.v(ctx.A(3));},3,ctx=>{ctx.v(42);}];',
    );

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow(
      'unregistered or uncertified loader',
    );
  });

  it('keeps numeric and string loader IDs distinct instead of borrowing a certificate', () => {
    const input = edit(fixture(), MAIN, (code) => code.replace('ctx.A(3)', 'ctx.A("3")'));

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow(
      'unregistered or uncertified loader',
    );
  });

  it('requires the target to be a registered module, independent of chunk availability', () => {
    const input = edit(fixture(), DEFERRED, () => 'module.exports=[4,ctx=>{ctx.v(42);}];');

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow('unregistered loader target');
  });

  it('does not infer an independently callable loader from a same-factory cache initializer', () => {
    const input = edit(
      fixture(),
      MAIN,
      () => 'module.exports=[1,ctx=>{ctx.v(42,3);ctx.v(ctx.A(3));}];',
    );

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow(
      'unregistered or uncertified loader',
    );
  });

  it('supports the exact zero-chunk producer while still requiring its static target registry', () => {
    const input = edit(fixture(), MAIN, (code) => {
      return code.replace(
        'Promise.all(["server/chunks/dep.js"].map(chunk=>ctx.l(chunk)))',
        'Promise.resolve()',
      );
    });
    const registered = edit(input, ENTRY, (code) =>
      code.replace('R.m(1);', 'R.c("server/chunks/dep.js");R.m(1);'),
    );
    const graph = nodeManifestTurbopackEntryGraph(registered);

    expect(
      graph.factories.find((factory) => factory.projection.moduleId === 3)?.projection.asyncLoader,
    ).toStrictEqual({ targetId: 2, chunks: [] });
    expect(() => nodeManifestTurbopackEntryGraph(noTargetTable(input))).toThrow(
      'unregistered loader target',
    );
  });

  it('does not allow malformed unused table code merely because a loader is otherwise certified', () => {
    const input = edit(fixture(), DEFERRED, (code) =>
      code.replace('module.exports=[', 'module.exports=[99,ctx=>{ctx.unknown();},'),
    );

    expect(() => nodeManifestTurbopackEntryGraph(input)).toThrow('Unproved Next.js Turbopack');
  });

  it('preserves original table source SHA validation before using loader metadata', () => {
    const input = fixture();
    const sources = input.sources.map((record) => {
      return record.file === DEFERRED
        ? { ...record, source: { ...record.source, code: 'module.exports=[];' } }
        : record;
    });

    expect(() => nodeManifestTurbopackEntryGraph({ ...input, sources })).toThrow('source identity');
  });

  it('also closes through a fully sealed owned runtime cohort without inventing another terminal', async () => {
    const original = await readFile(
      new URL('fixtures/node-runtime/production.txt', import.meta.url),
      'utf8',
    );
    const input = edit(fixture(), RUNTIME, () => {
      return original
        .replace(
          'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
          'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
        )
        .replace(
          'var RELATIVE_ROOT_PATH = "../../../../../../..";',
          'var RELATIVE_ROOT_PATH = "..";',
        );
    });
    const inventory = await certifyNodeManifestRuntimeCallers({
      rootDir: '/project',
      distDir: DIST,
      entries: [{ id: '/native', canonicalFilePath: ENTRY }],
      routes: [ENTRY_METADATA],
      entryTraces: [],
      sources: input.sources,
      retained: new Set(input.sources.map((record) => record.id)),
    });
    const proof = prepareNodeManifestRuntimeGraphs({
      rootDir: '/project',
      distDir: DIST,
      entries: [ENTRY_METADATA],
      sources: input.sources,
      inventory,
      profiles: [ENTRY_METADATA],
    });

    expect(proof.graphs.map((graph) => graph.entry.file)).toStrictEqual([ENTRY]);
    expect(proof.allGraphs).toHaveLength(1);
    expect(proof.graphs[0]?.factories.map((factory) => factory.projection.moduleId)).toStrictEqual([
      1, 3, 2,
    ]);
  });
});
