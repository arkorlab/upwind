import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { identifier, propertyName, stringOf } from './node-manifest-consumer-ast.ts';
import { assertTurbopackCacheOwners } from './node-manifest-turbopack-cache.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
  turbopackModuleId,
  turbopackModuleSpecifier,
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
}
export interface NodeManifestTurbopackGraphFactory {
  readonly id: string;
  readonly physicalId: string;
  readonly projection: NodeManifestTurbopackProjection;
  readonly imports: readonly { readonly specifier: string; readonly target: string }[];
}
export interface NodeManifestTurbopackEntryGraph {
  readonly entry: NodeManifestTurbopackSealedEntry;
  readonly physicalId: string;
  readonly runtimeId: string;
  readonly exportedId: string;
  readonly evaluations: readonly string[];
  readonly initialChunks: readonly string[];
  readonly factories: readonly NodeManifestTurbopackGraphFactory[];
  readonly runtime: NodeManifestTurbopackGraphFile;
  /** Topology alone is never a manifest exemption or an SDK normalization terminal. */
  readonly requiresReviewedRuntime: true;
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

/** Metadata-only identity; it is never registered as a bundler or physical source module. */
function factoryId(physical: string, id: NodeManifestTurbopackModuleId): string {
  return `${physical}#${turbopackModuleSpecifier(id)}`;
}

function runtimeTables(
  runtime: NodeManifestTurbopackGraphFile,
  sources: ReadonlyMap<string, NodeManifestTurbopackGraphFile>,
): readonly NodeManifestTurbopackGraphFile[] {
  const tables = new Map<string, NodeManifestTurbopackGraphFile>();
  for (const edge of runtime.imports) {
    if (isBuiltin(edge.target)) continue;
    // Closing the runtime's dynamic chunk lookup can include its own physical module. Its
    // production body has a separate proof obligation; it is never a registration table.
    if (edge.target === runtime.id) continue;
    const table = sources.get(edge.target);
    if (table === undefined) refuse('unclosed runtime table target');
    tables.set(table.id, table);
  }
  return [...tables.values()];
}

const MAX_DIAGNOSTIC_REASONS = 12;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 320;
const PROTOCOL_SUFFIX = '; refusing native publication';
const PROTOCOL_PREFIXES = [
  'Unproved Next.js Turbopack manifest ',
  'Unproved Next.js Turbopack cache initializer ',
];

/** Only our bounded structural protocol errors are safe to combine; never parser error text. */
class FactoryDiagnostics {
  private readonly reasons = new Map<string, number>();
  private failures = 0;
  private omitted = 0;

  capture(error: unknown): void {
    if (
      !(error instanceof AuditError) ||
      error.message.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH ||
      PROTOCOL_PREFIXES.every((prefix) => !error.message.startsWith(prefix)) ||
      !error.message.endsWith(PROTOCOL_SUFFIX)
    )
      throw error;
    this.failures += 1;
    const count = this.reasons.get(error.message);
    if (count !== undefined) this.reasons.set(error.message, count + 1);
    else if (this.reasons.size < MAX_DIAGNOSTIC_REASONS) this.reasons.set(error.message, 1);
    else this.omitted += 1;
  }

