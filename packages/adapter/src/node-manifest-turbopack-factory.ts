import { createHash } from 'node:crypto';

import { jsLiteral } from './codegen.ts';
import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { assertGlobalContextRead } from './node-closure-globals.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  stringOf,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import { nodeManifestInspectionRefusal } from './node-manifest-inspection.ts';
import {
  TurbopackAsyncProjection,
  nodeManifestAsyncMetadata,
} from './node-manifest-turbopack-async.ts';
import {
  turbopackBoundRuntimeInput,
  TURBOPACK_BOUND_PREFIX as BOUND_PREFIX,
} from './node-manifest-turbopack-bound.ts';
import { TurbopackCacheInitializers } from './node-manifest-turbopack-cache.ts';
import { nodeManifestClearProjection } from './node-manifest-turbopack-clear.ts';
import { turbopackDependencyOperation } from './node-manifest-turbopack-dependency-operations.ts';
import { originalTurbopackImports } from './node-manifest-turbopack-imports.ts';
import {
  defaultExportTarget,
  exportBindings,
  externalThunk,
  turbopackModuleId,
  turbopackModuleSpecifier,
} from './node-manifest-turbopack-values.ts';
import { escapeContext, unboundTurbopackRequire } from './node-manifest-unbound-require.ts';
export { turbopackModuleId, turbopackModuleSpecifier } from './node-manifest-turbopack-values.ts';
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
  private readonly cache: TurbopackCacheInitializers;
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
  private normalizedGlobal = false;
  private readonly clearMembers = new Set<Node>();
  private async: TurbopackAsyncProjection | undefined;

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
    this.cache = new TurbopackCacheInitializers(this.body, this.parents);
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
    if (this.mode === 'dependencies' && this.cache.reads(id, call)) return;
    const specifier = turbopackModuleSpecifier(id);
    this.imports.set(call, { kind, specifier, targetId: id });
    this.edit(call, `require(${jsLiteral(specifier)})`);
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
    this.edit(call, `require(${jsLiteral(specifier)})`);
  }

  // eslint-disable-next-line sonarjs/function-return-type -- Next.js ModuleId preserves runtime-distinct number and string Map keys.
  private staticExportModule(value: unknown, visit: Visit): NodeManifestTurbopackModuleId {
    if (defaultExportTarget(value, visit)) return this.moduleId;
    const target = turbopackModuleId(value);
    if (target === undefined) {
      const shape = isNode(value) ? value.type : 'missing';
      return refuse(`dynamic or foreign export target (syntax ${shape})`);
    }
    return target;
  }

  private dynamicExports(value: unknown): void {
    if (!isNode(value) || value.type !== 'Literal' || typeof value['value'] !== 'boolean')
      refuse('dynamic export flag');
    if (value['value'] && this.mode === 'strict') refuse('dynamic protected exports');
  }

  private exportTarget(call: Node, visit: Visit, getters: boolean): NodeManifestTurbopackModuleId {
    const args = listOf(call, 'arguments');
    const maximum = getters ? MAX_GETTER_EXPORT_ARGUMENTS : MAX_VALUE_EXPORT_ARGUMENTS;
    if (
      args.length === 0 ||
      args.length > maximum ||
      args.some((arg) => !isNode(arg) || arg.type === 'SpreadElement')
    )
      refuse('export registration arguments');
    const target = this.staticExportModule(args[1], visit);
    if (getters && args.length === MAX_GETTER_EXPORT_ARGUMENTS) this.dynamicExports(args[2]);
    return target;
  }

  private selectedExport(call: Node, visit: Visit, getters: boolean): boolean {
    const target = this.exportTarget(call, visit, getters);
    if (
      !this.factory.ids.includes(target) &&
      !(this.mode === 'dependencies' && this.cache.ownsWrite(target, call))
    )
      return refuse(
        `dynamic or foreign export target (${typeof target}; ${this.factory.ids.length} declared IDs)`,
      );
    return target === this.moduleId;
  }

  private cacheInitializers(): void {
    if (this.mode !== 'dependencies') return;
    for (const visit of this.visits) {
      const member = visit.node;
      if (member.type !== 'MemberExpression' || !this.ownIdentifier(member['object'], visit))
        continue;
      const name = propertyName(member);
      if (name !== 's' && name !== 'n' && name !== 'v') continue;
      const call = this.parents.get(member)?.parent;
      if (call?.type !== 'CallExpression' || call['callee'] !== member) continue;
      const target = this.exportTarget(call, visit, name === 's');
      if (!this.factory.ids.includes(target)) this.cache.add(target, call);
    }
  }

  private getterExports(call: Node, visit: Visit): void {
    if (!this.selectedExport(call, visit, true)) return;
    if (this.mode === 'dependencies') {
      this.exports = { kind: 'opaque' };
      return;
    }
    this.topLevel(call);
    const bindings = exportBindings(listOf(call, 'arguments')[0]);
    const captures: string[] = [];
    for (const [index, binding] of bindings.entries()) {
      const local = `${GETTER_PREFIX}${index + 1}`;
      const capture = `const ${local}=${this.text(binding.value)}`;
      if (binding.kind === 'value') captures.push(capture);
      else this.append.push(`${capture};`);
      this.append.push(`export {${local} as ${jsLiteral(binding.name)}};`);
    }
    this.exports = { kind: 'getters', names: bindings.map((binding) => binding.name) };
    this.edit(call, captures.length === 0 ? 'void 0' : captures.join(';'));
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
    const bound = turbopackBoundRuntimeInput({
      member,
      name,
      visit,
      visits: this.visits,
      parents: this.parents,
      body: this.body,
      context: { name: this.context, scope: this.scope },
    });
    if (bound === undefined) return false;
    this.allowedContext.add(bound.receiver);
    this.boundRuntimeInputs.push({ kind: bound.kind, identifier: bound.identifier });
    this.edit(bound.call, bound.identifier);
    return true;
  }

  private specialOperation(member: Node, visit: Visit, name: string | undefined): boolean {
    const dependency = turbopackDependencyOperation(visit, {
      mode: this.mode,
      factory: this.node,
      body: this.body,
      parents: this.parents,
      context: { name: this.context, scope: this.scope },
      factoryIds: this.factory.ids,
    });
    if (dependency !== undefined) {
      for (const [node, imported] of dependency.imports) this.imports.set(node, imported);
      if (dependency.opaqueExports) this.exports = { kind: 'opaque' };
      return true;
    }
    const unbound = unboundTurbopackRequire(visit, {
      mode: this.mode,
      parents: this.parents,
      context: { name: this.context, scope: this.scope },
    });
    if (unbound !== undefined) {
      this.imports.set(unbound.call, unbound.dependency);
      return true;
    }
    if (this.async?.operation(member, visit) === true) return true;
    if (name === 'g' && this.mode === 'dependencies') {
      assertGlobalContextRead(member, visit, this.parents);
      this.edit(member, 'globalThis');
      this.normalizedGlobal = true;
      return true;
    }
    return (name === 'r' || name === 'l') && this.bound(member, visit, name);
  }

  private operation(visit: Visit): void {
    const member = visit.node;
    if (this.clearMembers.has(member)) return;
    if (member.type !== 'MemberExpression' || !this.ownIdentifier(member['object'], visit)) return;
    if (member['optional'] === true) refuse('optional context access');
    const name = propertyName(member);
    const owner = member['object'];
    this.allowedContext.add(owner);
    if (this.specialOperation(member, visit, name)) return;
    const call = this.parents.get(member)?.parent;
    if (call?.type !== 'CallExpression' || call['callee'] !== member || call['optional'] === true)
      escapeContext(name, call);
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

  private projectRuntimeScaffolds(): void {
    if (this.mode !== 'dependencies') return;
    const clear = nodeManifestClearProjection({
      body: this.body,
      visits: this.visits,
      parents: this.parents,
      context: { name: this.context, scope: this.scope },
    });
    if (clear !== undefined) {
      this.edit(clear.assignment, 'void 0');
      for (const member of clear.members) this.clearMembers.add(member);
      for (const node of clear.references) this.allowedContext.add(node);
    }
    this.async = new TurbopackAsyncProjection({
      body: this.body,
      visits: this.visits,
      context: { name: this.context, scope: this.scope },
      moduleId: this.moduleId,
      factoryIds: this.factory.ids,
    });
    for (const node of this.async.references()) this.allowedContext.add(node);
  }

  project(): NodeManifestTurbopackProjection {
    this.assertCommonJsBindings();
    this.cacheInitializers();
    this.projectRuntimeScaffolds();
    for (const visit of this.visits) this.operation(visit);
    const originalImports = originalTurbopackImports(this.visits, this.parents, this.imports);
    this.forwardNamespaces();
    for (const visit of this.visits) {
      if (
        reference(visit) &&
        this.ownIdentifier(visit.node, visit) &&
        !this.allowedContext.has(visit.node)
      ) {
        const parent = this.parents.get(visit.node)?.parent;
        refuse(`context alias or escape (${parent?.type ?? 'unknown'}:${visit.key ?? 'unknown'})`);
      }
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
    const failure = nodeManifestInspectionRefusal(code, {
      normalizedGlobal: this.normalizedGlobal,
      clearScaffold: this.clearMembers.size > 0,
    });
    if (failure !== undefined) refuse(failure);
    const sha256 = createHash('sha256').update(code).digest('hex');
    return {
      mode: this.mode,
      moduleId: this.moduleId,
      original: this.source,
      factory: this.factory,
      source: { code, sha256 },
      imports: [...this.imports.values(), ...(this.async?.imports() ?? []), ...originalImports],
      cacheInitializers: this.cache.snapshot(),
      ...nodeManifestAsyncMetadata(this.async),
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
