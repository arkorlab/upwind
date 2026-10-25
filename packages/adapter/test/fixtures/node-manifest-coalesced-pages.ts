import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { parseAst } from 'rolldown/parseAst';

import { jsLiteral } from '../../src/codegen.ts';
import { isNode, listOf, type Node } from '../../src/lexical-scope.ts';
import { identifier, visitTree, type Visit } from '../../src/node-manifest-consumer-ast.ts';
import { nodeManifestCoalescedImports } from '../../src/node-manifest-template-imports.ts';
import type { NodeManifestTurbopackConsumerInput } from '../../src/node-manifest-turbopack-consumers.ts';
import {
  nodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackGraphFactory,
} from '../../src/node-manifest-turbopack-graph.ts';
import { turbopackModuleId, turbopackModuleSpecifier } from '../../src/node-manifest-turbopack.ts';
import {
  manifestTemplateSource as source,
  projectedTemplateFixture,
} from './node-manifest-turbopack-template.ts';

const COALESCED_ID = 42;
const COALESCED_DIST = '/project/.next';
export const COALESCED_ENTRY = `${COALESCED_DIST}/server/pages/blog/[slug].js`;
export const COALESCED_CHUNK = `${COALESCED_DIST}/server/chunks/app.js`;
const RUNTIME = `${COALESCED_DIST}/server/chunks/[turbopack]_runtime.js`;
const CONSTRUCTOR = 'next/dist/compiled/next-server/pages-turbo.runtime.prod.js';

interface FixtureOptions {
  readonly prelude?: string;
  readonly between?: string;
  readonly afterRead?: string;
  readonly readKind?: 'const' | 'let' | 'var';
  readonly grouped?: boolean;
  readonly groupEffect?: boolean;
  readonly strict?: boolean;
  readonly externals?: readonly string[];
  readonly extraFactories?: string;
  readonly readId?: string | number;
  readonly ownInline?: boolean;
  readonly builtins?: readonly string[];
}
interface CoalescedFixture {
  readonly input: NodeManifestTurbopackConsumerInput;
  readonly graph: ReturnType<typeof nodeManifestTurbopackEntryGraph>;
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly imports: ReturnType<typeof nodeManifestCoalescedImports>;
  readonly route: { readonly kind: 'pages'; readonly page: string; readonly pathname: string };
}
function namespaceFixture(
  input: {
    readonly code: string;
    readonly name: string;
    readonly visits: readonly Visit[];
    readonly parents: ReadonlyMap<Node, Visit>;
  },
  options: FixtureOptions,
): { readonly text: string; readonly sibling?: Node } {
  if (options.groupEffect === true)
    return { text: `var before=effect(),${input.name}=runtimeContext.i(42);` };
  if (options.grouped !== true)
    return {
      text: `${options.readKind ?? 'const'} ${input.name}=runtimeContext.i(${jsLiteral(options.readId ?? COALESCED_ID)});`,
    };
  const other = input.visits.find(({ node }) => {
    const id = node['id'];
    return node.type === 'VariableDeclarator' && identifier(id) && id.name === '_pageshandler';
  })?.node;
  const group = other === undefined ? undefined : input.parents.get(other)?.parent;
  if (other === undefined || group === undefined)
    throw new TypeError('Expected the primary wrapper sibling import');
  return {
    text: `var ${input.name}=runtimeContext.i(42),${input.code.slice(other.start, other.end)};`,
    sibling: group,
  };
}
function coalescedSource(code: string, specifier: string, options: FixtureOptions): string {
  const parsed: unknown = parseAst(code);
  if (!isNode(parsed)) throw new TypeError('Expected the primary-derived fixture');
  const visits = visitTree(parsed);
  const parents = new Map(visits.map((visit) => [visit.node, visit]));
  const imported = visits.find(({ node }) => {
    if (node.type !== 'CallExpression') return false;
    const id = turbopackModuleId(listOf(node, 'arguments')[0]);
    return id !== undefined && turbopackModuleSpecifier(id) === specifier;
  });
  let variable = imported?.node;
  while (variable !== undefined && variable.type !== 'VariableDeclarator')
    variable = parents.get(variable)?.parent;
  const statement = variable === undefined ? undefined : parents.get(variable)?.parent;
  const id = variable?.['id'];
  if (statement?.type !== 'VariableDeclaration' || !identifier(id))
    throw new TypeError('Expected the known fixture userland namespace declaration');
  const prelude =
    options.prelude ?? 'runtimeContext.s(["default",0,function Page(){return "native";}],42);';
  const namespace = namespaceFixture({ code, name: id.name, visits, parents }, options);
  const replacement = `${prelude}${options.between ?? ''}${namespace.text}${options.afterRead ?? ''}`;
  const tail =
    namespace.sibling === undefined
      ? code.slice(statement.end)
      : code.slice(statement.end, namespace.sibling.start) + code.slice(namespace.sibling.end);
  const output = code.slice(0, statement.start) + replacement + tail;
  const strict = options.strict === false ? output.replace('"use strict";', '') : output;
  return options.ownInline === true
    ? strict.replace('"handler",()=>handler', '"handler",0,function changed(){}')
    : strict;
}

