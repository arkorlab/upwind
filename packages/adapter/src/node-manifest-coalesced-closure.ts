import type { Node as AstNode } from '@oxc-project/types';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { nativeBindings } from './native-ast.ts';
import {
  identifier,
  propertyName,
  reference,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';

export interface CoalescedPagesClosureInput {
  readonly original: Node;
  readonly factory: Node;
  readonly table: Node;
  readonly tableValues: readonly Node[];
  readonly imports: readonly {
    readonly call: Node;
    readonly declaration?: Node | undefined;
    readonly protected: boolean;
  }[];
  readonly forbidden: ReadonlySet<Node>;
}
export type CoalescedPagesDeclaration = Node & {
  readonly type: 'VariableDeclarator' | 'FunctionDeclaration';
};
interface Binding {
  readonly scope: Scope;
  readonly node: Node | undefined;
}
const FUNCTIONS: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);
const IMPLICIT: ReadonlySet<string> = new Set([
  'ClassDeclaration',
  'ClassExpression',
  'ImportExpression',
  'MetaProperty',
  'Super',
  'ThisExpression',
]);
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);
const ORDINARY_CALLS: ReadonlyMap<string, string> = new Map([
  ['console', 'log'],
  ['JSON', 'stringify'],
  ['process', 'cwd'],
]);
const PRIMITIVE_UNARY: ReadonlySet<string> = new Set(['!', '+', '-', 'void', '~']);

function refuse(reason: string): never {
  throw new AuditError(`Unproved coalesced Pages closure ${reason}; refusing native publication`);
}
function within(node: Node, owner: Node): boolean {
  return node.start >= owner.start && node.end <= owner.end;
}
function binding(visit: Visit): Binding | undefined {
  if (!identifier(visit.node)) return undefined;
  for (const scope of visit.scopes.toReversed())
    if (scope.declared.has(visit.node.name))
      return { scope, node: scope.bindings.get(visit.node.name) };
  return undefined;
}
function declarationName(node: Node): string | undefined {
  return identifier(node['id']) ? node['id'].name : undefined;
}
function primitive(node: Node): boolean {
  if (node.type === 'Literal') {
    if (node['regex'] !== undefined) return false;
    const value = node['value'];
    return value === null || ['bigint', 'boolean', 'number', 'string'].includes(typeof value);
  }
  return (
    node.type === 'UnaryExpression' &&
    PRIMITIVE_UNARY.has(String(node['operator'])) &&
    isNode(node['argument']) &&
    primitive(node['argument'])
  );
}
function selector(node: Node): boolean {
  if (identifier(node)) return true;
  if (node.type !== 'MemberExpression' || node['optional'] === true) return false;
  const key = node['property'];
  const fixed =
    node['computed'] === true
      ? isNode(key) && key.type === 'Literal' && typeof key['value'] === 'string'
      : identifier(key);
  return fixed && isNode(node['object']) && selector(node['object']);
}
function topDeclarations(factory: Node): readonly CoalescedPagesDeclaration[] {
  const body = factory['body'];
  if (!FUNCTIONS.has(factory.type) || !isNode(body) || body.type !== 'BlockStatement')
    return refuse('factory body');
  const result: CoalescedPagesDeclaration[] = [];
  for (const statement of listOf(body, 'body')) {
    if (!isNode(statement)) continue;
    if (statement.type === 'FunctionDeclaration')
      result.push(statement as CoalescedPagesDeclaration);
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of listOf(statement, 'declarations'))
      if (isNode(declaration) && declaration.type === 'VariableDeclarator')
        result.push(declaration as CoalescedPagesDeclaration);
  }
  return result;
}

class ClosureScanner {
  private readonly input: CoalescedPagesClosureInput;
  private readonly visits: readonly Visit[];
  private readonly parents: ReadonlyMap<Node, Visit>;
  private readonly children = new Map<Node, Node[]>();
  private readonly scopeOwners = new Map<Scope, Node>();
  private readonly top: ReadonlySet<CoalescedPagesDeclaration>;
  private readonly owned = new Set<CoalescedPagesDeclaration>();
  private readonly pending: Node[];
  private readonly checked = new Set<Node>();
  private readonly imports: ReadonlyMap<Node, CoalescedPagesClosureInput['imports'][number]>;
  private readonly mutable;

  constructor(input: CoalescedPagesClosureInput) {
    this.input = input;
    this.visits = visitTree(input.original);
    this.parents = new Map(this.visits.map((visit) => [visit.node, visit]));
    this.mutable = nativeBindings(input.original as unknown as AstNode);
    this.top = new Set(topDeclarations(input.factory));
    this.pending = [...input.tableValues];
    this.imports = new Map(input.imports.map((entry) => [entry.call, entry]));
    this.assertInputs();
    for (const visit of this.visits) this.registerVisit(visit);
  }

