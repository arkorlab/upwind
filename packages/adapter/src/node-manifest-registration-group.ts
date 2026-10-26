import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import {
  identifier,
  propertyName,
  reference,
  stringOf,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import {
  nodeManifestRuntimeCohortSources,
  type NodeManifestRuntimeCohort,
} from './node-manifest-runtime-cohort.ts';
import type { NodeManifestTurbopackGraphFile } from './node-manifest-turbopack-graph.ts';
import { externalThunk } from './node-manifest-turbopack-values.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackFactory,
  type NodeManifestTurbopackImport,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

const BRAND: unique symbol = Symbol('node-manifest-registration-group');
const PRIMITIVES: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);
const IMPLICIT: ReadonlySet<string> = new Set(['__dirname', '__filename', 'arguments']);
export interface NodeManifestRegistrationGroupProof {
  readonly [BRAND]: true;
}
export interface NodeManifestRegistrationOccurrence {
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly factory: NodeManifestTurbopackFactory;
}
export interface NodeManifestRegistrationGroupInput {
  readonly owner: { readonly identity: symbol };
  readonly cohort: NodeManifestRuntimeCohort;
  readonly runtime: NodeManifestTurbopackGraphFile;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly occurrences: readonly NodeManifestRegistrationOccurrence[];
}
export interface NodeManifestRegistrationGroup {
  readonly runtimeId: string;
  /** Every physical occurrence survives. This is not a selected runtime winner. */
  readonly occurrences: readonly {
    readonly physicalId: string;
    readonly file: string;
    readonly sha256: string;
    readonly factory: NodeManifestTurbopackFactory;
    readonly projections: readonly NodeManifestTurbopackProjection[];
    readonly dependencies: readonly string[];
  }[];
}
interface Original {
  readonly factory: Node;
  readonly scope: Scope;
  readonly visits: readonly Visit[];
}
interface State {
  readonly ownerIdentity: symbol;
  readonly pointers: readonly unknown[];
  readonly fingerprint: string;
  readonly result: NodeManifestRegistrationGroup;
}
const CERTIFICATES = new WeakMap<NodeManifestRegistrationGroupProof, State>();

