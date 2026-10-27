import { isDeepStrictEqual } from 'node:util';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import type { CoalescedPagesClosureInput } from './node-manifest-coalesced-closure.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  stringOf,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import type { NodeManifestHandlerOwnerBinding } from './node-manifest-handler-context.ts';
import {
  captureNodeManifestIdentity,
  assertNodeManifestIdentity,
  captureNodeManifestOwnIdentity,
  assertNodeManifestOwnIdentity,
  type NodeManifestIdentitySnapshot,
  type NodeManifestOwnIdentitySnapshot,
} from './node-manifest-identity-snapshot.ts';
import {
  assertNodeManifestPassBinding,
  assertNodeManifestPassRows,
  assertNodeManifestPassSources,
  type NodeManifestRegistrationPass,
} from './node-manifest-registration-pass.ts';
import {
  useNodeManifestOriginalCommonJs,
  assertNodeManifestOriginalCommonJs,
} from './node-manifest-sdk-terminal.ts';
import type { NodeManifestTemplateHelperOwner } from './node-manifest-template-helpers.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumer-input.ts';
import { assertNodeManifestTurbopackConsumerOwner } from './node-manifest-turbopack-consumers.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';
import { assertNodeManifestTurbopackRuntime } from './node-manifest-turbopack-runtime.ts';
import type { NodeManifestTurbopackProjection } from './node-manifest-turbopack.ts';
import type { OriginalCommonJsMode } from './node-original-load-mode.ts';

