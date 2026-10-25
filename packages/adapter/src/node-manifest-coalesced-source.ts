import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { assertCoalescedPagesClosure } from './node-manifest-coalesced-closure.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  stringOf,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import {
  turbopackModuleId,
  turbopackModuleSpecifier,
  type NodeManifestTurbopackProjection,
  type NodeManifestTurbopackCacheInitializer,
} from './node-manifest-turbopack.ts';

export const COALESCED_NAMESPACE = '__upwind_coalesced_userland_namespace__';
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly code: string;
}
interface ImportCall {
  readonly call: Node;
  readonly declaration?: Node;
  readonly protected: boolean;
}
interface OriginalContext {
  readonly program: Node;
  readonly factory: Node;
  readonly body: Node;
  readonly context: string;
  readonly scope: Scope;
  readonly visits: readonly Visit[];
  readonly parents: ReadonlyMap<Node, Visit>;
}
const VALUE_RECORD_WIDTH = 3;

function refuse(reason: string): never {
  throw new AuditError(`Unproved coalesced Pages userland ${reason}; refusing native publication`);
}
function bindingScope(name: string, scopes: readonly Scope[]): Scope | undefined {
  return scopes.findLast((scope) => scope.declared.has(name));
}
function strict(statement: unknown): boolean {
  if (!isNode(statement) || statement.type !== 'ExpressionStatement') return false;
  const value = statement['expression'];
  return (
    isNode(value) &&
    value.type === 'Literal' &&
    value.start === statement.start &&
    (value['raw'] === '"use strict"' || value['raw'] === "'use strict'")
  );
}
function originalContext(projection: NodeManifestTurbopackProjection): OriginalContext {
  const program: unknown = parseAst(projection.original.code);
  if (!isNode(program)) return refuse('original parser');
  const all = visitTree(program);
  const parents = new Map(all.map((visit) => [visit.node, visit]));
  const found = all.find(
    ({ node }) => node.start === projection.factory.start && node.end === projection.factory.end,
  );
  const factory = found?.node;
  const body = factory?.['body'];
  const param = factory === undefined ? undefined : listOf(factory, 'params')[0];
  const scope = found?.scopes.at(-1);
  if (factory === undefined || scope === undefined || !isNode(body) || !identifier(param))
    return refuse('factory identity');
  let ancestor: Node | undefined = factory;
  let isStrict = false;
  while (ancestor !== undefined) {
    const block = ancestor['body'];
    if (
      (ancestor.type === 'Program' && strict(listOf(ancestor, 'body')[0])) ||
      (isNode(block) && block.type === 'BlockStatement' && strict(listOf(block, 'body')[0]))
    )
      isStrict = true;
    ancestor = parents.get(ancestor)?.parent;
  }
  if (!isStrict) return refuse('original factory strictness');
  if (all.some(({ node }) => identifier(node) && node.name.startsWith(COALESCED_NAMESPACE)))
    return refuse('reserved namespace identity');
  return {
    program,
    factory,
    body,
    context: param.name,
    scope,
    parents,
    visits: all.filter(({ node }) => node.start >= body.start && node.end <= body.end),
  };
}
function contextMethod(visit: Visit, original: OriginalContext): string | undefined {
  const node = visit.node;
  const object = node['object'];
  return node.type === 'MemberExpression' &&
    node['optional'] !== true &&
    identifier(object) &&
    object.name === original.context &&
    bindingScope(object.name, visit.scopes) === original.scope
    ? propertyName(node)
    : undefined;
}
function directCall(visit: Visit): Node | undefined {
  return visit.parent?.type === 'CallExpression' &&
    visit.parent['callee'] === visit.node &&
    visit.parent['optional'] !== true
    ? visit.parent
    : undefined;
}
function unboundCall(visit: Visit, original: OriginalContext): Node | undefined {
  const sequence = visit.parent;
  const call = sequence === undefined ? undefined : original.parents.get(sequence)?.parent;
  return sequence?.type === 'SequenceExpression' &&
    call?.type === 'CallExpression' &&
    call['callee'] === sequence
    ? call
    : undefined;
}
function topStatement(node: Node, original: OriginalContext): Node {
  const parent = original.parents.get(node)?.parent;
  if (
    parent?.type !== 'ExpressionStatement' ||
    parent['expression'] !== node ||
    original.parents.get(parent)?.parent !== original.body
  )
    return refuse('non-standalone cache write');
  return parent;
}
function tableValues(table: Node): readonly Node[] {
  const rows = listOf(table, 'elements');
  const names = new Set<string>();
  const values: Node[] = [];
  for (let index = 0; index < rows.length; index += VALUE_RECORD_WIDTH) {
    const name = stringOf(rows[index]);
    const tag = rows[index + 1];
    const value = rows[index + 2];
    if (
      name === undefined ||
      names.has(name) ||
      !isNode(tag) ||
      tag.type !== 'Literal' ||
      tag['value'] !== 0 ||
      !isNode(value)
    )
      return refuse('non-value userland table');
    names.add(name);
    values.push(value);
  }
  return values.length === 0 ? refuse('empty userland table') : values;
}
interface CacheUse {
  readonly method: string;
  readonly call: Node;
  readonly args: readonly unknown[];
  readonly direct: boolean;
}
function cacheUse(visit: Visit, original: OriginalContext): CacheUse | undefined {
  const method = contextMethod(visit, original);
  if (method === undefined) return undefined;
  const direct = directCall(visit);
  const call = direct ?? unboundCall(visit, original);
  return call === undefined
    ? undefined
    : { method, call, args: listOf(call, 'arguments'), direct: direct === call };
}
function cacheWrite(
  use: CacheUse,
  entry: NodeManifestTurbopackCacheInitializer,
  selected: string | number,
): Node | undefined {
  if (!['n', 's', 'v'].includes(use.method)) return undefined;
  const target = turbopackModuleId(use.args[1]);
  if (target !== entry.id) {
    if (target !== undefined && target !== selected) refuse('another export target');
    return undefined;
  }
  if (
    !use.direct ||
    use.method !== 's' ||
    use.args.length !== 2 ||
    use.call.start !== entry.start ||
    use.call.end !== entry.end
  )
    return refuse('unique cache write');
  return use.call;
}
function cacheRead(use: CacheUse, entry: NodeManifestTurbopackCacheInitializer): Node | undefined {
  if (!['A', 'i', 'r'].includes(use.method) || turbopackModuleId(use.args[0]) !== entry.id)
    return undefined;
  if (!use.direct || use.method !== 'i' || use.args.length !== 1)
    return refuse('unique namespace read');
  return use.call;
}
function namespaceDeclaration(original: OriginalContext, write: Node, read: Node) {
  const statement = topStatement(write, original);
  const variable = original.parents.get(read)?.parent;
  const group = variable === undefined ? undefined : original.parents.get(variable)?.parent;
  const table = listOf(write, 'arguments')[0];
  if (
    variable?.type !== 'VariableDeclarator' ||
    variable['init'] !== read ||
    !identifier(variable['id']) ||
    group?.type !== 'VariableDeclaration' ||
    original.parents.get(group)?.parent !== original.body ||
    !isNode(table) ||
    table.type !== 'ArrayExpression'
  )
    return refuse('immediate namespace declaration');
  return { write, statement, read, variable, group, table, values: tableValues(table) };
}
function protocol(original: OriginalContext, projection: NodeManifestTurbopackProjection) {
  const entry = projection.cacheInitializers[0];
  if (entry === undefined || projection.cacheInitializers.length !== 1)
    return refuse('cache ownership');
  let write: Node | undefined;
  let read: Node | undefined;
  for (const visit of original.visits) {
    const use = cacheUse(visit, original);
    if (use === undefined) continue;
    const nextWrite = cacheWrite(use, entry, projection.moduleId);
    const nextRead = cacheRead(use, entry);
    if (nextWrite !== undefined) {
      if (write !== undefined) return refuse('unique cache write');
      write = nextWrite;
    }
    if (nextRead !== undefined) {
      if (read !== undefined) return refuse('unique namespace read');
      read = nextRead;
    }
  }
  if (write === undefined || read === undefined || read.start <= write.end)
    return refuse('cache write/read order');
  return namespaceDeclaration(original, write, read);
}
function importSpecifier(visit: Visit, original: OriginalContext): string | undefined {
  const call = visit.node;
  if (call.type === 'ImportExpression') return stringOf(call['source']);
  if (call.type !== 'CallExpression' || call['optional'] === true) return undefined;
  const callee = call['callee'];
  if (
    identifier(callee) &&
    callee.name === 'require' &&
    declaration('require', visit.scopes) === undefined
  )
    return stringOf(listOf(call, 'arguments')[0]);
  const member = isNode(callee) ? original.parents.get(callee) : undefined;
  if (member === undefined) return undefined;
  const method = contextMethod(member, original);
  const value = listOf(call, 'arguments')[0];
  if (method === 'x') return stringOf(value);
  const id = turbopackModuleId(value);
  return id !== undefined && (method === 'i' || method === 'r')
    ? turbopackModuleSpecifier(id)
    : undefined;
}
function originalImports(
  original: OriginalContext,
  privileged: ReadonlySet<string>,
): readonly ImportCall[] {
  const imports: ImportCall[] = [];
  for (const visit of original.visits) {
    const specifier = importSpecifier(visit, original);
    if (specifier === undefined) continue;
    const parent = visit.parent;
    const group = parent === undefined ? undefined : original.parents.get(parent)?.parent;
    const direct =
      parent?.type === 'VariableDeclarator' &&
      parent['init'] === visit.node &&
      group?.type === 'VariableDeclaration' &&
      original.parents.get(group)?.parent === original.body;
    imports.push({
      call: visit.node,
      ...(direct && { declaration: parent }),
      protected: privileged.has(specifier),
    });
  }
  return imports;
}
function written(visit: Visit, original: OriginalContext): boolean {
  let value = visit.node;
  for (
    let parent = visit.parent;
    parent !== undefined;
    parent = original.parents.get(value)?.parent
  ) {
    if (parent.type === 'MemberExpression' && parent['object'] === value) {
      value = parent;
      continue;
    }
    if (
      ['AssignmentExpression', 'AssignmentPattern', 'ForInStatement', 'ForOfStatement'].includes(
        parent.type,
      )
    )
      return parent['left'] === value;
    if (parent.type === 'UpdateExpression') return parent['argument'] === value;
    if (parent.type === 'UnaryExpression' && parent['operator'] === 'delete') return true;
    if (['ArrayPattern', 'ObjectPattern', 'Property', 'RestElement'].includes(parent.type)) {
      value = parent;
      continue;
    }
    return false;
  }
  return false;
}
function stableImport(variable: Node, original: OriginalContext): void {
  const id = variable['id'];
  if (!identifier(id)) return refuse('import binding pattern');
  const at = original.parents.get(id);
  const scope = at === undefined ? undefined : bindingScope(id.name, at.scopes);
  if (scope === undefined) return refuse('import binding scope');
  for (const visit of original.visits) {
    if (
      !identifier(visit.node) ||
      visit.node.name !== id.name ||
      bindingScope(id.name, visit.scopes) !== scope
    )
      continue;
    stableImportUse(visit, { id, variable, original });
  }
}
function stableImportUse(
  visit: Visit,
  input: { readonly id: Node; readonly variable: Node; readonly original: OriginalContext },
): void {
  if (visit.node === input.id) return;
  if (visit.parent?.type === 'VariableDeclarator' && visit.key === 'id')
    return refuse('import redeclaration');
  if (reference(visit) && (visit.node.start < input.variable.end || written(visit, input.original)))
    return refuse('unstable import binding');
}
function tableBindings(original: OriginalContext, table: Node): readonly Node[] {
  const bindings: Node[] = [];
  for (const value of visitTree(table)) {
    if (!identifier(value.node) || !reference(value)) continue;
    const actual = original.parents.get(value.node);
    const binding =
      actual === undefined ? undefined : declaration(value.node.name, actual.scopes)?.node;
    if (binding !== undefined) bindings.push(binding);
  }
  return bindings;
}
function forbiddenBindings(
  original: OriginalContext,
  read: Node,
  selected: string | number,
): ReadonlySet<Node> {
  const forbidden = new Set<Node>([read]);
  for (const visit of original.visits) {
    if (contextMethod(visit, original) !== 's') continue;
    const call = directCall(visit);
    if (call === undefined) continue;
    const target = turbopackModuleId(listOf(call, 'arguments')[1]);
    if (target !== undefined && target !== selected) continue;
    const table = listOf(call, 'arguments')[0];
    if (!isNode(table)) continue;
    const bindings = tableBindings(original, table);
    for (const binding of bindings) forbidden.add(binding);
  }
  return forbidden;
}
function adjacent(
  original: OriginalContext,
  write: Node,
  readGroup: Node,
  imports: readonly ImportCall[],
): void {
  const known = new Set(
    imports.flatMap((entry) => (entry.declaration === undefined ? [] : [entry.declaration])),
  );
  for (const statement of listOf(original.body, 'body')) {
    if (!isNode(statement) || statement.start < write.end || statement.start >= readGroup.start)
      continue;
    if (statement.type === 'FunctionDeclaration' || statement.type === 'EmptyStatement') continue;
    if (
      statement.type === 'VariableDeclaration' &&
      listOf(statement, 'declarations').every((variable) => isNode(variable) && known.has(variable))
    )
      continue;
    return refuse('effect or unproved statement between write and read');
  }
}
function apply(code: string, edits: readonly Edit[]): string {
  let end = code.length;
  let output = code;
  const sorted = edits.toSorted((left, right) => right.start - left.start);
  for (const edit of sorted) {
    if (edit.end > end) return refuse('overlapping partition');
    output = output.slice(0, edit.start) + edit.code + output.slice(edit.end);
    end = edit.start;
  }
  return output;
}

