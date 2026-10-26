import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import {
  certifyNodeManifestRegistrationGroup,
  nodeManifestRegistrationGroup,
  type NodeManifestRegistrationGroupInput,
} from '../src/node-manifest-registration-group.ts';
import { certifyNodeManifestRuntimeCallers } from '../src/node-manifest-runtime-callers.ts';
import { certifyNodeManifestRuntimeCohort } from '../src/node-manifest-runtime-cohort.ts';
import type { NodeManifestTurbopackGraphFile } from '../src/node-manifest-turbopack-graph.ts';
import { nodeManifestTurbopackFactories } from '../src/node-manifest-turbopack.ts';
import { manifestTemplateSource as source } from './fixtures/node-manifest-turbopack-template.ts';

const ROOT = '/project';
const DIST = `${ROOT}/.next`;
const ENTRY = `${DIST}/server/pages/native.js`;
const RUNTIME = `${DIST}/server/chunks/runtime.js`;
const TABLES = [`${DIST}/server/chunks/one.js`, `${DIST}/server/chunks/two.js`];
const ORDINARY = 'ctx=>{"use strict";const value=42;ctx.v(value);}';
interface Options {
  readonly callbacks?: readonly [string, string];
  readonly ids?: readonly [readonly (number | string)[], readonly (number | string)[]];
  readonly prefixes?: readonly [string, string];
  readonly wrappers?: readonly [boolean, boolean];
  readonly imports?: readonly [
    NodeManifestTurbopackGraphFile['imports'],
    NodeManifestTurbopackGraphFile['imports'],
  ];
  readonly extra?: readonly NodeManifestTurbopackGraphFile[];
}
async function fixture(options: Options = {}): Promise<NodeManifestRegistrationGroupInput> {
  const callbacks = options.callbacks ?? [ORDINARY, ORDINARY];
  const ids = options.ids ?? [[1], [1]];
  const tables = TABLES.map((file, index) => {
    const registration = `${options.prefixes?.[index] ?? ''}module.exports=[${(ids[index] ?? []).map((id) => jsLiteral(id)).join(',')},${callbacks[index]}];`;
    return {
      id: file,
      file,
      source: source(
        options.wrappers?.[index] === true
          ? `(()=>{"use strict";${registration}})();`
          : registration,
      ),
      imports: options.imports?.[index] ?? [],
    };
  });
  const runtimeCode = (
    await readFile(new URL('fixtures/node-runtime/production.txt', import.meta.url), 'utf8')
  )
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      () => `var RUNTIME_PUBLIC_PATH = ${jsLiteral(path.posix.relative(DIST, RUNTIME))};`,
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
  const runtime: NodeManifestTurbopackGraphFile = {
    id: RUNTIME,
    file: RUNTIME,
    source: source(runtimeCode),
    imports: [RUNTIME, ...TABLES].map((target) => ({ specifier: target, target })),
  };
  const entry: NodeManifestTurbopackGraphFile = {
    id: ENTRY,
    file: ENTRY,
    source: source(
      `var R=require('../chunks/runtime.js')('server/pages/native.js');R.c('server/chunks/two.js');module.exports=R.m(1).exports;`,
    ),
    imports: [{ specifier: '../chunks/runtime.js', target: RUNTIME }],
  };
  const sources = [entry, runtime, ...tables, ...(options.extra ?? [])];
  const profiles = [{ file: ENTRY, pathname: '/native', kind: 'pages' as const, assetPrefix: '/' }];
  const inventory = await certifyNodeManifestRuntimeCallers({
    rootDir: ROOT,
    distDir: DIST,
    entries: [{ id: '/native', canonicalFilePath: ENTRY }],
    routes: profiles,
    entryTraces: [],
    sources,
    retained: new Set(sources.map((item) => item.id)),
  });
  const cohort = certifyNodeManifestRuntimeCohort({
    inventory,
    profiles,
    requiredBoots: [ENTRY],
    sources,
    rootDir: ROOT,
    distDir: DIST,
  });
  return {
    owner: Object.freeze({ identity: Symbol('build') }),
    cohort,
    runtime,
    sources,
    occurrences: tables.map((physical) => {
      const factory = nodeManifestTurbopackFactories(physical.source)[0];
      if (factory === undefined) throw new Error('missing authored registration');
      return { physical, factory };
    }),
  };
}
function certificate(input: NodeManifestRegistrationGroupInput) {
  const proof = certifyNodeManifestRegistrationGroup(input);
  if (proof === undefined) throw new Error('expected authored group');
  return proof;
}
function checked(input: NodeManifestRegistrationGroupInput) {
  return nodeManifestRegistrationGroup(certificate(input), input);
}
function firstOccurrence(input: NodeManifestRegistrationGroupInput) {
  const first = input.occurrences[0];
  if (first === undefined) throw new Error('authored first occurrence');
  return first;
}
function mutate(kind: 'source' | 'range' | 'edge', input: NodeManifestRegistrationGroupInput) {
  const first = firstOccurrence(input);
  switch (kind) {
    case 'source': {
      Object.assign(first.physical.source, source(`${first.physical.source.code}\n`));
      break;
    }
    case 'range': {
      Object.assign(first.factory, { end: first.factory.end - 1 });
      break;
    }
    case 'edge': {
      Object.assign(first.physical.imports[0] ?? {}, { target: 'node:fs' });
      break;
    }
  }
}
function external(specifier = 'node:path', interop = ''): string {
  return `ctx=>{"use strict";const ns=ctx.x(${jsLiteral(specifier)},()=>require(${jsLiteral(specifier)})${interop});ctx.v(ns.basename('x'));}`;
}

