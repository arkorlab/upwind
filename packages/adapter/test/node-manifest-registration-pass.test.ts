import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { inspectNodeManifestReachability } from '../src/node-manifest-reachability.ts';
import {
  assertNodeManifestPassBinding,
  assertNodeManifestPassRows,
  assertNodeManifestPassSources,
  assertNodeManifestPassSingle,
  nodeManifestPassForwarded,
  nodeManifestPassInitial,
  nodeManifestPassMembers,
  nodeManifestPassTouchesProtected,
  withNodeManifestRegistrationPass,
  withNodeManifestRegistrationPassAsync,
  type NodeManifestRegistrationPass,
} from '../src/node-manifest-registration-pass.ts';
import * as registry from '../src/node-manifest-registration-registry.ts';
import {
  createNodeManifestRegistrationViews,
  nodeManifestRegistrationMembers,
} from '../src/node-manifest-registration-views.ts';
import {
  certifyNodeManifestRuntimeCallers,
  proveNodeManifestRuntimeCallers,
} from '../src/node-manifest-runtime-callers.ts';
import { certifyNodeManifestRuntimeCohort } from '../src/node-manifest-runtime-cohort.ts';
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
async function fixture() {
  const table = file(
    `${DIST}/server/chunks/table.js`,
    'module.exports=[7,ctx=>{"use strict";ctx.n(ctx.i(9));},9,ctx=>{"use strict";ctx.v(42);}];',
  );
  const boots = [0, 1].map((index) => {
    const name = `${DIST}/server/pages/page-${index}.js`;
    const publicPath = `server/pages/page-${index}.js`;
    return file(
      name,
      `var R=require("../chunks/[turbopack]_runtime.js")(${jsLiteral(publicPath)});R.c("server/chunks/table.js");module.exports=R.m(7).exports;`,
      [{ specifier: '../chunks/[turbopack]_runtime.js', target: RUNTIME }],
    );
  });
  const code = (
    await readFile(new URL('fixtures/node-runtime/production.txt', import.meta.url), 'utf8')
  )
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
  const sources = [
    ...boots,
    table,
    file(RUNTIME, code, [{ specifier: table.file, target: table.id }]),
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
  const scope = registry.createNodeManifestRegistrationScope(cohort, sources);
  const graphs = boots.map((boot) => {
    return {
      ...nodeManifestTurbopackBootGraph({
        distDir: DIST,
        sources,
        file: boot.file,
        runtimeCohort: cohort,
        registrationScope: scope,
      }),
    };
  });
  const views = createNodeManifestRegistrationViews(graphs, sources);
  return { table, graphs, sources, views, inventory };
}
function present(value: NodeManifestRegistrationPass | undefined): NodeManifestRegistrationPass {
  if (value === undefined) throw new Error('expected authored scoped pass');
  return value;
}

describe('scoped immutable registration passes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks a shared real index once at each boundary while keeping every boot and frozen member', async () => {
    const own = await fixture();
    const checked = vi.spyOn(registry, 'nodeManifestRegistrationView');
    const graph = own.graphs[0]!;
    const members = withNodeManifestRegistrationPass(own.views, (pass) => {
      for (let index = 0; index < 12; index += 1) {
        expect(nodeManifestPassMembers(pass, graph.exportedId)).toStrictEqual([graph.exportedId]);
        expect(nodeManifestPassTouchesProtected(pass, graph.exportedId, new Map())).toBe(false);

        assertNodeManifestPassRows(pass, graph.factories);
      }

      expect(checked).toHaveBeenCalledTimes(1);

      return nodeManifestPassMembers(pass, graph.exportedId);
    });

    expect(checked).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(members)).toBe(true);

    nodeManifestRegistrationMembers(own.views, graph.exportedId);
    nodeManifestRegistrationMembers(own.views, graph.exportedId);

    expect(checked).toHaveBeenCalledTimes(4);
  });

  it('rejects forged, copied, escaped and reused handles without weakening public freshness', async () => {
    const own = await fixture();
    const escaped = withNodeManifestRegistrationPass(own.views, (pass) => {
      expect(() => nodeManifestPassMembers({ ...pass }, 'unknown')).toThrow('uncertified scope');

      return pass;
    });

    expect(() => nodeManifestPassMembers(escaped, 'unknown')).toThrow('inactive');
    expect(() =>
      nodeManifestPassMembers({ kind: 'scoped runtime registration pass' }, 'unknown'),
    ).toThrow('uncertified');

    withNodeManifestRegistrationPass(own.views, (pass) => {
      expect(() => nodeManifestPassMembers(escaped, 'unknown')).toThrow('inactive');
      expect(nodeManifestPassMembers(pass, 'unknown')).toBeUndefined();
    });
  });

  it('never accepts a pass from another otherwise identical build or missing views', async () => {
    const own = await fixture();
    const other = await fixture();

    withNodeManifestRegistrationPass(own.views, (pass) => {
      expect(() => {
        assertNodeManifestPassBinding(pass, other.views);
      }).toThrow('foreign registration views');
      expect(() => {
        return inspectNodeManifestReachability({
          factories: own.graphs[0]!.factories,
          graphs: [],
          callers: [],
          physicalIds: new Set(),
          runtimeIds: new Set(),
          pass,
        });
      }).toThrow('foreign registration views');
    });
  });

  it('keeps exact source-array ownership even for an active pass and identical copied members', async () => {
    const own = await fixture();

    withNodeManifestRegistrationPass(own.views, (pass) => {
      assertNodeManifestPassSources(pass, own.sources);

      expect(() => {
        assertNodeManifestPassSources(pass, [...own.sources]);
      }).toThrow('foreign source array');
      expect(() => {
        return proveNodeManifestRuntimeCallers({
          inventory: own.inventory,
          sources: [...own.sources],
          graphs: own.graphs,
          distDir: DIST,
          registrations: own.views,
          pass,
        });
      }).toThrow('foreign source array');
    });
  });

  it('checks exact source-array ownership when provided views create their own pass', async () => {
    const own = await fixture();
    const input = {
      inventory: own.inventory,
      sources: own.sources,
      graphs: own.graphs,
      distDir: DIST,
      registrations: own.views,
    };

    expect(proveNodeManifestRuntimeCallers(input).callers).toHaveLength(2);
    expect(() => proveNodeManifestRuntimeCallers({ ...input, sources: [...own.sources] })).toThrow(
      'foreign source array',
    );
  });

  it.each(['exportedId', 'evaluations', 'initialChunks', 'lookupTables'] as const)(
    'rejects changed secondary boot %s before the result leaves its scope',
    async (key) => {
      const own = await fixture();
      const graph = own.graphs[1]!;
      let escaped: NodeManifestRegistrationPass | undefined;

      expect(() => {
        return withNodeManifestRegistrationPass(own.views, (pass) => {
          escaped = pass;
          Object.assign(graph, { [key]: key === 'exportedId' ? 'unregistered' : ['unregistered'] });
          return { provisional: true };
        });
      }).toThrow('stale graph identity');
      expect(() => nodeManifestPassMembers(present(escaped), 'unknown')).toThrow('inactive');
    },
  );

  it('rejects stale original source/index before any scoped callback starts', async () => {
    const own = await fixture();
    const called = vi.fn();
    Object.assign(own.table.source, { code: 'module.exports=[];' });

    expect(() => withNodeManifestRegistrationPass(own.views, called)).toThrow(
      'stale registration index',
    );
    expect(called).toHaveBeenCalledTimes(0);
    expect(() => nodeManifestRegistrationMembers(own.views, own.graphs[0]!.exportedId)).toThrow(
      'stale registration index',
    );
  });

  it('does not adopt transient changed forwarding, boot IDs or registration membership', async () => {
    const own = await fixture();
    const graph = own.graphs[0]!;
    const saved = graph.exportedId;
    const imports = own.table.imports;

    withNodeManifestRegistrationPass(own.views, (pass) => {
      const target = nodeManifestPassForwarded(pass, saved)!;
      Object.assign(graph, { exportedId: 'invented' });
      Object.assign(own.table, { imports: [{ specifier: 'invented', target: 'invented' }] });

      expect(nodeManifestPassMembers(pass, 'invented')).toBeUndefined();
      expect(nodeManifestPassForwarded(pass, saved)).toBe(target);
      expect(() => nodeManifestPassInitial(pass, graph, 999, new Set([own.table.id]))).toThrow(
        'unregistered boot evaluation',
      );
      expect(nodeManifestPassInitial(pass, graph, 7, new Set([own.table.id]))).toBe(saved);

      Object.assign(graph, { exportedId: saved });
      Object.assign(own.table, { imports });
    });
  });

  it('compares all physical row identities and never expands a copied row', async () => {
    const own = await fixture();
    const rows = own.graphs[0]!.factories;

    withNodeManifestRegistrationPass(own.views, (pass) => {
      expect(() => {
        assertNodeManifestPassRows(pass, rows.slice(1));
      }).toThrow('incomplete physical rows');
      expect(() => {
        assertNodeManifestPassRows(
          pass,
          rows.map((row) => ({ ...row })),
        );
      }).toThrow('incomplete physical rows');

      assertNodeManifestPassSingle(pass, own.graphs[0]!.exportedId);
    });
  });

  it('keeps async scopes active only until final freshness, then revokes every handle', async () => {
    const own = await fixture();
    let escaped: NodeManifestRegistrationPass | undefined;
    const result = await withNodeManifestRegistrationPassAsync(own.views, async (pass) => {
      escaped = pass;
      await Promise.resolve();
      return nodeManifestPassMembers(pass, own.graphs[0]!.exportedId);
    });

    expect(result).toStrictEqual([own.graphs[0]!.exportedId]);
    expect(() => nodeManifestPassMembers(present(escaped), 'unknown')).toThrow('inactive');
  });

  it('refuses changed async input before publishing a provisional result and revokes on failure', async () => {
    const own = await fixture();
    let escaped: NodeManifestRegistrationPass | undefined;

    await expect(
      withNodeManifestRegistrationPassAsync(own.views, async (pass) => {
        escaped = pass;
        await Promise.resolve();
        Object.assign(own.graphs[1]!, { exportedId: 'changed' });
        return { provisional: true };
      }),
    ).rejects.toThrow('stale graph identity');
    expect(() => nodeManifestPassMembers(present(escaped), 'unknown')).toThrow('inactive');
  });

  it('propagates unexpected sync and async errors and never leaves their scopes usable', async () => {
    const own = await fixture();
    const failure = new Error('authored failure');
    let escaped: NodeManifestRegistrationPass | undefined;

    expect(() => {
      return withNodeManifestRegistrationPass(own.views, (pass) => {
        escaped = pass;
        throw failure;
      });
    }).toThrow(failure);
    expect(() => nodeManifestPassMembers(present(escaped), 'unknown')).toThrow('inactive');
    await expect(
      withNodeManifestRegistrationPassAsync(own.views, (pass) => {
        escaped = pass;
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    expect(() => nodeManifestPassMembers(present(escaped), 'unknown')).toThrow('inactive');
    expect(() => withNodeManifestRegistrationPass(own.views, () => Promise.resolve(42))).toThrow(
      'asynchronous result in synchronous scope',
    );
  });

  it.each(['code', 'sha256'] as const)(
    'rejects async original-source %s changes before returning any result',
    async (key) => {
      const own = await fixture();
      let escaped: NodeManifestRegistrationPass | undefined;

      await expect(
        withNodeManifestRegistrationPassAsync(own.views, async (pass) => {
          escaped = pass;
          await Promise.resolve();
          Object.assign(own.table.source, { [key]: 'changed' });
          return nodeManifestPassMembers(pass, own.graphs[0]!.exportedId);
        }),
      ).rejects.toThrow('stale registration index');
      expect(() => nodeManifestPassMembers(present(escaped), 'unknown')).toThrow('inactive');
    },
  );

  it('propagates an unexpected final validator failure before returning, then revokes its handle', async () => {
    const own = await fixture();
    const actual = registry.nodeManifestRegistrationView;
    const failure = new RangeError('authored validator failure');
    vi.spyOn(registry, 'nodeManifestRegistrationView')
      .mockImplementationOnce(actual)
      .mockImplementationOnce(() => {
        throw failure;
      });
    let escaped: NodeManifestRegistrationPass | undefined;

    expect(() => {
      return withNodeManifestRegistrationPass(own.views, (pass) => {
        escaped = pass;
        return { provisional: true };
      });
    }).toThrow(failure);
    expect(() => nodeManifestPassMembers(present(escaped), 'unknown')).toThrow('inactive');
  });
});