interface Partition {
  readonly original: OriginalContext;
  readonly source: string;
  readonly namespace: { readonly variable: Node; readonly group: Node };
  readonly owned: ReadonlySet<Node>;
  readonly imported: ReadonlySet<Node>;
}
function declarationText(variable: Node, input: Partition): string {
  const init = variable['init'];
  if (variable === input.namespace.variable && isNode(init))
    return input.source.slice(variable.start, init.start) + COALESCED_NAMESPACE;
  return input.source.slice(variable.start, variable.end);
}
function declarationGroup(statement: Node, input: Partition): Edit | undefined {
  if (input.owned.has(statement)) return { start: statement.start, end: statement.end, code: '' };
  if (statement.type !== 'VariableDeclaration') return undefined;
  const declarations = listOf(statement, 'declarations').filter(isNode);
  const kept = declarations.filter((variable) => !input.owned.has(variable));
  const normal = kept.length > 0 && kept.every((variable) => input.imported.has(variable));
  if (!normal && statement === input.namespace.group) return refuse('effectful namespace sibling');
  if (!normal && kept.length === declarations.length) return undefined;
  if (normal) {
    for (const variable of kept) stableImport(variable, input.original);
  }
  const parts = kept.map((variable) => declarationText(variable, input));
  let code = '';
  if (normal) code = parts.map((part) => `const ${part};`).join('');
  else if (kept.length > 0) code = `${String(statement['kind'])} ${parts.join(',')};`;
  return { start: statement.start, end: statement.end, code };
}

