import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assert, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { AuditError } from '../src/dependencies.ts';
import {
  certifyNodeManifestRegistrationGroup,
  nodeManifestRegistrationGroup,
} from '../src/node-manifest-registration-group.ts';
import {
  assertNodeManifestPassSingle,
  nodeManifestPassMembers,
  nodeManifestPassTouchesProtected,
  withNodeManifestRegistrationPass,
} from '../src/node-manifest-registration-pass.ts';
import { createNodeManifestRegistrationScope } from '../src/node-manifest-registration-registry.ts';
import {
  assertNodeManifestSingleRegistration,
  createNodeManifestRegistrationViews,
  nodeManifestRegistrationProofFiles,
  nodeManifestRegistrationTouchesProtected,
} from '../src/node-manifest-registration-views.ts';
import { certifyNodeManifestRuntimeCallers } from '../src/node-manifest-runtime-callers.ts';
import { certifyNodeManifestRuntimeCohort } from '../src/node-manifest-runtime-cohort.ts';
import {
  nodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackGraphFile,
} from '../src/node-manifest-turbopack-graph.ts';
import { nodeManifestTurbopackFactories } from '../src/node-manifest-turbopack.ts';
import { manifestTemplateSource as source } from './fixtures/node-manifest-turbopack-template.ts';

const ROOT = '/project';
const DIST = `${ROOT}/.next`;
const ENTRY = `${DIST}/server/pages/native.js`;
const RUNTIME = `${DIST}/server/chunks/runtime.js`;
const TABLES = ['one', 'two', 'target'].map((name) => `${DIST}/server/chunks/${name}.js`);
const TARGET = '2,ctx=>{"use strict";ctx.v(42);},"2",ctx=>{"use strict";ctx.v(43);}';
interface Options {
  readonly ids?: readonly (number | string)[];
  readonly target?: string;
  readonly imports?: readonly [
    NodeManifestTurbopackGraphFile['imports'],
    NodeManifestTurbopackGraphFile['imports'],
  ];
  readonly extra?: readonly NodeManifestTurbopackGraphFile[];
}
async function fixture(callbacks: readonly [string, string], options: Options = {}) {
  const vector = (options.ids ?? [1]).map((id) => jsLiteral(id)).join(',');
  const tables = TABLES.map((file, index) => {
    return {
      id: file,
      file,
      source: source(
        index === 2
          ? `module.exports=[${options.target ?? TARGET}];`
          : `module.exports=[${vector},${callbacks[index]}];`,
      ),
      imports: index === 2 ? [] : (options.imports?.[index] ?? []),
    };
  });
  const runtimeSource = await readFile(
    new URL('fixtures/node-runtime/production.txt', import.meta.url),
    'utf8',
  );
  const runtime: NodeManifestTurbopackGraphFile = {
    id: RUNTIME,
    file: RUNTIME,
    source: source(
      runtimeSource
        .replace(
          'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
          'var RUNTIME_PUBLIC_PATH = "server/chunks/runtime.js";',
        )
        .replace(
          'var RELATIVE_ROOT_PATH = "../../../../../../..";',
          'var RELATIVE_ROOT_PATH = "..";',
        ),
    ),
    imports: [RUNTIME, ...TABLES].map((target) => ({ specifier: target, target })),
  };
  const loading = TABLES.map((file) => `R.c(${jsLiteral(path.posix.relative(DIST, file))});`).join(
    '',
  );
  const entry: NodeManifestTurbopackGraphFile = {
    id: ENTRY,
    file: ENTRY,
    source: source(
      `var R=require('../chunks/runtime.js')('server/pages/native.js');${loading}module.exports=R.m(1).exports;`,
    ),
    imports: [{ specifier: '../chunks/runtime.js', target: RUNTIME }],
  };
  const sources = [entry, runtime, ...tables, ...(options.extra ?? [])];
  const profiles = [{ file: ENTRY, kind: 'pages' as const, pathname: '/native', assetPrefix: '/' }];
  const inventory = await certifyNodeManifestRuntimeCallers({
    rootDir: ROOT,
    distDir: DIST,
    sources,
    entries: [{ id: '/native', canonicalFilePath: ENTRY }],
    routes: profiles,
    entryTraces: [],
    retained: new Set(sources.map((item) => item.id)),
  });
  const cohort = certifyNodeManifestRuntimeCohort({
    rootDir: ROOT,
    distDir: DIST,
    sources,
    profiles,
    inventory,
    requiredBoots: [ENTRY],
  });
  const occurrences = tables.slice(0, 2).map((physical) => {
    const factory = nodeManifestTurbopackFactories(physical.source)[0];
    if (factory === undefined) throw new Error('Missing authored factory');
    return { physical, factory };
  });
  const input = {
    owner: Object.freeze({ identity: Symbol('forwarding build') }),
    cohort,
    runtime,
    sources,
    occurrences,
  };
  return { input, tables };
}
function checked(input: Awaited<ReturnType<typeof fixture>>['input']) {
  const proof = certifyNodeManifestRegistrationGroup(input);
  if (proof === undefined) throw new Error('Expected an independently proved forwarding group');
  return { proof, group: nodeManifestRegistrationGroup(proof, input) };
}
function namespace(method: string, imported: string, strict: boolean): string {
  return `ctx=>{${strict ? '"use strict";' : ''}const ns=${imported};ctx.${method}(ns);}`;
}
function commonjs(imported: string, strict: boolean): string {
  return `(ctx,module,exports)=>{${strict ? '"use strict";' : ''}module.exports=${imported};}`;
}
function external(mode = ''): string {
  return `ctx.x('node:path',()=>require('node:path')${mode})`;
}
function graph(input: Awaited<ReturnType<typeof fixture>>['input']) {
  return nodeManifestTurbopackBootGraph({
    distDir: DIST,
    sources: input.sources,
    file: ENTRY,
    runtimeCohort: input.cohort,
    registrationScope: createNodeManifestRegistrationScope(input.cohort, input.sources),
  });
}

