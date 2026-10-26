import type { Node as AstNode } from '@oxc-project/types';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { nativeBindings } from './native-ast.ts';
import {
  declaration,
  identifier,
  reference,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import {
  projectedTemplateExports,
  swcTemplateExports,
  type ManifestTemplateExports,
} from './node-manifest-template-exports.ts';
import { withoutStrict } from './node-manifest-turbopack-template-strict.ts';

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression']);
const MAX_VISITS = 100_000;
const MAX_DECLARATIONS = 1024;
interface Input {
  readonly original: Node;
  readonly body: readonly unknown[];
}
function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Pages template declaration ${reason}; refusing native publication`,
  );
}
function scopeOf(visit: Visit, name: string): Scope | undefined {
  return visit.scopes.findLast((scope) => scope.declared.has(name));
}
function within(node: Node, owner: Node): boolean {
  return node.start >= owner.start && node.end <= owner.end;
}
function sameBody(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}
function extracted(input: Input): ManifestTemplateExports {
  const body = listOf(input.original, 'body');
  if (sameBody(input.body, body) || sameBody(input.body, withoutStrict(body)))
    return { body, fields: new Map() };
  if (body.some((node) => isNode(node) && node.type === 'ExportNamedDeclaration'))
    return projectedTemplateExports(input.original);
  if (body.some((node) => isNode(node) && node.type === 'FunctionDeclaration'))
    return swcTemplateExports(input.original);
  return refuse('body outside fresh export extraction');
}
function declaredName(visit: Visit): string | undefined {
  const node = visit.node;
  if (node.type === 'VariableDeclarator' && identifier(node['id'])) return node['id'].name;
  if (['ClassDeclaration', 'FunctionDeclaration'].includes(node.type) && identifier(node['id']))
    return node['id'].name;
  return undefined;
}
function candidates(body: readonly unknown[]): readonly Node[] {
  const result: Node[] = [];
  for (const statement of body) {
    if (!isNode(statement) || statement.type !== 'VariableDeclaration') continue;
    if (!['const', 'let', 'var'].includes(String(statement['kind']))) refuse('declaration kind');
    for (const value of listOf(statement, 'declarations')) {
      if (!isNode(value) || !identifier(value['id']) || !isNode(value['init']))
        refuse('simple initialized binding');
      result.push(value);
    }
  }
  if (result.length > MAX_DECLARATIONS) refuse('binding bounds');
  return result;
}

class DeclarationView {
  private readonly input: Input;
  private readonly visits: readonly Visit[];
  private readonly parents: ReadonlyMap<Node, Visit>;
  private readonly exported: ManifestTemplateExports;
  private readonly counts = new Map<Scope | undefined, Map<string, number>>();
  private readonly bindings: ReturnType<typeof nativeBindings>;
  constructor(input: Input) {
    this.input = input;
    if (input.original.type !== 'Program') refuse('original program');
    this.visits = visitTree(input.original);
    if (this.visits.length > MAX_VISITS) refuse('AST bounds');
    this.parents = new Map(this.visits.map((visit) => [visit.node, visit]));
    this.exported = extracted(input);
    if (
      !sameBody(input.body, withoutStrict(this.exported.body)) &&
      !sameBody(input.body, this.exported.body)
    )
      refuse('body outside fresh export extraction');
    this.bindings = nativeBindings(input.original as unknown as AstNode);
    this.inventory();
  }
  private inventory(): void {
    for (const visit of this.visits) {
      const node = visit.node;
      if (
        node.type === 'WithStatement' ||
        (node.type === 'CallExpression' &&
          identifier(node['callee']) &&
          node['callee'].name === 'eval')
      )
        refuse('dynamic lexical observation');
      const name = declaredName(visit);
      if (name === undefined) continue;
      const scope = scopeOf(visit, name);
      const counts = this.counts.get(scope) ?? new Map<string, number>();
      counts.set(name, (counts.get(name) ?? 0) + 1);
      this.counts.set(scope, counts);
    }
  }
  private deferred(visit: Visit): boolean {
    for (let node = visit.parent; node !== undefined; node = this.parents.get(node)?.parent)
      if (FUNCTIONS.has(node.type)) return true;
    return false;
  }
  private nonExecutingSelector(visit: Visit): boolean {
    for (const value of this.exported.fields.values())
      if (within(visit.node, value)) return this.deferred(visit);
    return false;
  }
  private assertRead(candidate: Node, name: string, visit: Visit): void {
    if (
      !identifier(visit.node) ||
      visit.node.name !== name ||
      !reference(visit) ||
      declaration(name, visit.scopes)?.node !== candidate
    )
      return;
    if (this.nonExecutingSelector(visit)) return;
    if (visit.node.start < candidate.end) refuse('read before initializer completion');
    if (this.deferred(visit)) refuse('unproved nested capture');
  }
  private assertBinding(candidate: Node): void {
    const local = candidate['id'];
    const own = this.parents.get(candidate);
    if (own === undefined || !identifier(local)) refuse('original binding');
    if (
      own.parent?.type !== 'VariableDeclaration' ||
      this.parents.get(own.parent)?.parent !== this.input.original ||
      declaration(local.name, own.scopes)?.node !== candidate ||
      this.counts.get(scopeOf(own, local.name))?.get(local.name) !== 1
    )
      refuse('redeclaration or non-top-level binding');
    if (!this.bindings.unmodified(candidate as unknown as AstNode, local.name, false))
      refuse('binding write');
    for (const visit of this.visits) this.assertRead(candidate, local.name, visit);
  }
  body(): readonly unknown[] {
    for (const candidate of candidates(this.input.body)) this.assertBinding(candidate);
    return this.input.body.flatMap((statement) => {
      if (!isNode(statement) || statement.type !== 'VariableDeclaration') return [statement];
      return listOf(statement, 'declarations').map((variable) => {
        const declarations = [variable];
        return { ...statement, kind: 'const', declarations };
      });
    });
  }
}

/** Template-only DATA. Original lexical declarations and initializer nodes are never replaced. */
export function nodeManifestTemplateDeclarationView(input: Input): readonly unknown[] {
  return new DeclarationView(input).body();
}