function digest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
function fingerprint(input: NodeManifestRegistrationGroupInput): string {
  return digest(JSON.stringify([input.runtime, input.sources, input.occurrences]));
}
function pointers(input: NodeManifestRegistrationGroupInput): readonly unknown[] {
  const result: unknown[] = [
    input.owner,
    input.cohort,
    input.runtime,
    input.sources,
    input.occurrences,
  ];
  for (const source of input.sources)
    result.push(source, source.source, source.imports, ...source.imports);
  for (const item of input.occurrences)
    result.push(item, item.physical, item.factory, item.factory.ids);
  return result;
}
function strictDirective(value: unknown): boolean {
  if (!isNode(value) || value.type !== 'ExpressionStatement') return false;
  const expression = value['expression'];
  return (
    isNode(expression) &&
    expression.type === 'Literal' &&
    expression.start === value.start &&
    (expression['raw'] === '"use strict"' || expression['raw'] === "'use strict'")
  );
}
function directiveBody(node: Node): readonly unknown[] {
  if (node.type === 'Program') return listOf(node, 'body');
  const body = node['body'];
  return isNode(body) && body.type === 'BlockStatement' ? listOf(body, 'body') : [];
}
function hasStrictDirective(node: Node): boolean {
  for (const statement of directiveBody(node)) {
    if (strictDirective(statement)) return true;
    const expression = isNode(statement) ? statement['expression'] : undefined;
    if (
      !isNode(statement) ||
      statement.type !== 'ExpressionStatement' ||
      !isNode(expression) ||
      expression.type !== 'Literal' ||
      expression.start !== statement.start ||
      typeof expression['value'] !== 'string'
    )
      break;
  }
  return false;
}
function originalOf(occurrence: NodeManifestRegistrationOccurrence): Original | undefined {
  const { physical, factory } = occurrence;
  const known = nodeManifestTurbopackFactories(physical.source);
  if (known.every((value) => JSON.stringify(value) !== JSON.stringify(factory))) return undefined;
  const parsed: unknown = parseAst(physical.source.code);
  if (!isNode(parsed)) return undefined;
  const all = visitTree(parsed);
  const found = all.find(({ node }) => node.start === factory.start && node.end === factory.end);
  const scope = found?.scopes.at(-1);
  if (found === undefined || scope === undefined) return undefined;
  const parents = new Map(all.map((visit) => [visit.node, visit.parent]));
  let ancestor: Node | undefined = found.node;
  while (ancestor !== undefined && !hasStrictDirective(ancestor)) ancestor = parents.get(ancestor);
  if (ancestor === undefined) return undefined;
  return {
    factory: found.node,
    scope,
    visits: all.filter(({ node }) => node.start >= factory.start && node.end <= factory.end),
  };
}
function bindingScope(name: string, visit: Visit): Scope | undefined {
  return visit.scopes.findLast((scope) => scope.declared.has(name));
}
function externalRequires(original: Original): ReadonlySet<Node> {
  const result = new Set<Node>();
  const context = listOf(original.factory, 'params')[0];
  if (!identifier(context)) return result;
  for (const visit of original.visits) {
    const call = visit.node;
    const callee = call['callee'];
    if (
      call.type !== 'CallExpression' ||
      !isNode(callee) ||
      callee.type !== 'MemberExpression' ||
      !identifier(callee['object']) ||
      callee['object'].name !== context.name ||
      bindingScope(context.name, visit) !== original.scope ||
      propertyName(callee) !== 'x'
    )
      continue;
    const args = listOf(call, 'arguments');
    const required = externalThunk(args);
    const requireCallee = required['callee'];
    const specifier = stringOf(args[0]);
    if (
      specifier !== undefined &&
      required.type === 'CallExpression' &&
      required['optional'] !== true &&
      identifier(requireCallee) &&
      requireCallee.name === 'require' &&
      listOf(required, 'arguments').length === 1 &&
      stringOf(listOf(required, 'arguments')[0]) === specifier
    )
      result.add(requireCallee);
  }
  return result;
}
function closedAmbient(original: Original): boolean {
  const required = externalRequires(original);
  for (const visit of original.visits) {
    const { node } = visit;
    if (['MetaProperty', 'Super', 'ThisExpression'].includes(node.type)) return false;
    if (!identifier(node) || !reference(visit)) continue;
    const own = visit.scopes.indexOf(original.scope);
    const binding = bindingScope(node.name, visit);
    if (binding === undefined && IMPLICIT.has(node.name)) return false;
    if (binding !== undefined) {
      if (visit.scopes.indexOf(binding) < own) return false;
    } else if (!PRIMITIVES.has(node.name) && !required.has(node)) return false;
  }
  return true;
}
function sourcesById(
  input: NodeManifestRegistrationGroupInput,
): ReadonlyMap<string, NodeManifestTurbopackGraphFile> | undefined {
  const sources = new Map<string, NodeManifestTurbopackGraphFile>();
  const files = new Set<string>();
  for (const source of input.sources) {
    if (
      !path.isAbsolute(source.file) ||
      sources.has(source.id) ||
      files.has(source.file) ||
      digest(source.source.code) !== source.source.sha256
    )
      return undefined;
    sources.set(source.id, source);
    files.add(source.file);
  }
  const runtime = sources.get(input.runtime.id);
  const reviewed = nodeManifestRuntimeCohortSources(input.cohort, input.sources);
  return runtime === input.runtime && reviewed.some((item) => item.id === runtime.id)
    ? sources
    : undefined;
}
function dependency(
  imported: NodeManifestTurbopackImport,
  physical: NodeManifestTurbopackGraphFile,
  context: {
    readonly sources: ReadonlyMap<string, NodeManifestTurbopackGraphFile>;
    readonly registry: ReadonlyMap<string | number, readonly string[]>;
  },
): string | undefined {
  if (imported.targetId !== undefined) {
    const targets = context.registry.get(imported.targetId);
    return targets === undefined
      ? undefined
      : JSON.stringify([imported.kind, imported.specifier, imported.targetId, targets]);
  }
  const edges = physical.imports.filter((edge) => edge.specifier === imported.specifier);
  const edge = edges[0];
  if (edge === undefined || edges.length !== 1) return undefined;
  if (isBuiltin(edge.target))
    return JSON.stringify([imported.kind, imported.specifier, 'builtin', edge.target]);
  const target = context.sources.get(edge.target);
  // This initial ordinary-only certificate never groups privileged Next runtime imports.
  if (target === undefined || target.file.replaceAll('\\', '/').includes('/next/dist/'))
    return undefined;
  return JSON.stringify([
    imported.kind,
    imported.specifier,
    target.id,
    target.file,
    target.source.sha256,
  ]);
}
function registryFor(
  input: NodeManifestRegistrationGroupInput,
  sources: ReadonlyMap<string, NodeManifestTurbopackGraphFile>,
): ReadonlyMap<string | number, readonly string[]> | undefined {
  const registry = new Map<string | number, string[]>();
  const runtimes = new Set(input.cohort.runtimes.map((runtime) => runtime.id));
  const known = new Set<string>();
  for (const edge of input.runtime.imports) {
    if (runtimes.has(edge.target) || isBuiltin(edge.target) || known.has(edge.target)) continue;
    const table = sources.get(edge.target);
    if (table?.file !== edge.specifier) return undefined;
    known.add(table.id);
    for (const factory of nodeManifestTurbopackFactories(table.source)) {
      for (const id of factory.ids) {
        const identities = registry.get(id) ?? [];
        identities.push(JSON.stringify([table.id, table.file, table.source.sha256, factory]));
        registry.set(id, identities);
      }
    }
  }
  return registry;
}
function ordinary(projection: NodeManifestTurbopackProjection): boolean {
  return (
    projection.exports.kind === 'opaque' &&
    projection.cacheInitializers.length === 0 &&
    projection.boundRuntimeInputs.length === 0 &&
    projection.asyncLoads.length === 0 &&
    projection.asyncLoader === undefined
  );
}
function frozenProjection(projection: NodeManifestTurbopackProjection) {
  // Freeze a fresh inspection snapshot, without freezing the caller's original graph objects.
  return Object.freeze({
    ...projection,
    original: Object.freeze({ ...projection.original }),
    source: Object.freeze({ ...projection.source }),
    factory: Object.freeze({
      ...projection.factory,
      ids: Object.freeze([...projection.factory.ids]),
    }),
    imports: Object.freeze(projection.imports.map((item) => Object.freeze({ ...item }))),
    exports: Object.freeze({ kind: 'opaque' as const }),
    cacheInitializers: Object.freeze([]),
    boundRuntimeInputs: Object.freeze([]),
    asyncLoads: Object.freeze([]),
  });
}
function inspectOccurrence(
  item: NodeManifestRegistrationOccurrence,
  context: Parameters<typeof dependency>[2],
):
  | {
      readonly signature: string;
      readonly occurrence: NodeManifestRegistrationGroup['occurrences'][number];
    }
  | undefined {
  const { physical, factory } = item;
  const original = originalOf(item);
  if (original === undefined || !closedAmbient(original)) return undefined;
  const projections = factory.ids.map((id) =>
    projectNodeManifestTurbopackFactory(physical.source, id, 'dependencies'),
  );
  if (projections.some((projection) => !ordinary(projection))) return undefined;
  const dependencies: string[] = [];
  for (const projection of projections) {
    for (const imported of projection.imports) {
      const signature = dependency(imported, physical, context);
      if (signature === undefined) return undefined;
      dependencies.push(signature);
    }
  }
  const signature = JSON.stringify([
    physical.source.code.slice(factory.start, factory.end),
    factory.ids,
    projections.map((projection) => [projection.moduleId, projection.source, projection.exports]),
    dependencies,
  ]);
  const ids = Object.freeze([...factory.ids]);
  const frozenFactory = Object.freeze({ ...factory, ids });
  const frozenProjections = projections.map((projection) => frozenProjection(projection));
  const occurrence = Object.freeze({
    physicalId: physical.id,
    file: physical.file,
    sha256: physical.source.sha256,
    factory: frozenFactory,
    projections: Object.freeze(frozenProjections),
    dependencies: Object.freeze(dependencies),
  });
  return { signature, occurrence };
}
function inspect(
  input: NodeManifestRegistrationGroupInput,
): NodeManifestRegistrationGroup | undefined {
  const sources = sourcesById(input);
  if (sources === undefined || input.occurrences.length < 2) return undefined;
  const registry = registryFor(input, sources);
  if (registry === undefined) return undefined;
  const physicalIds = new Set<string>();
  const occurrences: NodeManifestRegistrationGroup['occurrences'][number][] = [];
  let expected: string | undefined;
  for (const item of input.occurrences) {
    const { physical } = item;
    if (
      sources.get(physical.id) !== physical ||
      physicalIds.has(physical.id) ||
      input.runtime.imports.every(
        (edge) => edge.target !== physical.id || edge.specifier !== physical.file,
      )
    )
      return undefined;
    physicalIds.add(physical.id);
    const checked = inspectOccurrence(item, { sources, registry });
    if (checked === undefined || (expected !== undefined && expected !== checked.signature))
      return undefined;
    expected = checked.signature;
    occurrences.push(checked.occurrence);
  }
  return Object.freeze({ runtimeId: input.runtime.id, occurrences: Object.freeze(occurrences) });
}

