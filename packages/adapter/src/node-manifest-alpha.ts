import { AuditError } from './dependencies.ts';
import { isNode, type Node, type Scope } from './lexical-scope.ts';
import { identifier, visitTree, type Visit } from './node-manifest-consumer-ast.ts';

export interface NodeManifestAlphaInput {
  readonly original: Node;
  readonly body: readonly unknown[];
  /** Only a static import expression may be substituted; no runtime code is emitted. */
  readonly importToken?: (node: Node) => string | undefined;
  /** An explicitly scoped template selector DATA view; original receiver shapes remain intact. */
  readonly memberName?: (node: Node) => string | undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js template binding ${reason}; refusing native publication`);
}
function origins(visits: readonly Visit[]): ReadonlyMap<Scope, Node> {
  const parents = new Map(visits.map((visit) => [visit.node, visit]));
  const result = new Map<Scope, Node>();
  for (const visit of visits) {
    const previous = visit.parent === undefined ? [] : (parents.get(visit.parent)?.scopes ?? []);
    if (visit.scopes.length <= previous.length) continue;
    const scope = visit.scopes.at(-1);
    if (scope !== undefined) result.set(scope, visit.node);
  }
  return result;
}
function staticName(visit: Visit): boolean {
  const parent = visit.parent;
  if (parent === undefined) return false;
  return (
    (visit.key === 'property' &&
      parent.type === 'MemberExpression' &&
      parent['computed'] !== true) ||
    (visit.key === 'key' &&
      ['MethodDefinition', 'Property', 'PropertyDefinition'].includes(parent.type) &&
      parent['computed'] !== true) ||
    (parent.type === 'ExportSpecifier' && visit.key === 'exported') ||
    ['BreakStatement', 'ContinueStatement', 'LabeledStatement'].includes(parent.type)
  );
}
/** An inert alpha view. Every lexical binding retains its original scope and declaration order. */
export class NodeManifestAlpha {
  private readonly input: NodeManifestAlphaInput;
  private readonly visits: ReadonlyMap<Node, Visit>;
  private readonly origin: ReadonlyMap<Scope, Node>;
  private readonly bindings = new Map<Node, ReadonlyMap<string, string>>();
  private readonly clean: Node;

  constructor(input: NodeManifestAlphaInput) {
    this.input = input;
    const original = visitTree(input.original);
    this.visits = new Map(original.map((visit) => [visit.node, visit]));
    this.origin = origins(original);
    this.clean = { ...input.original, body: input.body };
    const cleanVisits = visitTree(this.clean);
    let index = 0;
    for (const [scope, node] of origins(cleanVisits)) {
      const binding = new Map<string, string>();
      let declared = 0;
      for (const name of scope.declared) {
        binding.set(name, `binding:${index}:${declared}`);
        declared += 1;
      }
      this.bindings.set(node === this.clean ? input.original : node, binding);
      index += 1;
    }
  }

  private binding(visit: Visit): string {
    if (!identifier(visit.node)) return refuse('identifier');
    const name = visit.node.name;
    if (staticName(visit)) return name;
    for (const scope of visit.scopes.toReversed()) {
      if (!scope.declared.has(name)) continue;
      const origin = this.origin.get(scope);
      const bound = origin === undefined ? undefined : this.bindings.get(origin)?.get(name);
      if (bound === undefined) return refuse('selector leaves its lexical scope');
      return bound;
    }
    return `global:${name}`;
  }

  private identifierShape(value: Node, parent?: Node, key?: string): unknown {
    const visit = this.visits.get(value);
    if (visit === undefined || !identifier(value)) return refuse('selector outside parsed source');
    return {
      type: 'Identifier',
      name: this.binding({
        ...visit,
        ...(parent !== undefined && { parent }),
        ...(key !== undefined && { key }),
      }),
    };
  }

  private recordShape(value: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const owner = isNode(value) ? value : undefined;
    for (const [field, child] of Object.entries(value)) {
      if (['end', 'raw', 'start'].includes(field)) continue;
      // Shorthand keys remain literal property names; only values identify lexical bindings.
      if (field === 'shorthand' && owner?.type === 'Property') result[field] = false;
      else result[field] = this.shape(child, owner, field);
    }
    return result;
  }

  shape(value: unknown, parent?: Node, key?: string): unknown {
    if (Array.isArray(value)) return value.map((item) => this.shape(item, parent, key));
    if (!record(value)) return value;
    if (isNode(value)) {
      const imported = this.input.importToken?.(value);
      if (imported !== undefined) return { type: 'StaticTemplateImport', value: imported };
      if (identifier(value)) return this.identifierShape(value, parent, key);
      const member = this.input.memberName?.(value);
      if (member !== undefined && value.type === 'MemberExpression')
        return {
          ...this.recordShape(value),
          computed: false,
          property: { type: 'Identifier', name: member },
        };
    }
    return this.recordShape(value);
  }

  body(): unknown {
    return this.shape(this.input.body);
  }
}