export async function coalescedPagesFixture(
  options: FixtureOptions = {},
): Promise<CoalescedFixture> {
  const own = await projectedTemplateFixture('pages');
  const route = { ...own.route, kind: 'pages' as const };
  // This is a source-authored fixture slot label, never production ownership evidence.
  const userland = own.imports.find((entry) => entry.file === '/fixture/VAR_USERLAND.js');
  const constructor = own.imports.find((entry) => entry.file.endsWith('/pages/module.compiled.js'));
  if (userland === undefined || constructor === undefined)
    throw new TypeError('Expected primary fixture imports');
  const file = await realpath(fileURLToPath(import.meta.resolve(CONSTRUCTOR)));
  const producer = source(await readFile(file, 'utf8'));
  const old = `runtimeContext.x(${jsLiteral(constructor.specifier)},()=>require(${jsLiteral(constructor.specifier)}))`;
  const replacement = `runtimeContext.x(${jsLiteral(CONSTRUCTOR)},()=>require(${jsLiteral(CONSTRUCTOR)}))`;
  const base = own.projection.original.code.replace(old, () => replacement);
  if (base === own.projection.original.code)
    throw new TypeError('Expected the constructor import call');
  const code = coalescedSource(base, userland.specifier, options);
  const actual = own.imports
    .filter((entry) => entry !== userland)
    .map((entry) =>
      entry === constructor ? { specifier: CONSTRUCTOR, file, sha256: producer.sha256 } : entry,
    );
  if (options.externals !== undefined) {
    for (const specifier of options.externals) {
      const imported = await realpath(createRequire(import.meta.url).resolve(specifier));
      actual.push({
        specifier,
        file: imported,
        sha256: source(await readFile(imported, 'utf8')).sha256,
      });
    }
  }
  const external = actual.filter((entry) => !entry.specifier.startsWith('turbopack:'));
  const ids = actual
    .filter((entry) => entry.specifier.startsWith('turbopack:'))
    .map((entry) => {
      const id = Number(entry.specifier.slice('turbopack:'.length));
      if (!Number.isSafeInteger(id)) throw new TypeError('Expected numeric authored fixture slots');
      return id;
    });
  const slots = ids
    .map((id) => `${jsLiteral(id)},ctx=>{const value={};ctx.s(["default",0,value]);},`)
    .join('');
  const chunk = source(
    code.replace(
      'module.exports=[',
      () => `module.exports=[${slots}${options.extraFactories ?? ''}`,
    ),
  );
  const runtime = (await readFile(new URL('node-runtime/production.txt', import.meta.url), 'utf8'))
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
  const input: NodeManifestTurbopackConsumerInput = {
    distDir: COALESCED_DIST,
    rootDir: '/project',
    entries: [{ file: COALESCED_ENTRY, ...route }],
    producer: { id: file, file, sha256: producer.sha256, kind: 'pages-class' },
    sources: [
      {
        id: COALESCED_ENTRY,
        file: COALESCED_ENTRY,
        source: source(
          'var R=require("../../chunks/[turbopack]_runtime.js")("server/pages/blog/[slug].js");R.c("server/chunks/app.js");R.m(1);module.exports=R.m(1).exports;',
        ),
        imports: [{ specifier: '../../chunks/[turbopack]_runtime.js', target: RUNTIME }],
      },
      {
        id: RUNTIME,
        file: RUNTIME,
        source: source(runtime),
        imports: [{ specifier: COALESCED_CHUNK, target: COALESCED_CHUNK }],
      },
      {
        id: COALESCED_CHUNK,
        file: COALESCED_CHUNK,
        source: chunk,
        imports: [
          ...external.map((entry) => ({ specifier: entry.specifier, target: entry.file })),
          ...(options.builtins ?? []).map((specifier) => ({ specifier, target: specifier })),
        ],
      },
      ...(await Promise.all(
        external.map(async (entry) => {
          const bytes = await readFile(entry.file, 'utf8');
          return { id: entry.file, file: entry.file, source: source(bytes), imports: [] };
        }),
      )),
    ],
  };
  const entry = input.entries[0];
  if (entry === undefined) throw new TypeError('Expected the sealed authored Pages entry');
  const graph = nodeManifestTurbopackEntryGraph({
    distDir: input.distDir,
    entry,
    sources: input.sources,
  });
  const factory = graph.factories.find((candidate) => candidate.projection.moduleId === 1);
  if (factory === undefined)
    throw new TypeError('Expected the source-authored owning Pages factory');
  const imports = nodeManifestCoalescedImports({
    factory,
    sources: input.sources,
    target: (id) => graph.factories.find((candidate) => candidate.id === id)?.physicalId ?? id,
  });
  return { input, graph, factory, imports, route };
}