  private assertInputs(): void {
    if (
      !this.parents.has(this.input.factory) ||
      !this.parents.has(this.input.table) ||
      this.input.table.type !== 'ArrayExpression' ||
      !within(this.input.table, this.input.factory)
    )
      refuse('original factory/table identity');
    for (const value of this.input.tableValues)
      if (!this.parents.has(value) || !within(value, this.input.table))
        refuse('original value identity');
    if (this.imports.size !== this.input.imports.length) refuse('duplicate audited import');
    for (const row of this.input.imports) {
      if (!this.parents.has(row.call) || !within(row.call, this.input.factory))
        refuse('original import identity');
      if (
        row.declaration !== undefined &&
        (!this.top.has(row.declaration as CoalescedPagesDeclaration) ||
          row.declaration['init'] !== row.call)
      )
        refuse('import declarator identity');
    }
    for (const forbidden of this.input.forbidden)
      if (!this.parents.has(forbidden)) refuse('forbidden binding identity');
  }

  private registerVisit(visit: Visit): void {
    if (visit.parent !== undefined) {
      const children = this.children.get(visit.parent) ?? [];
      children.push(visit.node);
      this.children.set(visit.parent, children);
    }
    const previous =
      visit.parent === undefined ? [] : (this.parents.get(visit.parent)?.scopes ?? []);
    if (visit.scopes.length <= previous.length) return;
    const scope = visit.scopes.at(-1);
    if (scope !== undefined) this.scopeOwners.set(scope, visit.node);
  }

  private inert(node: Node): boolean {
    if (FUNCTIONS.has(node.type) || primitive(node) || selector(node)) return true;
    const imported = this.imports.get(node);
    return imported !== undefined && !imported.protected;
  }

  private own(node: Node): void {
    if (this.input.forbidden.has(node)) refuse('protected or wrapper capture');
    if (!this.top.has(node as CoalescedPagesDeclaration)) refuse('external lexical capture');
    const declaration = node as CoalescedPagesDeclaration;
    if (this.owned.has(declaration)) return;
    const name = declarationName(node);
    if (name === undefined) refuse('destructured declaration');
    const initial = node.type === 'FunctionDeclaration' ? node : node['init'];
    if (!isNode(initial) || !this.inert(initial)) refuse('effectful captured initializer');
    if (node.type !== 'FunctionDeclaration' && initial.end >= this.input.table.start)
      refuse('captured initializer after table');
    if (!this.mutable.unmodified(node as unknown as AstNode, name, true))
      refuse('captured binding mutation');
    this.owned.add(declaration);
    this.pending.push(node);
  }

  private ordinaryDeferredGlobal(visit: Visit, root: Node): boolean {
    if (!identifier(visit.node)) return false;
    const member = visit.parent;
    const call = member === undefined ? undefined : this.parents.get(member)?.parent;
    if (
      !ORDINARY_CALLS.has(visit.node.name) ||
      member?.type !== 'MemberExpression' ||
      member['object'] !== visit.node ||
      member['optional'] === true ||
      propertyName(member) !== ORDINARY_CALLS.get(visit.node.name) ||
      call?.type !== 'CallExpression' ||
      call['callee'] !== member ||
      call['optional'] === true ||
      (visit.node.name === 'process' && listOf(call, 'arguments').length > 0) ||
      !this.mutable.unmodified(visit.node, visit.node.name, true)
    )
      return false;
    return this.deferredRoot(visit, root);
  }

  private capture(visit: Visit, root: Node): void {
    if (!identifier(visit.node) || !reference(visit)) return;
    const found = binding(visit);
    if (found === undefined) {
      if (!PRIMITIVE_GLOBALS.has(visit.node.name) && !this.ordinaryDeferredGlobal(visit, root))
        refuse('unproved global capture');
      return;
    }
    const owner = this.scopeOwners.get(found.scope);
    if (found.node !== undefined && this.input.forbidden.has(found.node))
      refuse('protected or wrapper capture');
    if (owner !== undefined && within(owner, root)) return;
    if (found.node === undefined) refuse('outer factory parameter capture');
    this.own(found.node);
  }

  private assertBodyNode(node: Node): Visit {
    if (IMPLICIT.has(node.type)) refuse('implicit host or class capture');
    const name = node['id'];
    if (
      node.type === 'FunctionExpression' &&
      identifier(name) &&
      !this.mutable.unmodified(node as unknown as AstNode, name.name, true)
    )
      refuse('named function self mutation');
    const visit = this.parents.get(node);
    if (visit === undefined) refuse('node outside original source');
    return visit;
  }

  private scan(root: Node): void {
    if (this.checked.has(root)) return;
    this.checked.add(root);
    const value = root.type === 'VariableDeclarator' ? root['init'] : root;
    if (!isNode(value) || !this.inert(value)) refuse('non-inert table value');
    const pending = [root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const imported = this.imports.get(node);
      if (imported !== undefined) {
        if (imported.protected) refuse('protected framework import capture');
        continue;
      }
      this.capture(this.assertBodyNode(node), root);
      const children = this.children.get(node) ?? [];
      pending.push(...children);
    }
  }