/** Equality metadata only: every physical body still needs its own ordinary/protected audits. */
export function certifyNodeManifestRegistrationGroup(
  input: NodeManifestRegistrationGroupInput,
): NodeManifestRegistrationGroupProof | undefined {
  const result = inspect(input);
  if (result === undefined) return undefined;
  const proof = Object.freeze<NodeManifestRegistrationGroupProof>({ [BRAND]: true });
  CERTIFICATES.set(proof, {
    ownerIdentity: input.owner.identity,
    pointers: pointers(input),
    fingerprint: fingerprint(input),
    result,
  });
  return proof;
}

/** Copies, stale sources and another build/runtime cannot borrow a group's equality proof. */
export function nodeManifestRegistrationGroup(
  proof: NodeManifestRegistrationGroupProof,
  input: NodeManifestRegistrationGroupInput,
): NodeManifestRegistrationGroup | undefined {
  const state = CERTIFICATES.get(proof);
  const current = pointers(input);
  if (
    state?.ownerIdentity !== input.owner.identity ||
    current.length !== state.pointers.length ||
    current.some((pointer, index) => pointer !== state.pointers[index]) ||
    fingerprint(input) !== state.fingerprint
  )
    return undefined;
  const checked = inspect(input);
  return JSON.stringify(checked) === JSON.stringify(state.result) ? state.result : undefined;
}
