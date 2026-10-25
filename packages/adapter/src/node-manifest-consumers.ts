import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import {
  assertArgument,
  declaration,
  getterExport,
  getterValue,
  identifier,
  isProgramCall,
  MANIFEST_CONSUMER_FIELDS as FIELDS,
  propertyName,
  reference,
  refuse,
  stringOf,
  swcDeadAnnotation,
  swcHeader,
  swcHelper,
  unwrappedCallee,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';

const PRODUCER_SUFFIX = '/dist/build/templates/app-page-runtime.js';
// Published next@16.4.3, registry-integrity-verified source. Producer TS:
// 29bbeab09981148ade186e8599ecdede15abc281 / app-page-runtime.ts.
const PRODUCER_SHA = '0a6a5c726f95e2df2600b2fd6d71e37fd72f936f8f4dc5b94fa38d40fcd62a6b';
const PRODUCER_EXPORT = 'createAppPageEntrypoint';
type Field = (typeof FIELDS)[number];

/** Only supply imports resolved and source-hash-checked by the original graph collector. */
export interface NodeManifestConsumerImport {
  readonly specifier: string;
  readonly file: string;
  readonly sha256: string;
  readonly kind: 'app-page-factory' | 'route-class' | 'evaluator';
  readonly exportName: string;
}

export interface NodeManifestConsumerInput {
  readonly source: { readonly code: string; readonly sha256: string };
  readonly imports: readonly NodeManifestConsumerImport[];
  /** Derived from the sealed route inventory, never from the consumer's own declarations. */
  readonly route: { readonly page: string; readonly pathname: string };
  /** A projected runtime may require these exact, independently traced callback bindings. */
  readonly runtimeInputs?: { readonly require: string; readonly loadChunk: string };
}

export interface NodeManifestConsumerProof {
  readonly kind: 'app-page-template';
  readonly page: string;
  readonly pathname: string;
  readonly exports: readonly Field[];
  /** The importer-chain proof must reach SDK app-entry normalization before using these exports. */
  readonly requiresRuntimeNormalization: true;
}

type Origin =
  | { readonly kind: 'namespace'; readonly imported: NodeManifestConsumerImport }
  | { readonly kind: 'factory' }
  | { readonly kind: 'entrypoint' }
  | { readonly kind: 'selector'; readonly field: Field };

class Consumer {
  private readonly input: NodeManifestConsumerInput;
  private readonly visits: readonly Visit[];
  private readonly byNode: ReadonlyMap<Node, Visit>;
  private readonly imports: ReadonlyMap<string, NodeManifestConsumerImport>;
  private readonly importOrigins = new Map<Node, Origin>();
  private readonly exportHelpers = new Set<Node>();
  private readonly calls = new Set<Node>();
  private readonly exported = new Set<Field>();

  constructor(input: NodeManifestConsumerInput, program: Node) {
    this.input = input;
    this.visits = visitTree(program);
    this.byNode = new Map(this.visits.map((visit) => [visit.node, visit]));
    this.imports = new Map(input.imports.map((entry) => [entry.specifier, entry]));
    if (this.imports.size !== input.imports.length) refuse('ambiguous import identity');
  }

  private reviewed(entry: NodeManifestConsumerImport): void {
    if (
      entry.kind !== 'app-page-factory' ||
      entry.exportName !== PRODUCER_EXPORT ||
      entry.sha256 !== PRODUCER_SHA ||
      !entry.file.replaceAll('\\', '/').endsWith(PRODUCER_SUFFIX)
    )
      refuse('unknown producer or direct class/evaluator use');
  }

  private required(node: Node, scopes: readonly Scope[]): NodeManifestConsumerImport | undefined {
    if (
      node.type !== 'CallExpression' ||
      !identifier(node['callee']) ||
      node['callee'].name !== 'require' ||
      declaration('require', scopes) !== undefined
    )
      return undefined;
    const args = listOf(node, 'arguments');
    const specifier = stringOf(args[0]);
    const imported = specifier === undefined ? undefined : this.imports.get(specifier);
    if (imported === undefined) return undefined;
    this.reviewed(imported);
    if (args.length !== 1) refuse('require arity');
    return imported;
  }

  private importBinding(binding: unknown, imported: NodeManifestConsumerImport): void {
    if (!isNode(binding)) refuse('import shape');
    if (binding.type === 'ImportNamespaceSpecifier')
      this.importOrigins.set(binding, { kind: 'namespace', imported });
    else if (
      binding.type === 'ImportSpecifier' &&
      propertyName({ ...binding, key: binding['imported'] }) === PRODUCER_EXPORT
    )
      this.importOrigins.set(binding, { kind: 'factory' });
    else refuse('unreviewed producer export');
  }

  private collectImport(visit: Visit): void {
    const node = visit.node;
    if (node.type === 'FunctionDeclaration' && (swcHelper(node) || swcHelper(node, true)))
      this.exportHelpers.add(node);
    const specifier = stringOf(node['source']);
    const imported = specifier === undefined ? undefined : this.imports.get(specifier);
    if (imported !== undefined && node.type === 'ImportDeclaration') {
      this.reviewed(imported);
      for (const binding of listOf(node, 'specifiers')) this.importBinding(binding, imported);
    } else if (
      imported !== undefined &&
      ['ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type)
    )
      refuse('producer re-export or dynamic import');
    else if (
      this.required(node, visit.scopes) !== undefined &&
      (visit.parent?.type !== 'VariableDeclarator' ||
        visit.key !== 'init' ||
        !identifier(visit.parent['id']))
    )
      refuse('namespace escape');
  }

  private identifierOrigin(
    value: Node & { readonly name: string },
    scopes: readonly Scope[],
    seen: Set<Node>,
  ): Origin | undefined {
    const binding = declaration(value.name, scopes)?.node;
    if (binding === undefined) return undefined;
    const imported = this.importOrigins.get(binding);
    if (imported !== undefined) return imported;
    return binding.type === 'VariableDeclarator'
      ? this.origin(binding['init'], this.byNode.get(binding)?.scopes ?? scopes, seen)
      : undefined;
  }

  private assertFactoryArgument(call: Node): void {
    assertArgument(call, this.input.route);
    const expected = this.input.runtimeInputs;
    if (expected === undefined) return;
    const argument = listOf(call, 'arguments')[0];
    if (!isNode(argument)) refuse('runtime callback argument');
    for (const name of ['require', 'loadChunk'] as const) {
      const property = listOf(argument, 'properties').find(
        (value) => isNode(value) && propertyName(value) === name,
      );
      const value = isNode(property) ? property['value'] : undefined;
      if (!identifier(value) || value.name !== expected[name]) refuse('runtime callback binding');
    }
  }

  private callOrigin(value: Node, scopes: readonly Scope[], seen: Set<Node>): Origin | undefined {
    const imported = this.required(value, scopes);
    if (imported !== undefined) return { kind: 'namespace', imported };
    if (this.origin(unwrappedCallee(value), scopes, seen)?.kind !== 'factory') return undefined;
    this.assertFactoryArgument(value);
    this.calls.add(value);
    const parent = this.byNode.get(value)?.parent;
    if (parent?.type !== 'VariableDeclarator' || !identifier(parent['id']))
      refuse('factory result escape');
    return { kind: 'entrypoint' };
  }

  private memberOrigin(value: Node, scopes: readonly Scope[], seen: Set<Node>): Origin | undefined {
    const object = this.origin(value['object'], scopes, seen);
    const name = propertyName(value);
    if (object?.kind === 'namespace') {
      if (name !== PRODUCER_EXPORT) refuse('namespace property escape');
      return { kind: 'factory' };
    }
    if (object?.kind === 'entrypoint') {
      const field = FIELDS.find((candidate) => candidate === name);
      if (field === undefined) refuse('entrypoint property escape');
      return { kind: 'selector', field };
    }
    return undefined;
  }

  private origin(
    value: unknown,
    scopes: readonly Scope[],
    seen = new Set<Node>(),
  ): Origin | undefined {
    if (!isNode(value) || seen.has(value)) return undefined;
    const next = new Set(seen).add(value);
    if (identifier(value)) return this.identifierOrigin(value, scopes, next);
    if (value.type === 'CallExpression') return this.callOrigin(value, scopes, next);
    return value.type === 'MemberExpression' ? this.memberOrigin(value, scopes, next) : undefined;
  }

  private addExport(field: Field): void {
    if (this.exported.has(field)) refuse('duplicate producer export');
    this.exported.add(field);
  }

  private declarationExport(visit: Visit, field: Field): boolean {
    const parent = visit.parent;
    if (parent?.type !== 'VariableDeclarator' || visit.key !== 'init' || !identifier(parent['id']))
      return false;
    const declarationVisit = this.byNode.get(parent)?.parent;
    if (
      declarationVisit !== undefined &&
      this.byNode.get(declarationVisit)?.parent?.type === 'ExportNamedDeclaration'
    ) {
      if (parent['id'].name !== field) refuse('mismatched named export');
      this.addExport(field);
    }
    return true;
  }

  private assignmentExport(visit: Visit, field: Field): boolean {
    const parent = visit.parent;
    if (
      parent?.type !== 'AssignmentExpression' ||
      visit.key !== 'right' ||
      parent['operator'] !== '='
    )
      return false;
    const left = parent['left'];
    if (
      !isNode(left) ||
      left.type !== 'MemberExpression' ||
      !identifier(left['object']) ||
      left['object'].name !== 'exports' ||
      declaration('exports', visit.scopes) !== undefined ||
      propertyName(left) !== field
    )
      return false;
    this.addExport(field);
    return true;
  }

  private exportDestination(value: Node, field: Field): void {
    const visit = this.byNode.get(value);
    if (visit === undefined) refuse('missing value location');
    if (this.declarationExport(visit, field) || this.assignmentExport(visit, field)) return;
    if (
      visit.parent?.type === 'ExportSpecifier' &&
      visit.key === 'local' &&
      propertyName({ ...visit.parent, key: visit.parent['exported'] }) === field
    ) {
      this.addExport(field);
      return;
    }
    const getter = getterExport(value, this.byNode);
    if (
      getter !== undefined &&
      getter.field === field &&
      this.getterMap(getter.call, visit.scopes)
    ) {
      this.addExport(field);
      return;
    }
    refuse('class/instance/handler escape');
  }

  private getterMap(call: Node, scopes: readonly Scope[]): boolean {
    const callee = call['callee'];
    if (
      !identifier(callee) ||
      !swcHelper(declaration(callee.name, scopes)?.node) ||
      !isProgramCall(call, this.byNode)
    )
      return false;
    const args = listOf(call, 'arguments');
    const target = args[0];
    const map = args[1];
    if (
      args.length !== 2 ||
      !identifier(target) ||
      target.name !== 'exports' ||
      declaration('exports', scopes) !== undefined ||
      !isNode(map) ||
      map.type !== 'ObjectExpression'
    )
      return false;
    const properties = listOf(map, 'properties');
    const fields = new Set<string>();
    for (const property of properties) {
      if (!isNode(property)) return false;
      const field = propertyName(property);
      const origin = this.origin(getterValue(property), scopes);
      if (
        field === undefined ||
        fields.has(field) ||
        origin?.kind !== 'selector' ||
        origin.field !== field
      )
        return false;
      fields.add(field);
    }
    return fields.size === FIELDS.length;
  }

  private starExport(call: Node, scopes: readonly Scope[]): boolean {
    const callee = call['callee'];
    if (
      !identifier(callee) ||
      !swcHelper(declaration(callee.name, scopes)?.node, true) ||
      !isProgramCall(call, this.byNode)
    )
      return false;
    const args = listOf(call, 'arguments');
    const source = args[0];
    const target = args[1];
    if (
      args.length !== 2 ||
      !isNode(source) ||
      source.type !== 'CallExpression' ||
      !identifier(target) ||
      target.name !== 'exports' ||
      declaration('exports', scopes) !== undefined ||
      declaration('require', scopes) !== undefined
    )
      return false;
    const name = source['callee'];
    const required = listOf(source, 'arguments');
    const specifier = stringOf(required[0]);
    return (
      identifier(name) &&
      name.name === 'require' &&
      required.length === 1 &&
      specifier !== undefined &&
      /^(?:\.\.\/\.\.\/server|next\/dist\/server)\/app-render\/entry-base(?:\.js)?$/u.test(
        specifier,
      )
    );
  }

  private commonJsSetup(visit: Visit): boolean {
    const parent = visit.parent;
    if (parent?.type === 'CallExpression' && declaration('Object', visit.scopes) === undefined) {
      return (
        (isProgramCall(parent, this.byNode) && swcHeader(parent)) ||
        this.getterMap(parent, visit.scopes) ||
        this.starExport(parent, visit.scopes)
      );
    }
    if (parent?.type !== 'MemberExpression') return false;
    const assignment = this.byNode.get(parent)?.parent;
    const dead = assignment === undefined ? undefined : this.byNode.get(assignment)?.parent;
    return dead !== undefined && swcDeadAnnotation(dead) && isProgramCall(dead, this.byNode);
  }

  private factoryUse(value: Node): void {
    let visit = this.byNode.get(value);
    if (visit?.parent?.type === 'SequenceExpression') {
      visit = this.byNode.get(visit.parent);
      if (visit?.parent?.type !== 'CallExpression' || unwrappedCallee(visit.parent) !== value)
        refuse('factory alias escape');
    }
    if (visit?.parent?.type !== 'CallExpression' || visit.key !== 'callee')
      refuse('factory alias escape');
    const call = visit.parent;
    if (call['optional'] === true) refuse('optional producer call');
    this.assertFactoryArgument(call);
    this.calls.add(call);
    const parent = this.byNode.get(call)?.parent;
    if (parent?.type !== 'VariableDeclarator' || !identifier(parent['id']))
      refuse('factory result escape');
  }

  private commonJsExport(visit: Visit): void {
    if (
      !identifier(visit.node) ||
      !['exports', 'module'].includes(visit.node.name) ||
      declaration(visit.node.name, visit.scopes) !== undefined
    )
      return;
    if (this.commonJsSetup(visit)) return;
    const member = visit.parent;
    const assignment = member === undefined ? undefined : this.byNode.get(member)?.parent;
    if (
      visit.node.name !== 'exports' ||
      member?.type !== 'MemberExpression' ||
      visit.key !== 'object' ||
      assignment?.type !== 'AssignmentExpression' ||
      assignment['left'] !== member ||
      assignment['operator'] !== '='
    )
      refuse('CommonJS export object escape');
    const value = this.origin(assignment['right'], visit.scopes);
    if (value?.kind !== 'selector' || propertyName(member) !== value.field)
      refuse('unreviewed CommonJS export');
  }

  private inspectHelperReference(visit: Visit): void {
    if (!identifier(visit.node)) return;
    const binding = declaration(visit.node.name, visit.scopes)?.node;
    if (binding !== undefined && this.exportHelpers.has(binding)) {
      const call = visit.parent;
      if (
        call?.type !== 'CallExpression' ||
        visit.key !== 'callee' ||
        !(this.getterMap(call, visit.scopes) || this.starExport(call, visit.scopes))
      )
        refuse('export helper binding escape');
    }
  }

  private inspectReference(visit: Visit): void {
    if (!identifier(visit.node) || !reference(visit)) return;
    this.inspectHelperReference(visit);
    this.commonJsExport(visit);
    const own = this.origin(visit.node, visit.scopes);
    if (own === undefined) return;
    if (own.kind === 'factory') {
      this.factoryUse(visit.node);
      return;
    }
    if (own.kind === 'selector') {
      this.exportDestination(visit.node, own.field);
      return;
    }
    const member = visit.parent;
    if (member?.type !== 'MemberExpression' || visit.key !== 'object')
      refuse('namespace or instance alias escape');
    const selected = this.origin(member, visit.scopes);
    if (selected?.kind === 'factory') this.factoryUse(member);
    else if (selected?.kind === 'selector') this.exportDestination(member, selected.field);
    else refuse('unreviewed namespace use');
  }

  prove(): NodeManifestConsumerProof {
    for (const visit of this.visits) this.collectImport(visit);
    for (const visit of this.visits) this.inspectReference(visit);
    if (this.calls.size !== 1 || this.exported.size !== FIELDS.length)
      refuse('incomplete or repeated producer');
    return {
      kind: 'app-page-template',
      page: this.input.route.page,
      pathname: this.input.route.pathname,
      exports: FIELDS,
      requiresRuntimeNormalization: true,
    };
  }
}

/** A producer match is not an export-consumer/normalization proof; the graph must close both. */
export function assertNodeManifestConsumer(
  input: NodeManifestConsumerInput,
): NodeManifestConsumerProof {
  if (createHash('sha256').update(input.source.code).digest('hex') !== input.source.sha256)
    refuse('source identity');
  let program: unknown;
  try {
    program = parseAst(input.source.code);
  } catch {
    refuse('syntax');
  }
  if (!isNode(program)) refuse('syntax');
  return new Consumer(input, program).prove();
}