describe('finite independently checked registration forwarders', () => {
  it.each([
    ['n', 'ctx.i(2)'],
    ['n', 'ctx.r(2)'],
    ['v', 'ctx.i(2)'],
    ['v', 'ctx.r(2)'],
    ['n', external()],
    ['v', external(',true')],
  ])(
    'keeps both physical %s(%s) variants while permitting unobservable strictness differences',
    async (method, imported) => {
      const edges = [{ specifier: 'node:path', target: 'node:path' }];
      const own = await fixture(
        [namespace(method, imported, true), namespace(method, imported, false)],
        { imports: [edges, edges], ids: [1, '1'] },
      );
      const result = checked(own.input).group;

      expect(result?.occurrences).toHaveLength(2);
      expect(result?.occurrences.map((item) => item.factory.ids)).toStrictEqual([
        [1, '1'],
        [1, '1'],
      ]);
      expect(
        result?.occurrences.map((item) => item.projections.map((value) => value.exports.kind)),
      ).toStrictEqual([
        ['namespace', 'namespace'],
        ['namespace', 'namespace'],
      ]);
      expect(result?.occurrences.map((item) => item.projections[0]?.original.code)).toStrictEqual(
        own.tables.slice(0, 2).map((table) => table.source.code),
      );
    },
  );

  it.each(['ctx.r(2)', external(), external(',false'), external(',true')])(
    'proves only a direct mutable compiler module exports assignment: %s',
    async (imported) => {
      const edges = [{ specifier: 'node:path', target: 'node:path' }];
      const own = await fixture([commonjs(imported, true), commonjs(imported, false)], {
        imports: [edges, edges],
      });
      const result = checked(own.input).group;

      expect(result?.occurrences.map((item) => item.projections[0]?.exports.kind)).toStrictEqual([
        'commonjs',
        'commonjs',
      ]);
    },
  );

  it('uses only the pinned runtime default false interop equivalence', async () => {
    const edges = [{ specifier: 'node:path', target: 'node:path' }];
    const own = await fixture([commonjs(external(), false), commonjs(external(',false'), true)], {
      imports: [edges, edges],
    });

    expect(checked(own.input).group?.occurrences).toHaveLength(2);
  });

  it.each([
    [namespace('n', 'ctx.i(2)', true), namespace('v', 'ctx.i(2)', false)],
    [namespace('n', 'ctx.i(2)', true), namespace('n', 'ctx.r(2)', false)],
    [commonjs('ctx.r(2)', true), commonjs('ctx.r("2")', false)],
    [commonjs(external(',true'), true), commonjs(external(',false'), false)],
  ])('declines different export, typed target or interop contracts', async (first, second) => {
    const edges = [{ specifier: 'node:path', target: 'node:path' }];
    const own = await fixture([first, second], { imports: [edges, edges] });

    expect(certifyNodeManifestRegistrationGroup(own.input)).toBeUndefined();
  });

  it.each([
    commonjs('ctx.i(2)', true),
    commonjs('ctx.r(2).value', true),
    commonjs('{value:ctx.r(2)}', true),
    '(ctx,module,exports)=>{"use strict";const ns=ctx.r(2);module.exports=ns;}',
    '(ctx,module,exports)=>{"use strict";module.exports=ctx.r(2);void 0;}',
    '(ctx,module,exports)=>{"use strict";module.exports=ctx.r(2);void this;}',
    '(ctx,module,exports)=>{"use strict";module.exports=ctx.r(2);void arguments;}',
    commonjs('ctx.r(2).name', true),
    commonjs('ctx.r(2).toString()', true),
    commonjs("Reflect.get(ctx.r(2),'value')", true),
    commonjs('new Proxy(ctx.r(2),{})', true),
  ])(
    'does not broaden CommonJS identity to picking, wrappers, aliases, effects or metadata: %s',
    async (callback) => {
      const own = await fixture([callback, callback]);

      expect(certifyNodeManifestRegistrationGroup(own.input)).toBeUndefined();
    },
  );

  it('retains the reader refusal for named factory metadata', async () => {
    const callback = 'function named(ctx,module,exports){"use strict";module.exports=ctx.r(2);}';

    await expect(fixture([callback, callback])).rejects.toThrow('factory shape');
  });

  it.each([
    commonjs('ctx.r?.(2)', true),
    commonjs('ctx.r(1+1)', true),
    commonjs('ctx.r.call(ctx,2)', true),
    commonjs('ctx.r.apply(ctx,[2])', true),
    commonjs('ctx.r.bind(ctx)(2)', true),
    '(ctx,module,exports)=>{"use strict";ctx.r=()=>0;module.exports=ctx.r(2);}',
  ])('preserves fail-closed original context validation for %s', async (callback) => {
    const own = await fixture([callback, callback]);

    expect(() => certifyNodeManifestRegistrationGroup(own.input)).toThrow(AuditError);
  });

  it('retains the old privileged external Next dependency refusal and exact actual-target comparison', async () => {
    const name = '/project/node_modules/next/dist/server/route-modules/pages/module.compiled.js';
    const target = { id: name, file: name, source: source('module.exports={};'), imports: [] };
    const callback = commonjs("ctx.x('dep',()=>require('dep'))", true);
    const own = await fixture([callback, callback], {
      imports: [[{ specifier: 'dep', target: name }], [{ specifier: 'dep', target: name }]],
      extra: [target],
    });
    const wrong = await fixture([commonjs(external(), true), commonjs(external(), false)], {
      imports: [
        [{ specifier: 'node:path', target: 'node:path' }],
        [{ specifier: 'node:path', target: 'node:fs' }],
      ],
    });

    expect(certifyNodeManifestRegistrationGroup(own.input)).toBeUndefined();
    expect(certifyNodeManifestRegistrationGroup(wrong.input)).toBeUndefined();
  });

  it('binds every forwarding occurrence to current source/runtime/cohort and records all physical proof files', async () => {
    const callback = namespace('n', 'ctx.i(2)', true);
    const own = await fixture([callback, callback]);
    const { proof } = checked(own.input);
    const runtimeGraph = graph(own.input);
    const views = createNodeManifestRegistrationViews([runtimeGraph], own.input.sources);

    expect(
      nodeManifestRegistrationProofFiles([runtimeGraph], own.input.sources, undefined),
    ).toHaveLength(own.input.sources.length);
    expect(() => {
      assertNodeManifestSingleRegistration(views, runtimeGraph.exportedId);
    }).toThrow('grouped protected identity unsupported');

    Object.assign(own.tables[0]?.source ?? {}, source(`${own.tables[0]?.source.code}\n`));

    expect(nodeManifestRegistrationGroup(proof, own.input)).toBeUndefined();
  });

  it('allows a genuine grouped-forwarder DAG to converge while retaining protected descendant detection', async () => {
    const callback = namespace('n', 'ctx.i(2)', true);
    const own = await fixture([callback, callback], {
      target: `2,${namespace('n', 'ctx.i(3)', true)},3,ctx=>{"use strict";ctx.v(42);}`,
    });
    const runtimeGraph = graph(own.input);
    const views = createNodeManifestRegistrationViews([runtimeGraph], own.input.sources);
    const leaf = runtimeGraph.factories.find((row) => row.projection.moduleId === 3);
    assert(leaf !== undefined, 'Missing authored leaf');

    expect(
      nodeManifestRegistrationTouchesProtected(views, runtimeGraph.exportedId, new Map()),
    ).toBe(false);
    expect(
      nodeManifestRegistrationTouchesProtected(
        views,
        runtimeGraph.exportedId,
        new Map([[leaf.id, 'route']]),
      ),
    ).toBe(true);

    withNodeManifestRegistrationPass(views, (pass) => {
      expect(nodeManifestPassMembers(pass, runtimeGraph.exportedId)).toHaveLength(2);
      expect(nodeManifestPassTouchesProtected(pass, runtimeGraph.exportedId, new Map())).toBe(
        false,
      );
      expect(
        nodeManifestPassTouchesProtected(
          pass,
          runtimeGraph.exportedId,
          new Map([[leaf.id, 'route']]),
        ),
      ).toBe(true);
      expect(() => {
        assertNodeManifestPassSingle(pass, runtimeGraph.exportedId);
      }).toThrow('grouped protected identity unsupported');
    });
  });

  it('still refuses a genuine group-to-singleton-to-group forwarding cycle', async () => {
    const callback = namespace('n', 'ctx.i(2)', true);
    const own = await fixture([callback, callback], {
      target: `2,${namespace('n', 'ctx.i(1)', true)}`,
    });
    const runtimeGraph = graph(own.input);
    const views = createNodeManifestRegistrationViews([runtimeGraph], own.input.sources);

    expect(() =>
      nodeManifestRegistrationTouchesProtected(views, runtimeGraph.exportedId, new Map()),
    ).toThrow('cyclic namespace forwarding');

    expect(() => {
      withNodeManifestRegistrationPass(views, (pass) => {
        nodeManifestPassTouchesProtected(pass, runtimeGraph.exportedId, new Map());
      });
    }).toThrow('cyclic namespace forwarding');
  });
});
