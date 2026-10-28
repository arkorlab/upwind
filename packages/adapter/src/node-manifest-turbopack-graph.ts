import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { identifier, propertyName, stringOf } from './node-manifest-consumer-ast.ts';
import type { NodeManifestPagesDefinition } from './node-manifest-pages-definitions.ts';
import {
  nodeManifestRegistrationIndex,
  nodeManifestRegistrationView,
  nodeManifestInitialRegistration,
  type NodeManifestRegistrationScope,
  type NodeManifestRegistrationIndex,
} from './node-manifest-registration-registry.ts';
import {
  nodeManifestRuntimeCohortLookup,
  nodeManifestRuntimeCohortSources,
  type NodeManifestRuntimeCohort,
} from './node-manifest-runtime-cohort.ts';
import { nodeManifestRuntimeTables } from './node-manifest-runtime-tables.ts';
import {
  turbopackModuleId,
  type NodeManifestTurbopackModuleId,
  type NodeManifestTurbopackProjection,
  type NodeManifestTurbopackSource,
} from './node-manifest-turbopack.ts';

export interface NodeManifestTurbopackEntry {
  readonly runtimeSpecifier: string;
  readonly publicPath: string;
  readonly chunks: readonly string[];
  readonly evaluations: readonly NodeManifestTurbopackModuleId[];
  readonly exportedId: NodeManifestTurbopackModuleId;
}
export interface NodeManifestTurbopackGraphFile {
  readonly id: string;
  readonly file: string;
  readonly source: NodeManifestTurbopackSource;
  /** Actual bundler resolutions, not strings guessed from an importer's filename. */
  readonly imports: readonly { readonly specifier: string; readonly target: string }[];
}
export interface NodeManifestTurbopackSealedEntry {
  readonly file: string;
  readonly page: string;
  readonly pathname: string;
  readonly kind?: 'app-page' | 'pages' | 'app-route' | 'pages-api';
  readonly definition?: NodeManifestPagesDefinition | undefined;
}
export interface NodeManifestTurbopackGraphFactory {
  readonly id: string;
  readonly runtimeId?: string;
  readonly physicalId: string;
  readonly projection: NodeManifestTurbopackProjection;
  readonly imports: readonly { readonly specifier: string; readonly target: string }[];
}
export interface NodeManifestTurbopackBootGraph {
  readonly physicalId: string;
  readonly runtimeId: string;
  readonly exportedId: string;
  readonly evaluations: readonly string[];
  readonly initialChunks: readonly string[];
  readonly factories: readonly NodeManifestTurbopackGraphFactory[];
  readonly runtime: NodeManifestTurbopackGraphFile;
  /** Full lookup inventory for physical caller checks, including uninstalled table targets. */
  readonly lookupTables?: readonly string[];
  /** Topology alone is never a manifest exemption or an SDK normalization terminal. */
  readonly registrationIndex?: NodeManifestRegistrationIndex | undefined;
  readonly requiresReviewedRuntime: true;
}
export interface NodeManifestTurbopackEntryGraph extends NodeManifestTurbopackBootGraph {
  readonly entry: NodeManifestTurbopackSealedEntry;
  readonly requiresSdkNormalization: true;
}

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack consumer graph ${reason}; refusing native publication`,
  );
}

function checkedIdentity(source: NodeManifestTurbopackSource): void {
  if (createHash('sha256').update(source.code).digest('hex') !== source.sha256)
    refuse('source identity');
}

function checkedProgram(source: NodeManifestTurbopackSource): Node {
  checkedIdentity(source);
  const program: unknown = parseAst(source.code);
  if (!isNode(program) || program.type !== 'Program') refuse('source program');
  return program;
}

function moduleId(value: unknown): NodeManifestTurbopackModuleId {
  return turbopackModuleId(value) ?? refuse('dynamic or invalid entry module id');
}

function argument(call: Node): unknown {
  if (call['optional'] === true || listOf(call, 'arguments').length !== 1)
    refuse('entry call arity');
  return listOf(call, 'arguments')[0];
}

function runtimeCall(value: unknown, name: string, method: 'c' | 'm'): Node {
  if (!isNode(value) || value.type !== 'CallExpression') return refuse('entry runtime call');
  const member = value['callee'];
  if (
    !isNode(member) ||
    member.type !== 'MemberExpression' ||
    member['optional'] === true ||
    !identifier(member['object']) ||
    member['object'].name !== name ||
    propertyName(member) !== method
  )
    return refuse('entry runtime receiver');
  return value;
}

function publicPath(value: unknown): string {
  const text = stringOf(value);
  if (
    text === undefined ||
    text.length === 0 ||
    text.includes('\\') ||
    text.startsWith('/') ||
    text.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  )
    refuse('unsealed public chunk path');
  return text;
}

function bootRuntime(statement: unknown): {
  readonly name: string;
  readonly runtimeSpecifier: string;
  readonly publicPath: string;
} {
  if (!isNode(statement) || statement.type !== 'VariableDeclaration' || statement['kind'] !== 'var')
    return refuse('runtime bootstrap declaration');
  const declarations = listOf(statement, 'declarations');
  const only = declarations[0];
  if (declarations.length !== 1 || !isNode(only) || !identifier(only['id']))
    return refuse('runtime bootstrap binding');
  if (['exports', 'module', 'require'].includes(only['id'].name))
    refuse('runtime bootstrap shadow');
  const init = only['init'];
  if (!isNode(init) || init.type !== 'CallExpression') return refuse('runtime bootstrap call');
  const source = publicPath(argument(init));
  const required = init['callee'];
  if (
    !isNode(required) ||
    required.type !== 'CallExpression' ||
    !identifier(required['callee']) ||
    required['callee'].name !== 'require'
  )
    return refuse('runtime require');
  const specifier = stringOf(argument(required));
  if (specifier === undefined || !specifier.startsWith('.') || specifier.includes('\\'))
    refuse('runtime relative resolution');
  return { name: only['id'].name, runtimeSpecifier: specifier, publicPath: source };
}

// eslint-disable-next-line sonarjs/function-return-type -- Next.js ModuleId preserves runtime-distinct number and string Map keys.
function exportedModule(statement: unknown, name: string): NodeManifestTurbopackModuleId {
  if (!isNode(statement) || statement.type !== 'ExpressionStatement')
    return refuse('entry export statement');
  const expression = statement['expression'];
  if (
    !isNode(expression) ||
    expression.type !== 'AssignmentExpression' ||
    expression['operator'] !== '='
  )
    return refuse('entry export assignment');
  const target = expression['left'];
  const value = expression['right'];
  if (
    !isNode(target) ||
    target.type !== 'MemberExpression' ||
    !identifier(target['object']) ||
    target['object'].name !== 'module' ||
    propertyName(target) !== 'exports' ||
    !isNode(value) ||
    value.type !== 'MemberExpression' ||
    value['optional'] === true ||
    propertyName(value) !== 'exports'
  )
    return refuse('entry export object');
  return moduleId(argument(runtimeCall(value['object'], name, 'm')));
}

/** Exact Node entry producer at Next29bbe node/entry/chunk.rs, blob57872ab93df54bd9780b06ade62f3b4ff09a35ad. */
export function inspectNodeManifestTurbopackEntry(
  source: NodeManifestTurbopackSource,
): NodeManifestTurbopackEntry {
  const program = checkedProgram(source);
  let statements = listOf(program, 'body');
  const first = statements[0];
  if (
    isNode(first) &&
    first.type === 'ExpressionStatement' &&
    stringOf(first['expression']) === 'use strict'
  )
    statements = statements.slice(1);
  const runtime = bootRuntime(statements[0]);
  const chunks = new Set<string>();
  const evaluations: NodeManifestTurbopackModuleId[] = [];
  let evaluating = false;
  const loading = statements.slice(1, -1);
  for (const statement of loading) {
    if (
      !isNode(statement) ||
      statement.type !== 'ExpressionStatement' ||
      !isNode(statement['expression'])
    )
      refuse('entry loading statement');
    const call = statement['expression'];
    const callee = call['callee'];
    if (!evaluating && isNode(callee) && propertyName(callee) === 'c') {
      const chunk = publicPath(argument(runtimeCall(call, runtime.name, 'c')));
      if (chunks.has(chunk)) refuse('duplicate loaded chunk');
      chunks.add(chunk);
    } else {
      evaluating = true;
      const evaluated = argument(runtimeCall(call, runtime.name, 'm'));
      evaluations.push(moduleId(evaluated));
    }
  }
  const exportedId = exportedModule(statements.at(-1), runtime.name);
  return {
    runtimeSpecifier: runtime.runtimeSpecifier,
    publicPath: runtime.publicPath,
    chunks: [...chunks],
    evaluations,
    exportedId,
  };
}

function byId(
  sources: readonly NodeManifestTurbopackGraphFile[],
): ReadonlyMap<string, NodeManifestTurbopackGraphFile> {
  const result = new Map<string, NodeManifestTurbopackGraphFile>();
  const physical = new Set<string>();
  for (const source of sources) {
    checkedIdentity(source.source);
    if (!path.isAbsolute(source.file)) refuse('non-physical source identity');
    if (result.has(source.id) || physical.has(source.file)) refuse('ambiguous physical module');
    result.set(source.id, source);
    physical.add(source.file);
  }
  return result;
}

function resolved(source: NodeManifestTurbopackGraphFile, specifier: string): string {
  const edges = source.imports.filter((edge) => edge.specifier === specifier);
  const targets = new Set(edges.map((edge) => edge.target));
  if (targets.size !== 1) return refuse('missing or ambiguous actual import edge');
  const only = targets.values().next().value;
  return only ?? refuse('missing actual import target');
}

function runtimeTables(
  runtime: NodeManifestTurbopackGraphFile,
  sources: ReadonlyMap<string, NodeManifestTurbopackGraphFile>,
  runtimeIds: ReadonlySet<string>,
  cohort: NodeManifestRuntimeCohort | undefined,
): readonly NodeManifestTurbopackGraphFile[] {
  const tables = new Map<string, NodeManifestTurbopackGraphFile>();
  for (const edge of runtime.imports) {
    if (isBuiltin(edge.target)) continue;
    // Closing the runtime's dynamic chunk lookup can include its own physical module. Its
    // production body has a separate proof obligation; it is never a registration table.
    if (edge.target === runtime.id) continue;
    if (runtimeIds.has(edge.target)) {
      if (cohort === undefined || !nodeManifestRuntimeCohortLookup(cohort, runtime.id, edge))
        refuse('unproved cross-runtime table edge');
      continue;
    }
    const table = sources.get(edge.target);
    if (table === undefined) refuse('unclosed runtime table target');
    tables.set(table.id, table);
  }
  return [...tables.values()];
}

export function nodeManifestTurbopackBootGraph(input: {
  readonly distDir: string;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly file: string;
  readonly runtimeCohort?: NodeManifestRuntimeCohort | undefined;
  readonly registrationScope?: NodeManifestRegistrationScope | undefined;
}): NodeManifestTurbopackBootGraph {
  const sources = byId(input.sources);
  const entry = input.sources.find((source) => source.file === input.file);
  if (entry === undefined) return refuse('missing sealed route source');
  const boot = inspectNodeManifestTurbopackEntry(entry.source);
  if (path.resolve(input.distDir, boot.publicPath) !== input.file)
    refuse('route bootstrap public path mismatch');
  const runtimeId = resolved(entry, boot.runtimeSpecifier);
  const runtime = sources.get(runtimeId);
  if (runtime === undefined) refuse('missing physical runtime source');
  const runtimeIds = new Set(
    input.runtimeCohort === undefined
      ? [runtimeId]
      : nodeManifestRuntimeCohortSources(input.runtimeCohort, input.sources).map(
          (identity) => identity.id,
        ),
  );
  if (!runtimeIds.has(runtimeId)) refuse('runtime outside certified cohort');
  // Runtime certification is deliberately a separate source obligation. The graph result
  // never grants a manifest exemption merely because a file calls itself a runtime.
  const initialChunks = boot.chunks.map((chunk) => {
    const file = path.resolve(input.distDir, chunk);
    const target = input.sources.find((source) => source.file === file);
    if (target === undefined || runtime.imports.every((edge) => edge.target !== target.id))
      refuse('unclosed loaded chunk');
    if (runtimeIds.has(target.id)) refuse('runtime used as a factory table');
    return target.id;
  });
  const lookup = runtimeTables(runtime, sources, runtimeIds, input.runtimeCohort);
  const tables = nodeManifestRuntimeTables({
    distDir: input.distDir,
    runtime,
    sources: input.sources,
    tables: lookup,
    runtimeIds,
    cohort: input.runtimeCohort,
  });
  const registrationIndex = nodeManifestRegistrationIndex({
    distDir: input.distDir,
    runtime,
    sources: input.sources,
    tables,
    cohort: input.runtimeCohort,
    scope: input.registrationScope,
  });
  const view = nodeManifestRegistrationView(registrationIndex, input.sources);
  const initialTables = new Set(initialChunks);
  const initialTargetOf = (id: NodeManifestTurbopackModuleId): string =>
    nodeManifestInitialRegistration(registrationIndex, input.sources, id, initialTables);
  return {
    physicalId: entry.id,
    runtimeId,
    exportedId: initialTargetOf(boot.exportedId),
    evaluations: boot.evaluations.map((id) => initialTargetOf(id)),
    initialChunks,
    factories: view.rows,
    registrationIndex,
    runtime,
    lookupTables: Object.freeze(lookup.map((table) => table.id)),
    requiresReviewedRuntime: true,
  };
}

export function nodeManifestTurbopackEntryGraph(input: {
  readonly distDir: string;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly entry: NodeManifestTurbopackSealedEntry;
  readonly runtimeCohort?: NodeManifestRuntimeCohort | undefined;
  readonly registrationScope?: NodeManifestRegistrationScope | undefined;
}): NodeManifestTurbopackEntryGraph {
  return {
    ...nodeManifestTurbopackBootGraph({ ...input, file: input.entry.file }),
    entry: input.entry,
    requiresSdkNormalization: true,
  };
}