/** Derive an inert view only; the caller must retain every original dependency and audit gate. */
export function coalescedPagesSource(
  projection: NodeManifestTurbopackProjection,
  privileged: ReadonlySet<string>,
): string {
  const original = originalContext(projection);
  const cache = protocol(original, projection);
  const imports = originalImports(original, privileged);
  adjacent(original, cache.statement, cache.group, imports);
  const forbidden = forbiddenBindings(original, cache.variable, projection.moduleId);
  const owned = new Set(
    assertCoalescedPagesClosure({
      original: original.program,
      factory: original.factory,
      table: cache.table,
      tableValues: cache.values,
      imports,
      forbidden,
    }),
  );
  const edits: Edit[] = [{ start: cache.statement.start, end: cache.statement.end, code: '' }];
  const imported = new Set(
    imports.flatMap((entry) => (entry.declaration === undefined ? [] : [entry.declaration])),
  );
  imported.add(cache.variable);
  const statements = listOf(original.body, 'body');
  const partition = {
    original,
    namespace: cache,
    owned,
    imported,
    source: projection.original.code,
  };
  for (const statement of statements) {
    if (!isNode(statement)) continue;
    const edit = declarationGroup(statement, partition);
    if (edit !== undefined) edits.push(edit);
  }
  return apply(projection.original.code, edits);
}
