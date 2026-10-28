import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { inspectNodeManifestReachability } from '../src/node-manifest-reachability.ts';
import { createNodeManifestRegistrationScope } from '../src/node-manifest-registration-registry.ts';
import {
  assertNodeManifestSingleRegistration,
  createNodeManifestRegistrationViews,
  nodeManifestInitialGraphRegistration,
  nodeManifestRegistrationMembers,
  nodeManifestRegistrationProofFiles,
  nodeManifestRegistrationTouchesProtected,
} from '../src/node-manifest-registration-views.ts';
import {
  certifyNodeManifestRuntimeCallers,
  proveNodeManifestRuntimeCallers,
} from '../src/node-manifest-runtime-callers.ts';
import { certifyNodeManifestRuntimeCohort } from '../src/node-manifest-runtime-cohort.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import {
  nodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackGraphFile,
} from '../src/node-manifest-turbopack-graph.ts';

const ROOT = '/project';
const DIST = `${ROOT}/.next`;
const RUNTIME = `${DIST}/server/chunks/[turbopack]_runtime.js`;
function file(
  name: string,
  code: string,
  imports: NodeManifestTurbopackGraphFile['imports'] = [],
): NodeManifestTurbopackGraphFile {
  return {
    id: name,
    file: name,
    source: { code, sha256: createHash('sha256').update(code).digest('hex') },
    imports,
  };
}
async function fixture(withImporter = false) {
  const tables = [0, 1].map((index) => {
    const extra = withImporter && index === 0 ? ',99,ctx=>{"use strict";ctx.i(7);ctx.v(99);}' : '';
    return file(
      `${DIST}/server/chunks/table-${index}.js`,
      `module.exports=[7,"7",ctx=>{"use strict";ctx.v(42);}${extra}];`,
    );
  });
  const boots = tables.map((table, index) => {
    const name = `${DIST}/server/pages/page-${index}.js`;
    const code = `var R=require("../chunks/[turbopack]_runtime.js")(${jsLiteral(path.posix.relative(DIST, name))});R.c(${jsLiteral(path.posix.relative(DIST, table.file))});module.exports=R.m(7).exports;`;
    return file(name, code, [{ specifier: '../chunks/[turbopack]_runtime.js', target: RUNTIME }]);
  });
  const runtime = (
    await readFile(new URL('fixtures/node-runtime/production.txt', import.meta.url), 'utf8')
  )
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
  const sources = [
    ...boots,
    ...tables,
    file(
      RUNTIME,
      runtime,
      tables.map((table) => ({ specifier: table.file, target: table.id })),
    ),
  ];
  const profiles = boots.map((boot, index) => {
    return {
      file: boot.file,
      pathname: `/page-${index}`,
      kind: 'pages' as const,
      assetPrefix: '/',
    };
  });
  const inventory = await certifyNodeManifestRuntimeCallers({
    rootDir: ROOT,
    distDir: DIST,
    sources,
    entries: profiles.map((profile) => ({ id: profile.pathname, canonicalFilePath: profile.file })),
    routes: profiles,
    entryTraces: [],
    retained: new Set(sources.map((source) => source.id)),
  });
  const cohort = certifyNodeManifestRuntimeCohort({
    rootDir: ROOT,
    distDir: DIST,
    sources,
    profiles,
    inventory,
    requiredBoots: boots.map((boot) => boot.file),
  });
  const scope = createNodeManifestRegistrationScope(cohort, sources);
  const graphs = boots.map((boot) => {
    return nodeManifestTurbopackBootGraph({
      distDir: DIST,
      sources,
      file: boot.file,
      runtimeCohort: cohort,
      registrationScope: scope,
    });
  });
  return { sources, tables, boots, profiles, inventory, graphs };
}

