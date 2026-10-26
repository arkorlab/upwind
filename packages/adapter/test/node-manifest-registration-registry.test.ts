import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assert, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import {
  createNodeManifestRegistrationScope,
  nodeManifestInitialRegistration,
  nodeManifestRegistrationIndex,
  nodeManifestRegistrationView,
} from '../src/node-manifest-registration-registry.ts';
import { certifyNodeManifestRuntimeCallers } from '../src/node-manifest-runtime-callers.ts';
import { certifyNodeManifestRuntimeCohort } from '../src/node-manifest-runtime-cohort.ts';
import {
  nodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackGraphFile,
} from '../src/node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackModuleId } from '../src/node-manifest-turbopack.ts';

const ROOT = '/project';
const DIST = `${ROOT}/.next`;
const RUNTIME = `${DIST}/server/chunks/[turbopack]_runtime.js`;
const SECOND_RUNTIME = `${DIST}/server/chunks/other/[turbopack]_runtime.js`;
const ORDINARY = 'ctx=>{"use strict";ctx.v(42);}';
function source(
  file: string,
  code: string,
  imports: NodeManifestTurbopackGraphFile['imports'] = [],
): NodeManifestTurbopackGraphFile {
  return {
    id: file,
    file,
    source: { code, sha256: createHash('sha256').update(code).digest('hex') },
    imports,
  };
}
async function runtime(file: string): Promise<string> {
  return (await readFile(new URL('fixtures/node-runtime/production.txt', import.meta.url), 'utf8'))
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      () => `var RUNTIME_PUBLIC_PATH = ${jsLiteral(path.posix.relative(DIST, file))};`,
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
}
function boot(
  file: string,
  runtimeFile: string,
  tables: readonly string[],
  id: NodeManifestTurbopackModuleId,
): string {
  const required = jsLiteral(path.posix.relative(path.posix.dirname(file), runtimeFile));
  const chunks = tables
    .map((table) => `R.c(${jsLiteral(path.posix.relative(DIST, table))});`)
    .join('');
  return `var R=require(${required})(${jsLiteral(path.posix.relative(DIST, file))});${chunks}module.exports=R.m(${jsLiteral(id)}).exports;`;
}
async function fixture(
  options: {
    readonly callbacks?: readonly string[];
    readonly vectors?: readonly (readonly NodeManifestTurbopackModuleId[])[];
    readonly lookupOnly?: boolean;
    readonly secondRuntime?: boolean;
    readonly metadataCollision?: boolean;
  } = {},
) {
  const callbacks = options.callbacks ?? [ORDINARY, ORDINARY];
  const tables = callbacks.map((callback, index) => {
    const vector = options.vectors?.[index] ?? [7];
    const file = `${DIST}/server/chunks/table-${index}.js`;
    return source(
      file,
      `module.exports=[${vector.map((id) => jsLiteral(id)).join(',')},${callback}];`,
    );
  });
  const runtimeFiles = options.secondRuntime ? [RUNTIME, SECOND_RUNTIME] : [RUNTIME];
  const boots = tables.map((table, index) => {
    const file = `${DIST}/server/pages/page-${index}.js`;
    return source(file, boot(file, RUNTIME, [table.file], options.vectors?.[index]?.[0] ?? 7), [
      { specifier: '../chunks/[turbopack]_runtime.js', target: RUNTIME },
    ]);
  });
  if (options.secondRuntime) {
    const file = `${DIST}/server/pages/other.js`;
    const code = boot(
      file,
      SECOND_RUNTIME,
      tables.map((table) => table.file),
      7,
    );
    boots.push(
      source(file, code, [
        { specifier: '../chunks/other/[turbopack]_runtime.js', target: SECOND_RUNTIME },
      ]),
    );
  }
  const lookupOnly = options.lookupOnly
    ? [source(`${DIST}/server/chunks/lookup-only.js`, `module.exports=[99,${ORDINARY}];`)]
    : [];
  const sources = [...boots, ...tables, ...lookupOnly];
  if (options.metadataCollision) {
    sources.push({
      ...source(`${ROOT}/collision.js`, 'module.exports=42;'),
      id: JSON.stringify([RUNTIME, 'registration', 'turbopack:7']),
    });
  }
  for (const file of runtimeFiles) {
    const targets = [...[...tables, ...lookupOnly].map((table) => table.file), ...runtimeFiles];
    sources.push(
      source(
        file,
        await runtime(file),
        targets.map((target) => ({ specifier: target, target })),
      ),
    );
  }
  const profiles = boots.map((entry, index) => {
    return {
      file: entry.file,
      pathname: `/page-${index}`,
      kind: 'pages' as const,
      assetPrefix: '/',
    };
  });
  const inventory = await certifyNodeManifestRuntimeCallers({
    rootDir: ROOT,
    distDir: DIST,
    sources,
    entries: profiles.map((entry) => ({ id: entry.pathname, canonicalFilePath: entry.file })),
    routes: profiles,
    entryTraces: [],
    retained: new Set(sources.map((entry) => entry.id)),
  });
  const cohort = certifyNodeManifestRuntimeCohort({
    rootDir: ROOT,
    distDir: DIST,
    sources,
    profiles,
    inventory,
    requiredBoots: boots.map((entry) => entry.file),
  });
  const scope = createNodeManifestRegistrationScope(cohort, sources);
  const graph = (index = 0, grouped = true) => {
    const entry = boots[index];
    if (entry === undefined) throw new Error('Missing authored boot');
    return nodeManifestTurbopackBootGraph({
      distDir: DIST,
      sources,
      file: entry.file,
      runtimeCohort: cohort,
      registrationScope: grouped ? scope : undefined,
    });
  };
  return { sources, tables, boots, cohort, scope, graph };
}
function viewOf(own: Awaited<ReturnType<typeof fixture>>, graph = own.graph()) {
  assert.isDefined(graph.registrationIndex);
  return nodeManifestRegistrationView(graph.registrationIndex, own.sources);
}

