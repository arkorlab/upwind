import { readFile } from 'node:fs/promises';

import { parseAst } from 'rolldown/parseAst';
import { assert, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { isNode } from '../src/lexical-scope.ts';
import { visitTree } from '../src/node-manifest-consumer-ast.ts';
import { nodeManifestPagesForwarderSource } from '../src/node-manifest-pages-forwarder-source.ts';
import {
  certifyNodeManifestPagesRoleConjunction,
  nodeManifestPagesRoleConjunction,
  type NodeManifestPagesRoleConjunctionInput,
} from '../src/node-manifest-pages-role-conjunction.ts';
import {
  createNodeManifestRegistrationScope,
  nodeManifestRegistrationView,
} from '../src/node-manifest-registration-registry.ts';
import {
  assertNodeManifestSingleRegistration,
  createNodeManifestRegistrationViews,
} from '../src/node-manifest-registration-views.ts';
import { certifyNodeManifestRuntimeCallers } from '../src/node-manifest-runtime-callers.ts';
import { certifyNodeManifestRuntimeCohort } from '../src/node-manifest-runtime-cohort.ts';
import {
  nodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackGraphFile,
} from '../src/node-manifest-turbopack-graph.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
} from '../src/node-manifest-turbopack.ts';
import { manifestTemplateSource as source } from './fixtures/node-manifest-turbopack-template.ts';

const ROOT = '/project';
const DIST = `${ROOT}/.next`;
const ENTRY = `${DIST}/server/pages/native.js`;
const RUNTIME = `${DIST}/server/chunks/runtime.js`;
const TABLES = [1, 2].map((id) => `${DIST}/server/chunks/table-${id}.js`);
const PRODUCER = `${ROOT}/node_modules/next/dist/server/route-modules/pages/module.compiled.js`;
function callback(exporter: 'commonjs' | 'n' | 'v', strict = false, mode = ''): string {
  const imported = `ctx.x('pages-source',()=>require('pages-source')${mode})`;
  const directive = strict ? '"use strict";' : '';
  return exporter === 'commonjs'
    ? `(ctx,module,exports)=>{${directive}module.exports=${imported};}`
    : `ctx=>{${directive}const ns=${imported};ctx.${exporter}(ns);}`;
}
interface Options {
  readonly callbacks?: readonly [string, string];
  readonly ids?: readonly (number | string)[];
  readonly kind?: 'pages' | 'pages-api' | 'app-route';
  readonly changedCode?: boolean;
  readonly secondTarget?: string;
  readonly imports?: readonly [
    NodeManifestTurbopackGraphFile['imports'],
    NodeManifestTurbopackGraphFile['imports'],
  ];
  readonly singleton?: boolean;
}
async function fixture(options: Options = {}) {
  const kind = options.kind ?? 'pages';
  // Only published dependency source bytes are read. Next and the fixture are never evaluated.
  const primary = await readFile(
    new URL(import.meta.resolve(`next/dist/server/route-modules/${kind}/module.compiled.js`)),
    'utf8',
  );
  const producer: NodeManifestTurbopackGraphFile = {
    id: PRODUCER,
    file: PRODUCER.replace('/pages/', () => `/${kind}/`),
    source: source(options.changedCode === true ? `${primary}\n` : primary),
    imports: [],
  };
  const alternate = {
    ...producer,
    id: '/foreign/next-producer',
    file: producer.file.replace(ROOT, '/foreign'),
  };
  const callbacks = options.callbacks ?? [callback('n', true), callback('n')];
  const ids = options.ids ?? [1, '1'];
  const tables = TABLES.map((file, index) => {
    const registered = index === 1 && options.singleton === true ? [2] : ids;
    return {
      id: file,
      file,
      source: source(
        `module.exports=[${registered.map((id) => jsLiteral(id)).join(',')},${callbacks[index]}];`,
      ),
      imports: options.imports?.[index] ?? [
        {
          specifier: 'pages-source',
          target: index === 1 ? (options.secondTarget ?? producer.id) : producer.id,
        },
      ],
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
    imports: TABLES.map((target) => ({ specifier: target, target })),
  };
  const entry: NodeManifestTurbopackGraphFile = {
    id: ENTRY,
    file: ENTRY,
    source: source(
      "var R=require('../chunks/runtime.js')('server/pages/native.js');R.c('server/chunks/table-1.js');R.c('server/chunks/table-2.js');module.exports=R.m(1).exports;",
    ),
    imports: [{ specifier: '../chunks/runtime.js', target: runtime.id }],
  };
  const sources = [entry, runtime, ...tables, producer, alternate];
  const profiles = [{ file: ENTRY, kind: 'pages' as const, pathname: '/native', assetPrefix: '/' }];
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
    rootDir: ROOT,
    distDir: DIST,
    sources,
    profiles,
    inventory,
    requiredBoots: [ENTRY],
  });
  const scope = createNodeManifestRegistrationScope(cohort, sources);
  return { sources, tables, runtime, producer, alternate, cohort, scope };
}
function roleInput(
  own: Awaited<ReturnType<typeof fixture>>,
  moduleId: number | string = 1,
): NodeManifestPagesRoleConjunctionInput {
  const graph = nodeManifestTurbopackBootGraph({
    distDir: DIST,
    sources: own.sources,
    file: ENTRY,
    runtimeCohort: own.cohort,
    registrationScope: own.scope,
  });
  assert(graph.registrationIndex !== undefined, 'Expected the actual installed registration index');
  return {
    owner: Object.freeze({ identity: Symbol('Pages source conjunction') }),
    index: graph.registrationIndex,
    sources: own.sources,
    moduleId,
    producer: own.producer,
  };
}
function checked(input: NodeManifestPagesRoleConjunctionInput) {
  const proof = certifyNodeManifestPagesRoleConjunction(input);
  assert(proof !== undefined, 'Expected pending source conjunction');
  return { proof, candidate: nodeManifestPagesRoleConjunction(proof, input) };
}

