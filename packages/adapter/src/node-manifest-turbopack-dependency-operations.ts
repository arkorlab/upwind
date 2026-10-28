import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { identifier, propertyName, type Visit } from './node-manifest-consumer-ast.ts';
import {
  reexportNamespaceId,
  type NamespaceReexportInput,
} from './node-manifest-reexport-namespace.ts';
import {
  defaultExportTarget,
  turbopackModuleId,
  turbopackModuleSpecifier,
} from './node-manifest-turbopack-values.ts';
import type {
  NodeManifestTurbopackImport,
  NodeManifestTurbopackModuleId,
} from './node-manifest-turbopack.ts';

interface DependencyOperationInput extends NamespaceReexportInput {
  readonly mode: 'strict' | 'dependencies';
  readonly context: { readonly name: string; readonly scope: Scope };
  readonly factoryIds: readonly NodeManifestTurbopackModuleId[];
}
interface DependencyOperation {
  readonly imports: readonly (readonly [Node, NodeManifestTurbopackImport])[];
  readonly opaqueExports: boolean;
}
const MAX_REEXPORT_ARGUMENTS = 2;
const REEXPORT_PAIR_WIDTH = 2;

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest compact reexport ${reason}; refusing native publication`,
  );
}

function ownContext(value: unknown, visit: Visit, input: DependencyOperationInput): boolean {
  if (!identifier(value) || value.name !== input.context.name) return false;
  const scope = visit.scopes.findLast((candidate) => candidate.declared.has(value.name));
  return scope === input.context.scope && !scope.bindings.has(value.name);
}

function literalString(value: unknown): string {
  if (!isNode(value) || value.type !== 'Literal' || typeof value['value'] !== 'string')
    return refuse('name is not a literal string');
  return value['value'];
}

function separator(value: unknown): boolean {
  return isNode(value) && value.type === 'Literal' && value['value'] === 0;
}

function groupNames(entries: readonly unknown[], names: Set<string>): void {
  const strings = entries.map((entry) => literalString(entry));
  const pairs = strings.length === 1 ? strings[0]?.split(',') : strings;
  if (pairs === undefined || pairs.length % REEXPORT_PAIR_WIDTH !== 0)
    refuse('has an incomplete name pair');
  for (let index = 0; index < pairs.length; index += REEXPORT_PAIR_WIDTH) {
    const name = pairs[index];
    if (name === undefined || names.has(name)) refuse('has a duplicate export name');
    names.add(name);
  }
}

function compactImports(
  call: Node,
  input: DependencyOperationInput,
): readonly (readonly [Node, NodeManifestTurbopackImport])[] {
  const table = listOf(call, 'arguments')[0];
  if (!isNode(table) || table.type !== 'ArrayExpression') return refuse('table is not literal');
  const entries = listOf(table, 'elements');
  const names = new Set<string>();
  const imports: (readonly [Node, NodeManifestTurbopackImport])[] = [];
  for (let index = 0; index < entries.length;) {
    const head = entries[index];
    const id = turbopackModuleId(head) ?? reexportNamespaceId(head, input);
    if (id === undefined || !isNode(head)) refuse('has an unknown namespace or module ID');
    index += 1;
    const start = index;
    while (index < entries.length && !separator(entries[index])) index += 1;
    groupNames(entries.slice(start, index), names);
    // An empty group still instantiates its head in the original runtime.
    const dependency: NodeManifestTurbopackImport = Object.freeze({
      kind: 'import',
      specifier: turbopackModuleSpecifier(id),
      targetId: id,
    });
    imports.push(Object.freeze([head, dependency] as const));
    index += 1;
  }
  return Object.freeze(imports);
}

function compactReexports(visit: Visit, input: DependencyOperationInput): DependencyOperation {
  const call = visit.parent;
  if (call?.type !== 'CallExpression' || call['callee'] !== visit.node || call['optional'] === true)
    return refuse('method escapes its direct call');
  const args = listOf(call, 'arguments');
  if (
    args.length === 0 ||
    args.length > MAX_REEXPORT_ARGUMENTS ||
    args.some((arg) => !isNode(arg) || arg.type === 'SpreadElement')
  )
    refuse('call arguments');
  if (!defaultExportTarget(args[1], visit)) {
    const target = turbopackModuleId(args[1]);
    if (target === undefined || !input.factoryIds.includes(target)) refuse('export target');
  }
  return Object.freeze({ imports: compactImports(call, input), opaqueExports: true });
}

/** Dependency inspection only; neither operation certifies any protected export selector. */
export function turbopackDependencyOperation(
  visit: Visit,
  input: DependencyOperationInput,
): DependencyOperation | undefined {
  const member = visit.node;
  if (
    input.mode !== 'dependencies' ||
    member.type !== 'MemberExpression' ||
    member['optional'] === true ||
    member['computed'] === true ||
    !ownContext(member['object'], visit, input)
  )
    return undefined;
  const name = propertyName(member);
  if (name === 'S') return compactReexports(visit, input);
  const sequence = visit.parent;
  if (name !== 'r' || sequence?.type !== 'SequenceExpression') return undefined;
  const operands = listOf(sequence, 'expressions');
  const index = operands.indexOf(member);
  if (index === -1 || index === operands.length - 1) return undefined;
  // GetValue of the sealed runtime's data-function member is discarded by the comma operator.
  return Object.freeze({ imports: Object.freeze([]), opaqueExports: false });
}