  assertNone(): void {
    if (this.failures === 0) return;
    const reasons = [...this.reasons].map(([reason, count]) => `${count}x ${reason}`).join(' | ');
    throw new AuditError(
      `Unproved Next.js Turbopack manifest diagnostics (${this.failures} failures; ${this.reasons.size} reasons shown; ${this.omitted} omitted failures): ${reasons}`,
    );
  }
}

interface FactoryRecord {
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly projection: NodeManifestTurbopackProjection;
}

function factoryRecords(
  tables: readonly NodeManifestTurbopackGraphFile[],
): ReadonlyMap<NodeManifestTurbopackModuleId, FactoryRecord> {
  const records: [NodeManifestTurbopackModuleId, FactoryRecord][] = [];
  const diagnostics = new FactoryDiagnostics();
  for (const table of tables) {
    let factories: ReturnType<typeof nodeManifestTurbopackFactories>;
    try {
      factories = nodeManifestTurbopackFactories(table.source);
    } catch (error) {
      diagnostics.capture(error);
      continue;
    }
    for (const factory of factories) {
      for (const id of factory.ids) {
        try {
          const projection = projectNodeManifestTurbopackFactory(table.source, id, 'dependencies');
          records.push([id, { physical: table, projection }]);
        } catch (error) {
          diagnostics.capture(error);
        }
      }
    }
  }
  // No successful subset may reach duplicate/owner checks or become a usable graph.
  diagnostics.assertNone();
  const result = new Map<NodeManifestTurbopackModuleId, FactoryRecord>();
  for (const [id, record] of records) {
    if (result.has(id)) refuse('duplicate module id across loaded chunks');
    result.set(id, record);
  }
  return result;
}

export function nodeManifestTurbopackEntryGraph(input: {
  readonly distDir: string;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly entry: NodeManifestTurbopackSealedEntry;
}): NodeManifestTurbopackEntryGraph {
  const sources = byId(input.sources);
  const entry = input.sources.find((source) => source.file === input.entry.file);
  if (entry === undefined) return refuse('missing sealed route source');
  const boot = inspectNodeManifestTurbopackEntry(entry.source);
  if (path.resolve(input.distDir, boot.publicPath) !== input.entry.file)
    refuse('route bootstrap public path mismatch');
  const runtimeId = resolved(entry, boot.runtimeSpecifier);
  const runtime = sources.get(runtimeId);
  if (runtime === undefined) refuse('missing physical runtime source');
  // Runtime certification is deliberately a separate source obligation. The graph result
  // never grants a manifest exemption merely because a file calls itself a runtime.
  const initialChunks = boot.chunks.map((chunk) => {
    const file = path.resolve(input.distDir, chunk);
    const target = input.sources.find((source) => source.file === file);
    if (target === undefined || runtime.imports.every((edge) => edge.target !== target.id))
      refuse('unclosed loaded chunk');
    if (target.id === runtime.id) refuse('runtime used as a factory table');
    return target.id;
  });
  // ctx.l can load a deferred table not present among initial R.c calls. Close the
  // entire rewritten runtime table, not just the entry's initial loading cohort.
  const tables = runtimeTables(runtime, sources);
  const factories = factoryRecords(tables);
  assertTurbopackCacheOwners([...factories.values()], new Set(factories.keys()));
  const logicalIds = new Map<string, NodeManifestTurbopackModuleId>();
  const targetOf = (id: NodeManifestTurbopackModuleId): string => {
    const target = factories.get(id);
    if (target === undefined) return refuse('unregistered module dependency');
    const logical = factoryId(target.physical.id, id);
    if (sources.has(logical)) refuse('factory metadata identity collision');
    const previous = logicalIds.get(logical);
    if (previous !== undefined && previous !== id) refuse('factory logical identity collision');
    logicalIds.set(logical, id);
    return logical;
  };
  const modules = [...factories].map(([id, factory]) => {
    return {
      id: targetOf(id),
      physicalId: factory.physical.id,
      projection: factory.projection,
      imports: factory.projection.imports.map((edge) => {
        if (edge.targetId !== undefined)
          return { specifier: edge.specifier, target: targetOf(edge.targetId) };
        return {
          specifier: edge.specifier,
          target: isBuiltin(edge.specifier)
            ? edge.specifier
            : resolved(factory.physical, edge.specifier),
        };
      }),
    };
  });
  const initialTables = new Set(initialChunks);
  const initialTargetOf = (id: NodeManifestTurbopackModuleId): string => {
    const factory = factories.get(id);
    if (factory === undefined || !initialTables.has(factory.physical.id))
      refuse('entry module is not initially registered');
    return targetOf(id);
  };
  return {
    entry: input.entry,
    physicalId: entry.id,
    runtimeId,
    exportedId: initialTargetOf(boot.exportedId),
    evaluations: boot.evaluations.map((id) => initialTargetOf(id)),
    initialChunks,
    factories: modules,
    runtime,
    requiresReviewedRuntime: true,
    requiresSdkNormalization: true,
  };
}