describe('runtime-local original registration equality', () => {
  it('retains both physical occurrences even when only the second table is initially loaded', async () => {
    const input = await fixture({ prefixes: ['', '/* another physical table */'] });
    const result = checked(input);

    expect(result?.occurrences.map((item) => item.physicalId)).toStrictEqual(TABLES);
    expect(result?.occurrences.map((item) => item.sha256)).not.toStrictEqual([
      input.occurrences[0]?.physical.source.sha256,
      input.occurrences[0]?.physical.source.sha256,
    ]);
    expect(input.cohort.boots[0]?.chunks).toStrictEqual(['server/chunks/two.js']);
    expect(result?.occurrences.map((item) => item.projections.length)).toStrictEqual([1, 1]);
  });

  it('keeps the full ordered typed registration vector and every selected projection', async () => {
    const input = await fixture({
      ids: [
        [1, '1'],
        [1, '1'],
      ],
    });
    const result = checked(input);

    expect(result?.occurrences.map((item) => item.factory.ids)).toStrictEqual([
      [1, '1'],
      [1, '1'],
    ]);
    expect(
      result?.occurrences.map((item) => item.projections.map((projection) => projection.moduleId)),
    ).toStrictEqual([
      [1, '1'],
      [1, '1'],
    ]);
    expect(Object.isFrozen(result?.occurrences[0]?.projections[0]?.imports)).toBe(true);
    expect(Object.isFrozen(input.occurrences[0]?.physical)).toBe(false);
  });

  it.each([
    ['', ''],
    ['"use strict";', ''],
    ['', '"use strict";'],
  ])('declines callbacks without genuine effective strictness (%s,%s)', async (first, second) => {
    const callback = 'ctx=>{ctx.v(42);}';
    const input = await fixture({ callbacks: [callback, callback], prefixes: [first, second] });

    expect(certifyNodeManifestRegistrationGroup(input)).toBeUndefined();
  });

  it('accepts genuine enclosing directives without inventing strictness from module parsing', async () => {
    const callback = 'ctx=>{ctx.v(42);}';

    expect(
      checked(
        await fixture({
          callbacks: [callback, callback],
          prefixes: ['"use strict";', '"use strict";'],
        }),
      )?.occurrences,
    ).toHaveLength(2);
  });

  it('recognizes the fixed strict wrapper while retaining each original callback range', async () => {
    const callback = 'ctx=>{ctx.v(42);}';
    const input = await fixture({
      callbacks: [callback, callback],
      wrappers: [true, false],
      prefixes: ['', '"use strict";'],
    });
    const result = checked(input);

    expect(result?.occurrences).toHaveLength(2);
    expect(result?.occurrences[0]?.factory.start).not.toBe(result?.occurrences[1]?.factory.start);
  });

  it.each([
    'ctx=>{("not a directive");"use strict";ctx.v(42);}',
    'ctx=>{`not a directive`;"use strict";ctx.v(42);}',
    'ctx=>{("use strict");ctx.v(42);}',
    String.raw`ctx=>{"use\x20strict";ctx.v(42);}`,
  ])('declines lookalike directive prologues: %s', async (callback) => {
    expect(
      certifyNodeManifestRegistrationGroup(await fixture({ callbacks: [callback, callback] })),
    ).toBeUndefined();
  });

  it.each([
    ['ctx=>{"use strict";ctx.v(42);}', 'ctx=>{"use strict";/* changed */ctx.v(42);}'],
    ['ctx=>{"use strict";const x=42;ctx.v(x);}', 'ctx=>{"use strict";const y=42;ctx.v(y);}'],
  ])('does not use alpha or inspection equivalence', async (first, second) => {
    expect(
      certifyNodeManifestRegistrationGroup(await fixture({ callbacks: [first, second] })),
    ).toBeUndefined();
  });

  it.each([
    [
      [1, '1'],
      ['1', 1],
    ],
    [[1, '1'], [1]],
    [[1], ['1']],
    [[1], [1, 2]],
  ] as const)('declines partial or different typed registration vectors', async (first, second) => {
    expect(
      certifyNodeManifestRegistrationGroup(await fixture({ ids: [first, second] })),
    ).toBeUndefined();
  });

  it('compares actual builtin import and interop modes after proving only the literal thunk capture', async () => {
    const edge = [{ specifier: 'node:path', target: 'node:path' }];
    const input = await fixture({ callbacks: [external(), external()], imports: [edge, edge] });
    const mismatch = await fixture({
      callbacks: [external(), external('node:path', ',true')],
      imports: [edge, edge],
    });

    expect(checked(input)?.occurrences[0]?.dependencies).toHaveLength(1);
    expect(certifyNodeManifestRegistrationGroup(mismatch)).toBeUndefined();
  });

  it('requires the exact current resolved external target and SHA in every occurrence', async () => {
    const callback = external('dep');
    const a = {
      id: '/project/dep-a.js',
      file: '/project/dep-a.js',
      source: source('module.exports={basename:() => "a"};'),
      imports: [],
    };
    const b = {
      id: '/project/dep-b.js',
      file: '/project/dep-b.js',
      source: source('module.exports={basename:() => "b"};'),
      imports: [],
    };
    const edge = [{ specifier: 'dep', target: a.id }];

    expect(
      checked(await fixture({ callbacks: [callback, callback], imports: [edge, edge], extra: [a] }))
        ?.occurrences,
    ).toHaveLength(2);
    expect(
      certifyNodeManifestRegistrationGroup(
        await fixture({
          callbacks: [callback, callback],
          imports: [edge, [{ specifier: 'dep', target: b.id }]],
          extra: [a, b],
        }),
      ),
    ).toBeUndefined();
    expect(
      certifyNodeManifestRegistrationGroup(
        await fixture({ callbacks: [callback, callback], imports: [edge, []], extra: [a] }),
      ),
    ).toBeUndefined();

    const tampered = await fixture({
      callbacks: [callback, callback],
      imports: [edge, edge],
      extra: [a],
    });
    Object.assign(a.source, { code: 'tampered' });

    expect(certifyNodeManifestRegistrationGroup(tampered)).toBeUndefined();
  });

  it('requires internal static IDs to exist in the same actual runtime lookup inventory', async () => {
    const callback = 'ctx=>{"use strict";ctx.v(ctx.i(1));}';

    expect(checked(await fixture({ callbacks: [callback, callback] }))?.occurrences).toHaveLength(
      2,
    );

    const unknown = 'ctx=>{"use strict";ctx.v(ctx.i(99));}';

    expect(
      certifyNodeManifestRegistrationGroup(await fixture({ callbacks: [unknown, unknown] })),
    ).toBeUndefined();
  });

  it('declines direct protected framework imports and never creates a class or route approval', async () => {
    const callback = external('next-runtime');
    const target = '/project/node_modules/next/dist/compiled/next-server/pages.runtime.prod.js';
    const edge = [{ specifier: 'next-runtime', target }];
    const input = await fixture({
      callbacks: [callback, callback],
      imports: [edge, edge],
      extra: [{ id: target, file: target, source: source('module.exports={};'), imports: [] }],
    });

    expect(certifyNodeManifestRegistrationGroup(input)).toBeUndefined();
  });

  it.each([
    'ctx=>{"use strict";ctx.v(__dirname);}',
    'ctx=>{"use strict";ctx.v(__filename);}',
    'ctx=>{"use strict";ctx.v(arguments);}',
    'ctx=>{"use strict";ctx.v(this);}',
    'ctx=>{"use strict";ctx.v(import.meta);}',
    'ctx=>{"use strict";ctx.v(globalThis);}',
    'ctx=>{"use strict";ctx.v(require.resolve("dep"));}',
    'ctx=>{"use strict";const loader=require;ctx.v(loader("dep"));}',
  ])('does not certify free lexical/receiver/loader capture: %s', async (callback) => {
    const input = await fixture({ callbacks: [callback, callback] });

    expect(certifyNodeManifestRegistrationGroup(input)).toBeUndefined();
  });

  it('preserves local and nested shadow identities inside the callback', async () => {
    const callback =
      'ctx=>{"use strict";const outer=42;function f(value){return value+outer;}ctx.v(f(1));}';

    expect(checked(await fixture({ callbacks: [callback, callback] }))?.occurrences).toHaveLength(
      2,
    );
  });

  it.each([
    'ctx=>{"use strict";ctx.s(["x",0,42],99);ctx.v(42);}',
    'ctx=>{"use strict";function f(value){return 42;}ctx.v(f({require:ctx.r.bind(ctx)}));}',
    'ctx=>{"use strict";const ns=ctx.i(1);ctx.n(ns);}',
  ])(
    'declines cache/bound/namespace families pending separate per-variant conjunctions',
    async (callback) => {
      expect(
        certifyNodeManifestRegistrationGroup(await fixture({ callbacks: [callback, callback] })),
      ).toBeUndefined();
    },
  );

  it('propagates failed ordinary projection instead of using a successful variant', async () => {
    const broken = 'ctx=>{"use strict";ctx.v(ctx.unknown());}';
    const inputWithBroken = await fixture({ callbacks: [ORDINARY, broken] });

    expect(() => certifyNodeManifestRegistrationGroup(inputWithBroken)).toThrow(
      'unreviewed context method',
    );
  });

  it('rejects copied tokens and same-source/same-scope proof borrowing across owner or runtime', async () => {
    const input = await fixture();
    const proof = certificate(input);

    expect(nodeManifestRegistrationGroup({ ...proof }, input)).toBeUndefined();
    expect(
      nodeManifestRegistrationGroup(proof, { ...input, owner: { identity: input.owner.identity } }),
    ).toBeUndefined();

    const another = await fixture();

    expect(
      nodeManifestRegistrationGroup(proof, { ...another, owner: input.owner }),
    ).toBeUndefined();
    expect(
      nodeManifestRegistrationGroup(proof, { ...input, runtime: { ...input.runtime } }),
    ).toBeUndefined();
  });

  it('rechecks pointer provenance even when replacement objects contain identical bytes', async () => {
    const input = await fixture();
    const proof = certificate(input);

    expect(
      nodeManifestRegistrationGroup(proof, { ...input, sources: [...input.sources] }),
    ).toBeUndefined();
    expect(
      nodeManifestRegistrationGroup(proof, {
        ...input,
        occurrences: input.occurrences.map((item) => ({ ...item })),
      }),
    ).toBeUndefined();

    const first = firstOccurrence(input);
    Object.assign(first.physical, { source: { ...first.physical.source } });

    expect(nodeManifestRegistrationGroup(proof, input)).toBeUndefined();
  });

  it('declines forged cohorts, missing lookup provenance and repeated occurrence rows', async () => {
    const input = await fixture();
    const first = firstOccurrence(input);

    expect(() =>
      certifyNodeManifestRegistrationGroup({ ...input, cohort: { ...input.cohort } }),
    ).toThrow('uncertified cohort');
    expect(
      certifyNodeManifestRegistrationGroup({ ...input, occurrences: [first, first] }),
    ).toBeUndefined();
    expect(
      certifyNodeManifestRegistrationGroup({ ...input, occurrences: [first] }),
    ).toBeUndefined();

    const changed = {
      ...input.runtime,
      imports: input.runtime.imports.filter((edge) => edge.target !== first.physical.id),
    };

    expect(certifyNodeManifestRegistrationGroup({ ...input, runtime: changed })).toBeUndefined();
  });

  it.each(['source', 'range', 'edge'] as const)(
    'invalidates a stale certificate after current %s changes',
    async (kind) => {
      const callback = external();
      const edge = [{ specifier: 'node:path', target: 'node:path' }];
      const input = await fixture({ callbacks: [callback, callback], imports: [edge, edge] });
      const proof = certificate(input);
      mutate(kind, input);

      expect(nodeManifestRegistrationGroup(proof, input)).toBeUndefined();
    },
  );
});