const VALUE_RECORD_WIDTH = 3;
const MAX_FACTORY_PARAMETERS = 3;
const BASIS: unique symbol = Symbol('original CJS Pages inspection basis');
export interface NodeManifestCoalescedCjsBasis {
  readonly [BASIS]: true;
}
export interface NodeManifestCoalescedCjsContext {
  readonly consumerOwner: Readonly<{ identity: symbol }>;
  readonly binding: NodeManifestHandlerOwnerBinding;
  readonly pass: NodeManifestRegistrationPass;
}
interface Input {
  readonly owner: NodeManifestTurbopackConsumerInput;
  readonly graph: NodeManifestTurbopackBootGraph;
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly context: NodeManifestCoalescedCjsContext;
  readonly helperOwner: NodeManifestTemplateHelperOwner | undefined;
}
interface Stored {
  readonly input: Input;
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly mode: OriginalCommonJsMode;
  readonly controls: readonly {
    readonly snapshot: NodeManifestOwnIdentitySnapshot;
    readonly roots: readonly unknown[];
  }[];
  readonly identity: NodeManifestIdentitySnapshot;
  readonly identityRoots: readonly unknown[];
  readonly projection: string;
  partition?: string;
}
const BASES = new WeakMap<NodeManifestCoalescedCjsBasis, Stored>();
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression']);
const REFLECTION = new Set([
  '__proto__',
  'arguments',
  'callee',
  'caller',
  'constructor',
  'prototype',
]);
function refuse(reason: string): never {
  throw new AuditError(
    `Unproved original CJS Pages inspection ${reason}; refusing native publication`,
  );
}
function strictPrologue(node: Node): boolean {
  const body = node.type === 'Program' ? node : node['body'];
  if (!isNode(body)) return false;
  for (const statement of listOf(body, 'body')) {
    const expression = isNode(statement) ? statement['expression'] : undefined;
    if (
      !isNode(statement) ||
      statement.type !== 'ExpressionStatement' ||
      !isNode(expression) ||
      expression.type !== 'Literal' ||
      typeof expression['value'] !== 'string' ||
      expression.start !== statement.start
    )
      break;
    if (expression['raw'] === '"use strict"' || expression['raw'] === "'use strict'") return true;
  }
  return false;
}
/** Positive source syntax DATA only; a CJS filesystem token and private owner remain mandatory. */
export function originalSloppyPagesArrow(projection: NodeManifestTurbopackProjection): boolean {
  const program: unknown = parseAst(projection.original.code);
  if (!isNode(program)) return false;
  const visits = visitTree(program);
  if (
    visits.some(({ node }) => {
      return [
        'ExportAllDeclaration',
        'ExportDefaultDeclaration',
        'ExportNamedDeclaration',
        'ImportDeclaration',
      ].includes(node.type);
    })
  )
    return false;
  const parents = new Map(visits.map((visit) => [visit.node, visit.parent]));
  const factory = visits.find(
    ({ node }) => node.start === projection.factory.start && node.end === projection.factory.end,
  )?.node;
  if (
    factory?.type !== 'ArrowFunctionExpression' ||
    factory['async'] === true ||
    factory['generator'] === true ||
    !isNode(factory['body']) ||
    factory['body'].type !== 'BlockStatement'
  )
    return false;
  const params = listOf(factory, 'params');
  if (
    params.length === 0 ||
    params.length > MAX_FACTORY_PARAMETERS ||
    params.some((param) => !identifier(param)) ||
    new Set(params.map((param) => (param as Node)['name'])).size !== params.length
  )
    return false;
  for (let at: Node | undefined = factory; at !== undefined; at = parents.get(at)) {
    if (['ClassDeclaration', 'ClassExpression'].includes(at.type)) return false;
    if ((at.type === 'Program' || FUNCTIONS.has(at.type)) && strictPrologue(at)) return false;
  }
  return true;
}
function owner(input: Input): void {
  const context = input.context;
  assertNodeManifestTurbopackConsumerOwner(context.consumerOwner, context.binding);
  if (
    context.binding.input !== input.owner ||
    context.binding.owner !== input.helperOwner ||
    !context.binding.graphs.includes(input.graph) ||
    context.binding.factories.get(input.factory.id) !== input.factory ||
    !input.graph.factories.includes(input.factory)
  )
    refuse('private owner or graph');
  assertNodeManifestPassBinding(context.pass, context.binding.registrations);
  assertNodeManifestPassSources(context.pass, input.owner.sources);
  assertNodeManifestPassRows(context.pass, [
    ...new Set(context.binding.graphs.flatMap((graph) => graph.factories)),
  ]);
}
function current(basis: NodeManifestCoalescedCjsBasis): Stored {
  const stored = BASES.get(basis);
  if (stored === undefined) return refuse('copied or missing basis');
  for (const control of stored.controls)
    assertNodeManifestOwnIdentity(control.snapshot, control.roots);
  assertNodeManifestIdentity(stored.identity, stored.identityRoots);
  owner(stored.input);
  if (
    JSON.stringify(stored.input.factory.projection) !== stored.projection ||
    stored.input.factory.projection.original !== stored.physical.source ||
    !originalSloppyPagesArrow(stored.input.factory.projection)
  )
    refuse('changed original factory');
  return stored;
}
function ownControl(value: unknown) {
  const roots = Object.freeze([value]);
  const snapshot = captureNodeManifestOwnIdentity(roots);
  assertNodeManifestOwnIdentity(snapshot, roots);
  return Object.freeze({ snapshot, roots });
}
/** This capability permits inspection only, never a compiler exemption or publication. */
export async function certifyNodeManifestCoalescedCjs(
  input: Input,
): Promise<NodeManifestCoalescedCjsBasis | undefined> {
  const inputControl = ownControl(input);
  const contextControl = ownControl(input.context);
  const controls = Object.freeze([inputControl, contextControl, ownControl(input.context.binding)]);
  const identityRoots = Object.freeze([
    input.owner,
    input.graph,
    input.factory,
    input.context.binding.factories,
    input.context.binding.graphs,
  ]);
  const identity = captureNodeManifestIdentity(identityRoots);
  assertNodeManifestIdentity(identity, identityRoots);
  if (!originalSloppyPagesArrow(input.factory.projection)) return undefined;
  const physical = input.owner.sources.find((source) => source.id === input.factory.physicalId);
  if (physical?.source !== input.factory.projection.original) return refuse('raw physical source');
  owner(input);
  assertNodeManifestTurbopackRuntime({
    source: input.graph.runtime.source,
    file: input.graph.runtime.file,
    rootDir: input.owner.rootDir,
    distDir: input.owner.distDir,
    assetPrefix: input.owner.assetPrefix,
  });
  const mode = await useNodeManifestOriginalCommonJs(input.owner, physical);
  if (mode === undefined) return undefined;
  const basis = Object.freeze<NodeManifestCoalescedCjsBasis>({ [BASIS]: true });
  BASES.set(basis, {
    input,
    physical,
    mode,
    controls,
    identity,
    identityRoots,
    projection: JSON.stringify(input.factory.projection),
  });
  current(basis);
  return basis;
}
export function assertNodeManifestCoalescedCjsFactory(
  basis: NodeManifestCoalescedCjsBasis,
  projection: NodeManifestTurbopackProjection,
): void {
  const stored = current(basis);
  if (
    projection.original !== stored.physical.source ||
    JSON.stringify(projection) !== stored.projection
  )
    refuse('cross-factory projection');
}
export async function assertCurrentNodeManifestCoalescedCjs(
  basis: NodeManifestCoalescedCjsBasis,
): Promise<void> {
  const stored = current(basis);
  await assertNodeManifestOriginalCommonJs(stored.mode, stored.input.owner, stored.physical);
  current(basis);
}
function within(node: Node, root: Node): boolean {
  return node.start >= root.start && node.end <= root.end;
}
function localArguments(
  visit: Visit,
  roots: readonly Node[],
  parents: ReadonlyMap<Node, Visit>,
): boolean {
  for (const scope of visit.scopes.toReversed()) {
    if (!scope.declared.has('arguments')) continue;
    const declarationNode = scope.bindings.get('arguments');
    if (declarationNode !== undefined) return false;
    for (let at = visit.parent; at !== undefined; at = parents.get(at)?.parent) {
      if (at.type === 'ArrowFunctionExpression') continue;
      if (!FUNCTIONS.has(at.type)) continue;
      return (
        roots.some((root) => within(at, root)) &&
        listOf(at, 'params').some((param) => identifier(param) && param.name === 'arguments')
      );
    }
    return false;
  }
  return false;
}
function contextImport(
  call: Node,
  input: CoalescedPagesClosureInput,
): { readonly method: string; readonly args: readonly unknown[] } | undefined {
  if (input.imports.every((entry) => entry.call !== call || entry.protected)) return undefined;
  const callee = call['callee'];
  const context = listOf(input.factory, 'params')[0];
  if (
    !isNode(callee) ||
    callee.type !== 'MemberExpression' ||
    !identifier(callee['object']) ||
    !identifier(context) ||
    callee['object'].name !== context.name ||
    callee['optional'] === true ||
    call['optional'] === true
  )
    return undefined;
  const method = propertyName(callee);
  return method === undefined ? undefined : { method, args: listOf(call, 'arguments') };
}
function externalThunk(args: readonly unknown[], input: CoalescedPagesClosureInput): boolean {
  if (args.length < 2 || args.length > MAX_FACTORY_PARAMETERS || stringOf(args[0]) === undefined)
    return false;
  const esm = args[2];
  if (
    esm !== undefined &&
    (!isNode(esm) || esm.type !== 'Literal' || typeof esm['value'] !== 'boolean')
  )
    return false;
  const thunk = args[1];
  if (
    !isNode(thunk) ||
    thunk.type !== 'ArrowFunctionExpression' ||
    thunk['async'] === true ||
    listOf(thunk, 'params').length > 0
  )
    return false;
  const invoke = thunk['body'];
  if (
    !isNode(invoke) ||
    invoke.type !== 'CallExpression' ||
    invoke['optional'] === true ||
    listOf(invoke, 'arguments').length !== 1
  )
    return false;
  const requireName = invoke['callee'];
  if (
    !identifier(requireName) ||
    requireName.name !== 'require' ||
    stringOf(listOf(invoke, 'arguments')[0]) !== stringOf(args[0])
  )
    return false;
  const visit = visitTree(input.original).find(({ node }) => node === requireName);
  return visit !== undefined && declaration('require', visit.scopes) === undefined;
}
function importCall(call: Node, input: CoalescedPagesClosureInput): boolean {
  const imported = contextImport(call, input);
  if (imported === undefined) return false;
  if (imported.method === 'x') return externalThunk(imported.args, input);
  const id = imported.args[0];
  return (
    ['i', 'r'].includes(imported.method) &&
    imported.args.length === 1 &&
    isNode(id) &&
    id.type === 'Literal' &&
    ['number', 'string'].includes(typeof id['value'])
  );
}
function deferred(visit: Visit, root: Node, parents: ReadonlyMap<Node, Visit>): boolean {
  for (
    let at: Node | undefined = visit.node;
    at !== undefined && at !== root;
    at = parents.get(at)?.parent
  )
    if (FUNCTIONS.has(at.type)) return true;
  return FUNCTIONS.has(root.type);
}
function reflective(node: Node, parent: Node | undefined): boolean {
  const selector =
    node.type === 'MemberExpression' ||
    (node.type === 'Property' && (node['computed'] === true || parent?.type === 'ObjectPattern'));
  if (!selector) return false;
  const property = node['property'] ?? node['key'];
  const key =
    node['computed'] !== true && identifier(property) ? property.name : stringOf(property);
  return key === undefined || REFLECTION.has(key);
}
function partitionVisit(
  visit: Visit,
  input: {
    readonly closure: CoalescedPagesClosureInput;
    readonly root: Node;
    readonly roots: readonly Node[];
    readonly parents: ReadonlyMap<Node, Visit>;
  },
): void {
  const node = visit.node;
  if (
    ['ImportExpression', 'MetaProperty', 'Super', 'ThisExpression', 'WithStatement'].includes(
      node.type,
    )
  )
    refuse('dynamic scope or implicit receiver');
  if (
    identifier(node) &&
    node.name === 'arguments' &&
    reference(visit) &&
    !localArguments(visit, input.roots, input.parents)
  )
    refuse('implicit arguments');
  if (reflective(node, visit.parent)) refuse('dynamic or reflective selector');
  if (deferred(visit, input.root, input.parents)) return;
  if (node.type === 'CallExpression' && !importCall(node, input.closure))
    refuse('unqualified eager call');
  if (['NewExpression', 'SpreadElement', 'TaggedTemplateExpression'].includes(node.type))
    refuse('unqualified eager operation');
  if (
    node.type === 'MemberExpression' &&
    (visit.parent?.type !== 'CallExpression' ||
      visit.parent['callee'] !== node ||
      !importCall(visit.parent, input.closure))
  )
    refuse('unqualified eager property read');
}
/** Finite noninterference check for the erased partition; it does not execute a strict surrogate. */
export function assertCoalescedCjsPartition(
  input: CoalescedPagesClosureInput,
  owned: readonly Node[],
): void {
  const visits = visitTree(input.original);
  const parents = new Map(visits.map((visit) => [visit.node, visit]));
  const roots = [...input.tableValues, ...owned];
  if (
    listOf(input.table, 'elements').some(
      (row, index) => index % VALUE_RECORD_WIDTH === 0 && stringOf(row) === 'then',
    )
  )
    refuse('thenable userland namespace');
  for (const root of roots)
    for (const visit of visits) {
      if (within(visit.node, root)) partitionVisit(visit, { closure: input, root, roots, parents });
    }
}
export function certifyNodeManifestCoalescedCjsPartition(
  basis: NodeManifestCoalescedCjsBasis,
  projection: NodeManifestTurbopackProjection,
  input: CoalescedPagesClosureInput,
  owned: readonly Node[],
): void {
  assertNodeManifestCoalescedCjsFactory(basis, projection);
  if (
    !isDeepStrictEqual(parseAst(projection.original.code), input.original) ||
    input.factory.start !== projection.factory.start ||
    input.factory.end !== projection.factory.end
  )
    refuse('partition original AST');
  const entry = projection.cacheInitializers[0];
  const write = visitTree(input.original).find(
    ({ node }) => node.start === entry?.start && node.end === entry.end,
  )?.node;
  if (
    projection.cacheInitializers.length !== 1 ||
    !isNode(write) ||
    listOf(write, 'arguments')[0] !== input.table ||
    listOf(input.table, 'elements')
      .filter((_, index) => index % VALUE_RECORD_WIDTH === 2)
      .some((node, index) => node !== input.tableValues[index])
  )
    refuse('partition cache identity');
  assertCoalescedCjsPartition(input, owned);
  current(basis).partition = JSON.stringify([
    input.factory.start,
    input.factory.end,
    input.table.start,
    input.table.end,
    owned.map((node) => [node.start, node.end]),
  ]);
}
export function assertNodeManifestCoalescedCjsPartitioned(
  basis: NodeManifestCoalescedCjsBasis,
  projection: NodeManifestTurbopackProjection,
): void {
  assertNodeManifestCoalescedCjsFactory(basis, projection);
  if (current(basis).partition === undefined) refuse('unchecked partition');
}