  private deferred(visit: Visit, owner: Node): boolean {
    for (let at: Node | undefined = visit.node; at !== undefined && at !== owner;) {
      if (FUNCTIONS.has(at.type)) return true;
      at = this.parents.get(at)?.parent;
    }
    return false;
  }

  private deferredRoot(visit: Visit, root: Node): boolean {
    const body = root['body'];
    return (
      (FUNCTIONS.has(root.type) && isNode(body) && within(visit.node, body)) ||
      this.deferred(visit, root)
    );
  }

  private assertUse(visit: Visit, node: CoalescedPagesDeclaration): void {
    const owner = [...this.owned].find((candidate) => within(visit.node, candidate));
    if (owner === undefined) {
      const value = this.input.tableValues.find((candidate) => within(visit.node, candidate));
      if (value === undefined) refuse('captured binding outside table closure');
      if (selector(value)) return;
    } else if (
      node.type === 'VariableDeclarator' &&
      !this.deferred(visit, owner) &&
      node.end >= visit.node.start
    ) {
      refuse('captured initializer after use');
    }
    this.assertNoEscape(visit, node, owner);
  }

  private isPrimitive(node: Node, seen: ReadonlySet<Node> = new Set()): boolean {
    if (seen.has(node)) return false;
    if (primitive(node)) return true;
    if (!identifier(node)) return false;
    const visit = this.parents.get(node);
    const found = visit === undefined ? undefined : binding(visit);
    if (found === undefined && PRIMITIVE_GLOBALS.has(node.name)) return true;
    const declared = found?.node;
    if (declared?.type !== 'VariableDeclarator' || !isNode(declared['init'])) return false;
    return this.isPrimitive(declared['init'], new Set([...seen, node]));
  }

  private selectedUse(node: Node): Node {
    let current = node;
    for (let parent = this.parents.get(current)?.parent; parent !== undefined;) {
      if (parent.type !== 'MemberExpression' || parent['object'] !== current || !selector(parent))
        break;
      current = parent;
      parent = this.parents.get(current)?.parent;
    }
    return current;
  }

  private deferredOrdinaryImport(
    visit: Visit,
    declaration: CoalescedPagesDeclaration,
    owner: CoalescedPagesDeclaration | undefined,
  ): boolean {
    const initial = declaration['init'];
    const imported = isNode(initial) ? this.imports.get(initial) : undefined;
    if (imported?.protected !== false) return false;
    const root = owner ?? this.input.tableValues.find((candidate) => within(visit.node, candidate));
    return root !== undefined && this.deferredRoot(visit, root);
  }

  private assertNoEscape(
    visit: Visit,
    declaration: CoalescedPagesDeclaration,
    owner: CoalescedPagesDeclaration | undefined,
  ): void {
    if (this.deferredOrdinaryImport(visit, declaration, owner)) return;
    if (
      declaration.type === 'VariableDeclarator' &&
      isNode(declaration['init']) &&
      this.isPrimitive(declaration['init'])
    )
      return;
    if (
      owner?.type === 'VariableDeclarator' &&
      isNode(owner['init']) &&
      !this.deferred(visit, owner) &&
      selector(owner['init'])
    )
      return;
    const selected = this.selectedUse(visit.node);
    const parent = this.parents.get(selected)?.parent;
    if (
      (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') &&
      parent['callee'] === selected
    )
      return;
    if (parent?.type === 'UnaryExpression' && parent['operator'] === 'typeof') return;
    refuse('captured value escapes its closed use');
  }

  private assertRedeclaration(visit: Visit): void {
    if (visit.node.type !== 'VariableDeclarator' && visit.node.type !== 'FunctionDeclaration')
      return;
    const name = visit.node['id'];
    if (!isNode(name)) return;
    const declared = this.parents.get(name);
    const found = declared === undefined ? undefined : binding(declared)?.node;
    if (
      found !== undefined &&
      found !== visit.node &&
      this.owned.has(found as CoalescedPagesDeclaration)
    )
      refuse('captured binding redeclaration');
  }

  private assertWholeOriginal(): void {
    for (const visit of this.visits) {
      this.assertRedeclaration(visit);
      const found = binding(visit);
      if (found?.node === undefined || !this.owned.has(found.node as CoalescedPagesDeclaration))
        continue;
      if (reference(visit)) this.assertUse(visit, found.node as CoalescedPagesDeclaration);
    }
  }

  prove(): readonly CoalescedPagesDeclaration[] {
    for (let next = this.pending.pop(); next !== undefined; next = this.pending.pop())
      this.scan(next);
    this.assertWholeOriginal();
    return Object.freeze([...this.owned].toSorted((a, b) => a.start - b.start));
  }
}

/** This lexical partition grants no source, graph, template or publication authority by itself. */
export function assertCoalescedPagesClosure(
  input: CoalescedPagesClosureInput,
): readonly CoalescedPagesDeclaration[] {
  return new ClosureScanner(input).prove();
}
