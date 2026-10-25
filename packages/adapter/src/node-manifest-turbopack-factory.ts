import { createHash } from 'node:crypto';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  stringOf,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import { originalTurbopackImports } from './node-manifest-turbopack-imports.ts';
import type {
  NodeManifestTurbopackExports,
  NodeManifestTurbopackFactory,
  NodeManifestTurbopackImport,
  NodeManifestTurbopackModuleId,
  NodeManifestTurbopackProjection,
  NodeManifestTurbopackSource,
} from './node-manifest-turbopack.ts';

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly code: string;
}
const GETTER_PREFIX = '__upwind_turbopack_getter_';
const BOUND_PREFIX = '__upwind_turbopack_bound_';
const BOUND_KINDS = { l: 'loadChunk', r: 'require' } as const;
const EXTERNAL_INTEROP_ARITY = 3;
const MAX_MODULE_ID_BYTES = 16_384;
const MAX_GETTER_EXPORT_ARGUMENTS = 3;
const MAX_VALUE_EXPORT_ARGUMENTS = 2;

interface ProjectionSelection {
  readonly mode: 'strict' | 'dependencies';
  readonly moduleId: NodeManifestTurbopackModuleId;
}

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest ${reason}; refusing native publication`,
  );
}

/** Fixed Next ModuleId is an untagged number/string; the runtime stores exact keys in a Map. */
// eslint-disable-next-line sonarjs/function-return-type -- Next.js ModuleId preserves runtime-distinct number and string Map keys.
export function turbopackModuleId(node: unknown): NodeManifestTurbopackModuleId | undefined {
  if (!isNode(node) || node.type !== 'Literal') return undefined;
  const value = node['value'];
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value) <= MAX_MODULE_ID_BYTES
    ? value
    : undefined;
}

/** Keep runtime-distinct numeric/string keys distinct in the inspection-only module namespace. */
export function turbopackModuleSpecifier(id: NodeManifestTurbopackModuleId): string {
  return typeof id === 'number' ? `turbopack:${id}` : `turbopack:string:${JSON.stringify(id)}`;
}

function staticSelector(node: unknown): node is Node {
  if (identifier(node)) return node.name !== 'arguments';
  return (
    isNode(node) &&
    node.type === 'MemberExpression' &&
    identifier(node['object']) &&
    node['object'].name !== 'arguments' &&
    propertyName(node) !== undefined
  );
}

function getterOf(value: unknown): Node {
  if (
    !isNode(value) ||
    value.type !== 'ArrowFunctionExpression' ||
    value['async'] === true ||
    value['generator'] === true ||
    listOf(value, 'params').length > 0
  )
    return refuse('export getter');
  let result = value['body'];
  if (isNode(result) && result.type === 'BlockStatement') {
    const statements = listOf(result, 'body');
    const only = statements[0];
    if (statements.length !== 1 || !isNode(only) || only.type !== 'ReturnStatement')
      return refuse('export getter body');
    result = only['argument'];
  }
  return staticSelector(result) ? result : refuse('export getter expression');
}

function externalThunk(args: readonly unknown[]): Node {
  const thunk = args[1];
  if (
    (args.length !== 2 && args.length !== EXTERNAL_INTEROP_ARITY) ||
    !isNode(thunk) ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(thunk.type) ||
    thunk['async'] === true ||
    thunk['generator'] === true ||
    listOf(thunk, 'params').length > 0 ||
    (thunk['id'] !== null && thunk['id'] !== undefined)
  )
    refuse('external require thunk');
  const flag = args[2];
  if (
    args.length === EXTERNAL_INTEROP_ARITY &&
    (!isNode(flag) || flag.type !== 'Literal' || typeof flag['value'] !== 'boolean')
  )
    refuse('external interop flag');
  const body = thunk['body'];
  if (!isNode(body)) return refuse('external thunk body');
  if (body.type !== 'BlockStatement') return body;
  const statements = listOf(body, 'body');
  const only = statements[0];
  if (
    statements.length !== 1 ||
    !isNode(only) ||
    only.type !== 'ReturnStatement' ||
    !isNode(only['argument'])
  )
    return refuse('external thunk body');
  return only['argument'];
}

function defaultExportTarget(value: unknown, visit: Visit): boolean {
  if (value === undefined) return true;
  if (!isNode(value)) return false;
  if (
    value.type === 'Literal' &&
    value['value'] === null &&
    !('regex' in value) &&
    !('bigint' in value)
  )
    return true;
  if (identifier(value) && value.name === 'undefined')
    return declaration('undefined', visit.scopes) === undefined;
  const argument = value['argument'];
  return (
    value.type === 'UnaryExpression' &&
    value['operator'] === 'void' &&
    isNode(argument) &&
    argument.type === 'Literal' &&
    argument['value'] === 0
  );
}

class FactoryProjection {
  private readonly source: NodeManifestTurbopackSource;
  private readonly factory: NodeManifestTurbopackFactory;
  private readonly node: Node;
  private readonly body: Node;
  private readonly context: string;
  private readonly scope: Scope;
  private readonly visits: readonly Visit[];
  private readonly parents: ReadonlyMap<Node, Visit>;
  private readonly mode: 'strict' | 'dependencies';
  private readonly moduleId: NodeManifestTurbopackModuleId;
  private readonly allowedContext = new Set<Node>();
  private readonly edits = new Map<Node, Edit>();
  private readonly imports = new Map<Node, NodeManifestTurbopackImport>();
  private readonly append: string[] = [];
  private readonly boundRuntimeInputs: {
    readonly kind: 'require' | 'loadChunk';
    readonly identifier: string;
  }[] = [];
  private exports: NodeManifestTurbopackExports = { kind: 'commonjs' };
  private registered = false;

  constructor(
    source: NodeManifestTurbopackSource,
    factory: NodeManifestTurbopackFactory,
    program: Node,
    selection: ProjectionSelection,
  ) {
    this.source = source;
    this.mode = selection.mode;
    this.moduleId = selection.moduleId;
    this.factory = factory;
    const all = visitTree(program);
    const found = all.find(({ node }) => {
      return (
        node.start === factory.start &&
        node.end === factory.end &&
        ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)
      );
    });
    const body = found?.node['body'];
    const scope = found?.scopes.at(-1);
    const param = found === undefined ? undefined : listOf(found.node, 'params')[0];
    if (found === undefined || scope === undefined || !isNode(body) || !identifier(param))
      refuse('factory identity');
    this.node = found.node;
    this.body = body;
    this.context = param.name;
    this.scope = scope;
    this.visits = all.filter(({ node }) => node.start >= body.start && node.end <= body.end);
    this.parents = new Map(all.map((visit) => [visit.node, visit]));
    if (scope.bindings.has(param.name)) refuse('mutated context parameter');
    if (
      this.visits.some(({ node }) => {
        return (
          identifier(node) &&
          (node.name.startsWith(GETTER_PREFIX) || node.name.startsWith(BOUND_PREFIX))
        );
      })
    )
      refuse('inspection identifier collision');
  }

  private ownIdentifier(
    node: unknown,
    visit: Visit,
    name = this.context,
  ): node is Node & { readonly name: string } {
    if (!identifier(node) || node.name !== name) return false;
    for (const scope of visit.scopes.toReversed()) {
      if (scope.declared.has(name)) return scope === this.scope && !scope.bindings.has(name);
    }
    return false;
  }

  private text(node: Node): string {
    return this.source.code.slice(node.start, node.end);
  }

  private edit(node: Node, code: string): void {
    this.edits.set(node, { start: node.start, end: node.end, code });
  }

  private topLevel(call: Node): void {
    const statement = this.parents.get(call)?.parent;
    if (
      statement?.type !== 'ExpressionStatement' ||
      this.parents.get(statement)?.parent !== this.body
    )
      refuse('conditional export registration');
    if (this.registered) refuse('multiple export registrations');
    this.registered = true;
  }

  private imported(call: Node, visit: Visit, kind: 'import' | 'require'): void {
    const args = listOf(call, 'arguments');
    if (args.length !== 1) refuse('module import arity');
    const id = turbopackModuleId(args[0]) ?? refuse('dynamic or invalid module id');
    if (declaration('require', visit.scopes) !== undefined) refuse('shadowed inspection require');
    const specifier = turbopackModuleSpecifier(id);
    this.imports.set(call, { kind, specifier, targetId: id });
    this.edit(call, `require(${JSON.stringify(specifier)})`);
  }

  private external(call: Node, visit: Visit): void {
    const args = listOf(call, 'arguments');
    const specifier = stringOf(args[0]);
    const returned = externalThunk(args);
    if (
      specifier === undefined ||
      returned.type !== 'CallExpression' ||
      !identifier(returned['callee']) ||
      returned['callee'].name !== 'require' ||
      listOf(returned, 'arguments').length !== 1 ||
      stringOf(listOf(returned, 'arguments')[0]) !== specifier ||
      declaration('require', visit.scopes) !== undefined
    )
      refuse('external require identity');
    this.imports.set(call, { kind: 'external', specifier });
    this.edit(call, `require(${JSON.stringify(specifier)})`);
  }

  private exportModule(value: unknown, visit: Visit): NodeManifestTurbopackModuleId {
    if (defaultExportTarget(value, visit)) return this.moduleId;
    const target = turbopackModuleId(value);
    if (target === undefined || !this.factory.ids.includes(target))
      return refuse('dynamic or foreign export target');
    return target;
  }

  private dynamicExports(value: unknown): void {
    if (!isNode(value) || value.type !== 'Literal' || typeof value['value'] !== 'boolean')
      refuse('dynamic export flag');
    if (value['value'] === true && this.mode === 'strict') refuse('dynamic protected exports');
  }

  private selectedExport(call: Node, visit: Visit, getters: boolean): boolean {
    const args = listOf(call, 'arguments');
    const maximum = getters ? MAX_GETTER_EXPORT_ARGUMENTS : MAX_VALUE_EXPORT_ARGUMENTS;
    if (
      args.length === 0 ||
      args.length > maximum ||
      args.some((arg) => !isNode(arg) || arg.type === 'SpreadElement')
    )
      refuse('export registration arguments');
    const target = this.exportModule(args[1], visit);
    if (getters && args.length === MAX_GETTER_EXPORT_ARGUMENTS) this.dynamicExports(args[2]);
    return target === this.moduleId;
  }

  private getterExports(call: Node, visit: Visit): void {
    if (!this.selectedExport(call, visit, true)) return;
    if (this.mode === 'dependencies') {
      this.exports = { kind: 'opaque' };
      return;
    }
    this.topLevel(call);
    const args = listOf(call, 'arguments');
    const table = args[0];
    if (!isNode(table) || table.type !== 'ArrayExpression') refuse('export registration arguments');
    const entries = listOf(table, 'elements');
    const names = new Set<string>();
    for (let index = 0; index < entries.length; index += 2) {
      const name = stringOf(entries[index]);
      if (name === undefined || names.has(name)) refuse('export name');
      names.add(name);
      const value = getterOf(entries[index + 1]);
      const local = `${GETTER_PREFIX}${names.size}`;
      this.append.push(
        `const ${local}=${this.text(value)};export {${local} as ${JSON.stringify(name)}};`,
      );
    }
    if (names.size === 0) refuse('empty export registration');
    this.exports = { kind: 'getters', names: [...names] };
    this.edit(call, 'void 0');
  }

  private namespaceIdentity(call: Node, visit: Visit): NodeManifestTurbopackImport | undefined {
    const args = listOf(call, 'arguments');
    const value = args[0];
    if (!identifier(value)) return undefined;
    const binding = declaration(value.name, visit.scopes)?.node;
    const init = binding?.type === 'VariableDeclarator' ? binding['init'] : undefined;
    const imported = isNode(init) ? this.imports.get(init) : undefined;
    if (imported === undefined) return undefined;
    const statements = listOf(this.body, 'body').filter((statement) => {
      return (
        !isNode(statement) ||
        statement.type !== 'ExpressionStatement' ||
        stringOf(statement['expression']) !== 'use strict'
      );
    });
    const first = statements[0];
    const last = statements[1];
    if (
      statements.length !== 2 ||
      !isNode(first) ||
      first.type !== 'VariableDeclaration' ||
      listOf(first, 'declarations').length !== 1 ||
      listOf(first, 'declarations')[0] !== binding ||
      !isNode(last) ||
      last.type !== 'ExpressionStatement' ||
      last['expression'] !== call
    )
      return undefined;
    return imported;
  }

  private namespaceExports(call: Node, visit: Visit): void {
    if (!this.selectedExport(call, visit, false)) return;
    const imported = this.namespaceIdentity(call, visit);
    if (imported === undefined) {
      if (this.mode === 'strict') refuse('namespace forwarding identity');
      this.exports = { kind: 'opaque' };
      return;
    }
    this.topLevel(call);
    this.exports = { kind: 'namespace', specifier: imported.specifier };
    const value = listOf(call, 'arguments')[0];
    if (!isNode(value)) refuse('namespace forwarding value');
    this.edit(call, `module.exports=${this.text(value)}`);
  }

  private bound(member: Node, visit: Visit, name: 'r' | 'l'): boolean {
    const bind = this.parents.get(member)?.parent;
    const call = bind === undefined ? undefined : this.parents.get(bind)?.parent;
    const owner = call === undefined ? undefined : this.parents.get(call)?.parent;
    if (
      bind?.type !== 'MemberExpression' ||
      bind['object'] !== member ||
      propertyName(bind) !== 'bind' ||
      call?.type !== 'CallExpression' ||
      call['callee'] !== bind ||
      owner?.type !== 'Property' ||
      owner['value'] !== call ||
      propertyName(owner) !== BOUND_KINDS[name]
    )
      return false;
    const args = listOf(call, 'arguments');
    const arg = args[0];
    if (args.length !== 1 || !this.ownIdentifier(arg, visit)) refuse('bound context identity');
    this.allowedContext.add(arg);
    const binding = `${BOUND_PREFIX}${name}`;
    this.boundRuntimeInputs.push({ kind: BOUND_KINDS[name], identifier: binding });
    this.edit(call, binding);
    return true;
  }

  private operation(visit: Visit): void {
    const member = visit.node;
    if (member.type !== 'MemberExpression' || !this.ownIdentifier(member['object'], visit)) return;
    if (member['optional'] === true) refuse('optional context access');
    const name = propertyName(member);
    const owner = member['object'];
    this.allowedContext.add(owner);
    if ((name === 'r' || name === 'l') && this.bound(member, visit, name)) return;
    const call = this.parents.get(member)?.parent;
    if (call?.type !== 'CallExpression' || call['callee'] !== member || call['optional'] === true)
      refuse('context method escape');
    switch (name) {
      case 'i':
      case 'r': {
        this.imported(call, visit, name === 'i' ? 'import' : 'require');
        break;
      }
      case 'x': {
        this.external(call, visit);
        break;
      }
      case 's': {
        this.getterExports(call, visit);
        break;
      }
      case undefined: {
        refuse('unreviewed context method');
        break;
      }
      default: {
        if (name !== 'n' && name !== 'v') refuse('unreviewed context method');
      }
    }
  }

  private renameParameter(param: Node & { readonly name: string }, canonical: string): void {
    if (this.scope.bindings.has(param.name)) refuse('mutated CommonJS parameter');
    for (const visit of this.visits) {
      if (!reference(visit) || !this.ownIdentifier(visit.node, visit, param.name)) continue;
      if (param.name !== canonical && declaration(canonical, visit.scopes) !== undefined)
        refuse('CommonJS projection collision');
      this.edit(visit.node, canonical);
    }
  }

  private renameParameters(): void {
    const params = listOf(this.node, 'params');
    for (const [index, param] of params.entries()) {
      if (index === 0 || !identifier(param)) continue;
      const canonical = index === 1 ? 'module' : 'exports';
      this.renameParameter(param, canonical);
    }
  }

  private assertCommonJsBindings(): void {
    for (const visit of this.visits) {
      const node = visit.node;
      if (!identifier(node) || !reference(visit) || !['exports', 'module'].includes(node.name))
        continue;
      if (declaration(node.name, visit.scopes) === undefined)
        refuse('outer CommonJS export reference');
    }
  }

  private forwardNamespaces(): void {
    for (const visit of this.visits) {
      const member = visit.node;
      if (member.type !== 'MemberExpression' || !this.ownIdentifier(member['object'], visit))
        continue;
      const name = propertyName(member);
      if (name !== 'n' && name !== 'v') continue;
      const call = this.parents.get(member)?.parent;
      if (call?.type !== 'CallExpression') refuse('namespace export call');
      this.namespaceExports(call, visit);
    }
  }

  project(): NodeManifestTurbopackProjection {
    this.assertCommonJsBindings();
    for (const visit of this.visits) this.operation(visit);
    const originalImports = originalTurbopackImports(this.visits, this.parents, this.imports);
    this.forwardNamespaces();
    for (const visit of this.visits) {
      if (
        reference(visit) &&
        this.ownIdentifier(visit.node, visit) &&
        !this.allowedContext.has(visit.node)
      )
        refuse('context alias or escape');
    }
    this.renameParameters();
    const edits = [...this.edits.values()].toSorted((a, b) => b.start - a.start);
    let end = this.body.end - 1;
    let code = this.source.code.slice(this.body.start + 1, end);
    for (const edit of edits) {
      if (edit.end > end || edit.start <= this.body.start)
        refuse('overlapping inspection operations');
      const at = edit.start - this.body.start - 1;
      code = code.slice(0, at) + edit.code + code.slice(edit.end - this.body.start - 1);
      end = edit.start;
    }
    code += `\n${this.append.join('\n')}`;
    const sha256 = createHash('sha256').update(code).digest('hex');
    return {
      mode: this.mode,
      moduleId: this.moduleId,
      original: this.source,
      factory: this.factory,
      source: { code, sha256 },
      imports: [...this.imports.values(), ...originalImports],
      exports: this.exports,
      boundRuntimeInputs: this.boundRuntimeInputs,
      requiresReviewedRuntime: true,
    };
  }
}

export function projectTurbopackFactory(
  source: NodeManifestTurbopackSource,
  factory: NodeManifestTurbopackFactory,
  program: Node,
  selection: ProjectionSelection,
): NodeManifestTurbopackProjection {
  return new FactoryProjection(source, factory, program, selection).project();
}