describe('pending all-variant Pages producer source conjunction', () => {
  it.each(['commonjs', 'n', 'v'] as const)(
    'retains every independent %s wrapper without minting a completed role',
    async (exporter) => {
      const own = await fixture({
        callbacks: [callback(exporter, true), callback(exporter, false, ',false')],
      });
      const input = roleInput(own);
      const { candidate } = checked(input);
      const graph = nodeManifestTurbopackBootGraph({
        distDir: DIST,
        sources: own.sources,
        file: ENTRY,
        runtimeCohort: own.cohort,
        registrationScope: own.scope,
      });
      const views = createNodeManifestRegistrationViews([graph], own.sources);

      expect(candidate?.requiresSdkBoundClosure).toBe(true);
      expect(new Set(candidate?.members.map((member) => member.physicalId))).toStrictEqual(
        new Set(TABLES),
      );

      const registration = nodeManifestRegistrationView(
        input.index,
        input.sources,
      ).registrations.find((entry) => entry.moduleId === 1);

      expect(candidate?.members.map((member) => member.id)).toStrictEqual(registration?.members);
      expect(candidate?.members.map((member) => member.target.sourceId)).toStrictEqual([
        producerId(input),
        producerId(input),
      ]);
      expect(candidate?.members.map((member) => member.factory.ids)).toStrictEqual([
        [1, '1'],
        [1, '1'],
      ]);
      expect(Object.isFrozen(candidate?.members)).toBe(true);
      expect(
        ['compilerSources', 'requiresRuntimeNormalization'].filter((name) =>
          Object.hasOwn(candidate ?? {}, name),
        ),
      ).toStrictEqual([]);
      expect(() => {
        assertNodeManifestSingleRegistration(views, graph.exportedId);
      }).toThrow('grouped protected identity unsupported');
    },
  );

  it('certifies numeric and string selected IDs separately without promoting callback aliases', async () => {
    const own = await fixture();
    const numberInput = roleInput(own);
    const stringInput = roleInput(own, '1');
    const numeric = checked(numberInput);
    const string = checked(stringInput);

    expect(numeric.candidate?.moduleId).toBe(1);
    expect(string.candidate?.moduleId).toBe('1');
    expect(numeric.candidate?.registrationId).not.toBe(string.candidate?.registrationId);
    expect(nodeManifestPagesRoleConjunction(numeric.proof, stringInput)).toBeUndefined();
    expect(
      certifyNodeManifestPagesRoleConjunction({ ...numberInput, moduleId: 99 }),
    ).toBeUndefined();
  });

  it.each([
    { callbacks: [callback('n', true, ',true'), callback('n', false, ',true')] as const },
    {
      callbacks: [
        "ctx=>{\"use strict\";const ns=ctx.x('pages-source',()=>require('pages-source'));ctx.v(ns.PagesRouteModule);}",
        "ctx=>{\"use strict\";const ns=ctx.x('pages-source',()=>require('pages-source'));ctx.v(ns.PagesRouteModule);}",
      ] as const,
    },
    { kind: 'pages-api' as const },
    { kind: 'app-route' as const },
    { changedCode: true },
    { secondTarget: '/foreign/next-producer' },
  ])(
    'does not relax the DATA boundary outside exact all-member Pages forwarding: %j',
    async (options) => {
      const own = await fixture(options);

      expect(() => roleInput(own)).toThrow('uncertified duplicate module registration');
    },
  );

  it('rejects supplied producer descriptors not equal to the actual index-owned source object', async () => {
    const own = await fixture();
    const input = roleInput(own);

    expect(
      certifyNodeManifestPagesRoleConjunction({ ...input, producer: { ...own.producer } }),
    ).toBeUndefined();
    expect(
      certifyNodeManifestPagesRoleConjunction({ ...input, producer: own.alternate }),
    ).toBeUndefined();
    expect(() =>
      certifyNodeManifestPagesRoleConjunction({ ...input, index: { ...input.index } }),
    ).toThrow('stale registration index');
  });

  it('declines internal forwarding chains even when an unused pinned Pages source is present', async () => {
    const internal = 'ctx=>{"use strict";const ns=ctx.i(1);ctx.n(ns);}';
    const own = await fixture({ callbacks: [internal, internal], imports: [[], []] });

    expect(certifyNodeManifestPagesRoleConjunction(roleInput(own))).toBeUndefined();
  });

  it('does not manufacture a multi-member conjunction for a singleton registration', async () => {
    const own = await fixture({ singleton: true, ids: [1] });

    expect(certifyNodeManifestPagesRoleConjunction(roleInput(own))).toBeUndefined();
  });

  it('refuses the complete group if just the second wrapper has an extra expression', async () => {
    const changed =
      "(ctx,module,exports)=>{module.exports=ctx.x('pages-source',()=>require('pages-source'));void 0;}";
    const own = await fixture({ callbacks: [callback('commonjs', true), changed] });

    expect(() => roleInput(own)).toThrow('uncertified duplicate module registration');
  });

  it.each(['owner', 'index', 'sources', 'producer'] as const)(
    'rejects mutable %s pointer retargeting and copied conjunctions',
    async (field) => {
      const own = await fixture();
      const input = roleInput(own);
      const { proof } = checked(input);

      expect(nodeManifestPagesRoleConjunction({ ...proof }, input)).toBeUndefined();

      const values = {
        owner: { identity: input.owner.identity },
        index: { ...input.index },
        sources: [...input.sources],
        producer: { ...input.producer },
      };
      Object.assign(input, { [field]: values[field] });

      expect(nodeManifestPagesRoleConjunction(proof, input)).toBeUndefined();
    },
  );

  it('rechecks source bytes and actual edges after mint instead of retaining a successful subset', async () => {
    const own = await fixture();
    const input = roleInput(own);
    const { proof } = checked(input);
    Object.assign(own.tables[1]?.imports[0] ?? {}, { target: own.alternate.id });

    expect(() => nodeManifestPagesRoleConjunction(proof, input)).toThrow(
      'stale registration index',
    );
  });

  it('does not let a self-consistent caller hash replace the published Pages pin', async () => {
    const own = await fixture();
    const table = own.tables[0];
    assert(table !== undefined, 'Expected authored forwarding source');
    const projection = projectNodeManifestTurbopackFactory(table.source, 1, 'dependencies');
    const range = nodeManifestTurbopackFactories(table.source)[0];
    const parsed: unknown = parseAst(table.source.code);
    assert(isNode(parsed) && range !== undefined, 'Expected original registration');
    const factory = visitTree(parsed).find(
      ({ node }) => node.start === range.start && node.end === range.end,
    )?.node;
    assert(factory !== undefined, 'Expected original callback');
    const changed = {
      ...own.producer,
      source: source('module.exports={PagesRouteModule:class Fake{}};'),
    };

    expect(nodeManifestPagesForwarderSource(factory, projection, changed)).toBeUndefined();
  });
});

function producerId(input: NodeManifestPagesRoleConjunctionInput): string {
  return input.producer.id;
}