describe('complete runtime-local registration alternatives', () => {
  it('retains both physical rows and permits a boot whose only table is not the first member', async () => {
    const own = await fixture();
    const first = own.graph(0);
    const second = own.graph(1);
    const view = viewOf(own, first);
    const registration = view.registrations[0];
    assert.isDefined(registration);

    expect(view.rows).toHaveLength(2);
    expect(new Set(view.rows.map((row) => row.physicalId))).toStrictEqual(
      new Set(own.tables.map((table) => table.id)),
    );
    expect(registration.members).toHaveLength(2);
    expect(first.exportedId).toBe(registration.id);
    expect(second.exportedId).toBe(registration.id);
    expect(first.registrationIndex).toBe(second.registrationIndex);
    expect(first.initialChunks).not.toStrictEqual(second.initialChunks);
  });

  it('does not permit an installed group without an actual member in the current initial table set', async () => {
    const own = await fixture();
    const graph = own.graph();
    assert.isDefined(graph.registrationIndex);

    expect(() =>
      nodeManifestInitialRegistration(graph.registrationIndex, own.sources, 7, new Set()),
    ).toThrow('not initially registered');
  });

  it('preserves the complete typed merged vector rather than sharing number/string keys', async () => {
    const own = await fixture({
      vectors: [
        [7, '7'],
        [7, '7'],
      ],
    });
    const view = viewOf(own);

    expect(view.rows).toHaveLength(4);
    expect(view.registrations.map((registration) => registration.moduleId)).toStrictEqual([7, '7']);
    expect(new Set(view.registrations.map((registration) => registration.id)).size).toBe(2);
    expect(view.registrations.every((registration) => registration.members.length === 2)).toBe(
      true,
    );
  });

  it('keeps the previous strict duplicate refusal when no prepare-local grouping scope is present', async () => {
    const own = await fixture();

    expect(() => own.graph(0, false)).toThrow('duplicate module id across loaded chunks');
  });

  it.each([
    [[7, 8], [7]],
    [
      [7, '7'],
      ['7', 7],
    ],
  ])(
    'refuses partial or permuted vectors before accepting a successful subset: %j',
    async (...vectors) => {
      const own = await fixture({ vectors });

      expect(() => own.graph()).toThrow('duplicate module id across loaded chunks');
    },
  );

  it('does not hide a conflicting third physical occurrence behind a matching pair', async () => {
    const own = await fixture({
      callbacks: [ORDINARY, ORDINARY, 'ctx=>{"use strict";ctx.v(43);}'],
    });

    expect(() => own.graph()).toThrow('uncertified duplicate module registration');
  });

  it('audits every body before returning a duplicate group', async () => {
    const own = await fixture({
      callbacks: [ORDINARY, 'ctx=>{"use strict";ctx.v(ctx.unknown());}'],
    });
    const runtimeSource = own.sources.find((item) => item.id === RUNTIME);
    assert.isDefined(runtimeSource);

    expect(() => {
      return nodeManifestRegistrationIndex({
        distDir: DIST,
        runtime: runtimeSource,
        sources: own.sources,
        tables: own.tables,
        cohort: own.cohort,
        scope: own.scope,
      });
    }).toThrow('manifest diagnostics');
  });

  it.each([
    'ctx=>{ctx.v(42);}',
    'ctx=>{"use strict";ctx.v(__filename);}',
    'ctx=>{"use strict";ctx.v({loadChunk:ctx.l.bind(ctx)});}',
  ])(
    'retains strict/ambient/bound refusals for any unsupported occurrence: %s',
    async (callback) => {
      const own = await fixture({ callbacks: [callback, callback] });

      expect(() => own.graph()).toThrow(/uncertified duplicate|manifest diagnostics/u);
    },
  );

  it('does not turn helper lookup availability into installed static dependency authority', async () => {
    const callback = 'ctx=>{"use strict";ctx.v(ctx.i(99));}';
    const own = await fixture({ callbacks: [callback, callback], lookupOnly: true });

    expect(() => own.graph()).toThrow('unregistered module dependency');
  });

  it('keeps lookup-only tables out of installed rows without dropping physical lookup inventory', async () => {
    const own = await fixture({ lookupOnly: true });
    const graph = own.graph();
    const view = viewOf(own, graph);

    expect(view.registrations.map((registration) => registration.moduleId)).toStrictEqual([7]);
    expect(view.rows.some((row) => row.physicalId.endsWith('lookup-only.js'))).toBe(false);
    expect(graph.lookupTables?.some((id) => id.endsWith('lookup-only.js'))).toBe(true);
  });

  it.each(['added', 'removed'] as const)(
    'rejects a supplied installed table inventory with a table %s',
    async (change) => {
      const own = await fixture({ lookupOnly: true });
      const runtimeSource = own.sources.find((item) => item.id === RUNTIME);
      const lookup = own.sources.find((item) => item.file.endsWith('/lookup-only.js'));
      assert.isDefined(runtimeSource);
      assert.isDefined(lookup);
      const tables = change === 'added' ? [...own.tables, lookup] : own.tables.slice(1);

      expect(() => {
        return nodeManifestRegistrationIndex({
          distDir: DIST,
          runtime: runtimeSource,
          sources: own.sources,
          tables,
          cohort: own.cohort,
          scope: own.scope,
        });
      }).toThrow('registration installed table mismatch');
    },
  );

  it('uses independent groups when the same physical tables install into two reviewed runtime Maps', async () => {
    const own = await fixture({ secondRuntime: true });
    const first = own.graph(0);
    const second = own.graph(2);

    expect(first.registrationIndex).not.toBe(second.registrationIndex);
    expect(first.exportedId).not.toBe(second.exportedId);
    expect(viewOf(own, first).rows.map((row) => row.physicalId)).toStrictEqual(
      viewOf(own, second).rows.map((row) => row.physicalId),
    );
  });

  it('rejects copied indexes and same-content replacement source arrays', async () => {
    const own = await fixture();
    const graph = own.graph();
    assert.isDefined(graph.registrationIndex);

    expect(() => nodeManifestRegistrationView({ ...graph.registrationIndex }, own.sources)).toThrow(
      'stale registration index',
    );
    expect(() => nodeManifestRegistrationView(graph.registrationIndex, [...own.sources])).toThrow(
      'stale registration index',
    );
  });

  it('rejects an actual source ID claiming a logical group metadata key', async () => {
    const own = await fixture({ metadataCollision: true });

    expect(() => own.graph()).toThrow('factory metadata identity collision');
  });

  it('invalidates an index when original source or actual import edges change', async () => {
    const own = await fixture();
    const graph = own.graph();
    assert.isDefined(graph.registrationIndex);
    const table = own.tables[0];
    assert.isDefined(table);
    Object.assign(table, { imports: [{ specifier: 'changed', target: 'changed' }] });

    expect(() => nodeManifestRegistrationView(graph.registrationIndex, own.sources)).toThrow(
      'stale registration index',
    );
  });
});