describe('all-member runtime registration views', () => {
  it('expands a singleton dependency on a logical group into all physical alternatives and callback aliases', async () => {
    const own = await fixture(true);
    const graph = own.graphs[0]!;
    const views = createNodeManifestRegistrationViews(own.graphs, own.sources);
    const importer = graph.factories.find((row) => row.projection.moduleId === 99)!;
    const result = inspectNodeManifestReachability({
      factories: graph.factories,
      graphs: [{ exportedId: importer.id, evaluations: [] }],
      callers: [],
      physicalIds: new Set(own.sources.map((source) => source.id)),
      runtimeIds: new Set([RUNTIME]),
      registrations: views,
    });

    expect(importer.imports[0]?.target).toBe(graph.exportedId);
    expect(new Set(result.reached)).toStrictEqual(new Set(graph.factories.map((row) => row.id)));
  });

  it('expands every physical alternative and merged alias without a representative or lost file', async () => {
    const own = await fixture();
    const views = createNodeManifestRegistrationViews(own.graphs, own.sources);
    const graph = own.graphs[0]!;
    const logical = graph.exportedId;
    const members = nodeManifestRegistrationMembers(views, logical)!;
    const callers = proveNodeManifestRuntimeCallers({
      inventory: own.inventory,
      sources: own.sources,
      graphs: own.graphs,
      distDir: DIST,
    });
    const reached = inspectNodeManifestReachability({
      factories: graph.factories,
      graphs: [graph],
      callers: callers.callers,
      physicalIds: new Set(own.sources.map((source) => source.id)),
      runtimeIds: new Set([RUNTIME]),
      registrations: views,
    });
    const files = nodeManifestRegistrationProofFiles(own.graphs, own.sources, callers);

    expect(members).toHaveLength(2);
    expect(reached.reached).toHaveLength(4);
    expect(new Set(reached.reached)).toStrictEqual(new Set(graph.factories.map((row) => row.id)));
    expect(callers.callers.map((caller) => caller.invoked)).toStrictEqual([[logical], [logical]]);
    expect(new Set(files.map((source) => source.file))).toStrictEqual(
      new Set(own.sources.map((source) => source.file)),
    );
    expect(nodeManifestRegistrationTouchesProtected(views, logical, new Map())).toBe(false);
    expect(
      nodeManifestInitialGraphRegistration(
        own.graphs[0]!,
        own.sources,
        7,
        new Set([own.tables[1]!.id]),
      ),
    ).toBe(logical);
    expect(Object.isFrozen(members)).toBe(true);
  });

  it('expands a physical group member seed and includes every selected-ID alias of its original callback', async () => {
    const own = await fixture();
    const graph = own.graphs[0]!;
    const views = createNodeManifestRegistrationViews(own.graphs, own.sources);
    const row = graph.factories[0]!;
    const reached = inspectNodeManifestReachability({
      factories: graph.factories,
      graphs: [{ exportedId: row.id, evaluations: [] }],
      callers: [],
      physicalIds: new Set(own.sources.map((source) => source.id)),
      runtimeIds: new Set([RUNTIME]),
      registrations: views,
    });

    expect(new Set(reached.reached)).toStrictEqual(
      new Set(graph.factories.map((factory) => factory.id)),
    );
    expect(nodeManifestRegistrationMembers(views, row.id)).toHaveLength(2);
    expect(
      nodeManifestRegistrationTouchesProtected(
        views,
        graph.exportedId,
        new Map([[row.id, 'protected']]),
      ),
    ).toBe(true);
  });

  it('never grants a protected role to either logical or physical group identity', async () => {
    const own = await fixture();
    const graph = own.graphs[0]!;
    const views = createNodeManifestRegistrationViews(own.graphs, own.sources);

    expect(() => {
      assertNodeManifestSingleRegistration(views, graph.exportedId);
    }).toThrow('grouped protected identity unsupported');
    expect(() => {
      assertNodeManifestSingleRegistration(views, graph.factories[0]!.id);
    }).toThrow('grouped protected identity unsupported');
    await expect(
      proveNodeManifestTurbopackConsumers({
        rootDir: ROOT,
        distDir: DIST,
        sources: own.sources,
        runtimeCallers: own.inventory,
        runtimeProfiles: own.profiles,
        entries: [
          { file: own.boots[0]!.file, kind: 'pages', page: '/page-0', pathname: '/page-0' },
        ],
        producer: {
          id: 'producer',
          file: '/reviewed/next-producer.js',
          sha256: 'a'.repeat(64),
          kind: 'pages-class',
        },
      }),
    ).rejects.toThrow('grouped protected identity unsupported');
  });

  it('fails closed for copied tokens, source-array replacement, changed graph rows and missing physical inputs', async () => {
    const own = await fixture();
    const graph = { ...own.graphs[0]! };
    const views = createNodeManifestRegistrationViews([graph], own.sources);
    const input = {
      graphs: [graph],
      callers: [],
      physicalIds: new Set<string>(),
      runtimeIds: new Set([RUNTIME]),
      registrations: views,
    };

    expect(() => nodeManifestRegistrationMembers({ ...views }, graph.exportedId)).toThrow(
      'uncertified',
    );
    expect(() => createNodeManifestRegistrationViews([graph], [...own.sources])).toThrow(
      'stale registration index',
    );
    expect(() =>
      inspectNodeManifestReachability({ ...input, factories: graph.factories.slice(1) }),
    ).toThrow('incomplete physical rows');

    Object.assign(graph, { factories: [...graph.factories] });

    expect(() => nodeManifestRegistrationMembers(views, graph.exportedId)).toThrow(
      'stale graph identity',
    );
  });

  it('keeps legacy no-index number/string keys distinct but refuses any duplicate typed module id', async () => {
    const own = await fixture();
    const graph = own.graphs[0]!;
    const legacy = {
      ...graph,
      registrationIndex: undefined,
      factories: graph.factories.filter((row) => row.physicalId === own.tables[0]!.id),
    };
    const numeric = nodeManifestInitialGraphRegistration(
      legacy,
      own.sources,
      7,
      new Set([own.tables[0]!.id]),
    );
    const string = nodeManifestInitialGraphRegistration(
      legacy,
      own.sources,
      '7',
      new Set([own.tables[0]!.id]),
    );

    expect(numeric).not.toBe(string);
    expect(() => {
      return createNodeManifestRegistrationViews(
        [{ ...graph, registrationIndex: undefined }],
        own.sources,
      );
    }).toThrow('duplicate legacy module id');
    expect(() => {
      return nodeManifestInitialGraphRegistration(
        { ...graph, registrationIndex: undefined },
        own.sources,
        7,
        new Set(),
      );
    }).toThrow('duplicate legacy module id');
  });

  it('rejects a changed physical source before any previously certified group can be used', async () => {
    const own = await fixture();
    const views = createNodeManifestRegistrationViews(own.graphs, own.sources);
    Object.assign(own.tables[0]!.source, { code: 'module.exports=[];' });

    expect(() => nodeManifestRegistrationMembers(views, own.graphs[0]!.exportedId)).toThrow(
      'stale registration index',
    );
  });
});
