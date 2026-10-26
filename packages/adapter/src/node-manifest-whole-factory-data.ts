import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { NodeManifestAlpha } from './node-manifest-alpha.ts';
import { identifier, propertyName, visitTree, type Visit } from './node-manifest-consumer-ast.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
  turbopackModuleId,
  type NodeManifestTurbopackModuleId,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

interface DirectiveData {
  readonly raw: string;
  readonly value: string;
}
interface StrictScopeData {
  readonly type: string;
  readonly directives: readonly DirectiveData[];
}
interface ImportOccurrence {
  readonly kind: 'import' | 'require';
  /** Original physical source offsets, excluded from the canonical signature. */
  readonly start: number;
  readonly end: number;
}
interface ImportPort {
  readonly ordinal: number;
  readonly id: NodeManifestTurbopackModuleId;
  readonly idType: 'number' | 'string';
  readonly occurrences: readonly ImportOccurrence[];
}
export interface NodeManifestWholeFactoryData {
  readonly version: 1;
  readonly originalSha256: string;
  readonly factory: {
    readonly start: number;
    readonly end: number;
    readonly ids: readonly NodeManifestTurbopackModuleId[];
  };
  readonly selectedOrdinal: number;
  readonly strictContext: {
    readonly effective: boolean;
    readonly scopes: readonly StrictScopeData[];
  };
  /** Inert lexical/port DATA. Equality never certifies runtime or template semantics. */
  readonly canonical: string;
  readonly ports: readonly ImportPort[];
}
const MAX_SOURCE_BYTES = 4_194_304;
const MAX_FACTORY_BYTES = 1_048_576;
const MAX_AST_NODES = 100_000;
const MAX_AST_DEPTH = 256;
const MAX_FACTORIES = 4096;
const MAX_FACTORY_IDS = 4096;
const STRICT_SCOPES: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'Program',
]);

function refuse(reason: string): never {
  throw new AuditError(`Unproved whole Turbopack factory DATA ${reason}; refusing data view`);
}
function digest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
function childNodes(node: Node): readonly Node[] {
  return Object.values(node).flatMap((child) => {
    const values = Array.isArray(child) ? child : [child];
    return values.filter(isNode);
  });
}
function boundedProgram(code: string): Node {
  const parsed: unknown = parseAst(code);
  if (!isNode(parsed) || parsed.type !== 'Program') return refuse('program');
  const pending = [{ node: parsed, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const visit = pending.pop();
    if (visit === undefined) break;
    count += 1;
    if (count > MAX_AST_NODES || visit.depth > MAX_AST_DEPTH) refuse('AST bounds');
    for (const node of childNodes(visit.node)) pending.push({ node, depth: visit.depth + 1 });
  }
  return parsed;
}
function checkedProgram(projection: NodeManifestTurbopackProjection) {
  const source = Object.freeze({
    code: projection.original.code,
    sha256: projection.original.sha256,
  });
  if (Buffer.byteLength(source.code) > MAX_SOURCE_BYTES || digest(source.code) !== source.sha256)
    refuse('original source identity or bounds');
  const program = boundedProgram(source.code);
  const factories = nodeManifestTurbopackFactories(source);
  if (factories.length > MAX_FACTORIES) refuse('factory count bounds');
  const factory = factories.find(
    ({ start, end }) => start === projection.factory.start && end === projection.factory.end,
  );
  if (
    factory === undefined ||
    factory.ids.length > MAX_FACTORY_IDS ||
    Buffer.byteLength(source.code.slice(factory.start, factory.end)) > MAX_FACTORY_BYTES ||
    JSON.stringify(factory) !== JSON.stringify(projection.factory)
  )
    refuse('factory identity or bounds');
  if (!['dependencies', 'strict'].includes(projection.mode)) refuse('projection mode');
  const fresh = projectNodeManifestTurbopackFactory(source, projection.moduleId, projection.mode);
  if (JSON.stringify(fresh) !== JSON.stringify(projection)) refuse('fresh projection agreement');
  return { program, fresh };
}
function directives(node: Node): readonly DirectiveData[] {
  const body = node.type === 'Program' ? node : node['body'];
  const result: DirectiveData[] = [];
  if (!isNode(body)) return result;
  for (const statement of listOf(body, 'body')) {
    const value = isNode(statement) ? statement['expression'] : undefined;
    if (
      !isNode(statement) ||
      statement.type !== 'ExpressionStatement' ||
      !isNode(value) ||
      value.type !== 'Literal' ||
      value.start !== statement.start ||
      typeof value['value'] !== 'string' ||
      typeof value['raw'] !== 'string'
    )
      break;
    result.push(Object.freeze({ raw: value['raw'], value: value['value'] }));
  }
  return Object.freeze(result);
}
function strictContext(factory: Node, parents: ReadonlyMap<Node, Visit>) {
  const scopes: StrictScopeData[] = [];
  let effective = false;
  for (let node: Node | undefined = factory; node !== undefined; node = parents.get(node)?.parent) {
    if (!STRICT_SCOPES.has(node.type)) continue;
    const own = directives(node);
    if (
      node.type === 'ClassDeclaration' ||
      node.type === 'ClassExpression' ||
      own.some(({ raw }) => raw === "'use strict'" || raw === '"use strict"')
    )
      effective = true;
    scopes.push(Object.freeze({ type: node.type, directives: own }));
  }
  return Object.freeze({ effective, scopes: Object.freeze(scopes.toReversed()) });
}
function ownContext(node: unknown, visit: Visit, name: string, scope: Scope): boolean {
  return (
    identifier(node) &&
    node.name === name &&
    visit.scopes.findLast((value) => value.declared.has(name)) === scope
  );
}
class WholeFactoryPorts {
  private readonly ids: readonly NodeManifestTurbopackModuleId[];
  private readonly parents: ReadonlyMap<Node, Visit>;
  private readonly context: string;
  private readonly scope: Scope;
  private readonly ports = new Map<NodeManifestTurbopackModuleId, ImportPort>();
  readonly tokens = new Map<Node, string>();

  constructor(
    factory: Node,
    scope: Scope,
    projection: NodeManifestTurbopackProjection,
    visits: readonly Visit[],
  ) {
    const parameter = listOf(factory, 'params')[0];
    if (!identifier(parameter)) refuse('context parameter');
    this.context = parameter.name;
    this.scope = scope;
    this.ids = projection.factory.ids;
    this.parents = new Map(visits.map((visit) => [visit.node, visit]));
    if (scope.bindings.has(this.context)) refuse('context redeclaration');
    const ordered = visits.toSorted((a, b) => a.node.start - b.node.start);
    for (const visit of ordered) this.collect(visit);
  }

  private imported(argument: Node, call: Node, kind: 'import' | 'require'): void {
    const id = turbopackModuleId(argument) ?? refuse('dynamic import port');
    const previous = this.ports.get(id);
    const occurrence = Object.freeze({ kind, start: call.start, end: call.end });
    const port = {
      ordinal: previous?.ordinal ?? this.ports.size,
      id,
      idType: typeof id === 'number' ? 'number' : 'string',
      occurrences: [...(previous?.occurrences ?? []), occurrence],
    } as const;
    this.ports.set(id, port);
    this.tokens.set(
      argument,
      JSON.stringify({
        kind: 'import-port',
        type: port.idType,
        ordinal: port.ordinal,
        registeredOrdinal: this.ids.indexOf(id),
      }),
    );
  }

  private collect(visit: Visit): void {
    const member = visit.node;
    if (
      member.type !== 'MemberExpression' ||
      !ownContext(member['object'], visit, this.context, this.scope)
    )
      return;
    const name = propertyName(member);
    if (!['i', 'r', 's'].includes(name ?? '')) return;
    const call = this.parents.get(member)?.parent;
    if (
      member['optional'] === true ||
      member['computed'] === true ||
      call?.type !== 'CallExpression' ||
      call['callee'] !== member ||
      call['optional'] === true
    )
      refuse('unsupported context port');
    const args = listOf(call, 'arguments');
    if (name === 'i' || name === 'r') {
      const argument = args[0];
      if (args.length !== 1 || !isNode(argument)) refuse('import port arity');
      this.imported(argument, call, name === 'i' ? 'import' : 'require');
      return;
    }
    const argument = args[1];
    const id = turbopackModuleId(argument);
    if (id === undefined || !isNode(argument)) return;
    const ordinal = this.ids.indexOf(id);
    if (ordinal !== -1)
      this.tokens.set(
        argument,
        JSON.stringify({ kind: 'registered-module', type: typeof id, ordinal }),
      );
  }

  data(): readonly ImportPort[] {
    return Object.freeze(
      [...this.ports.values()].map((port) => {
        return Object.freeze({
          ...port,
          occurrences: Object.freeze(port.occurrences),
        });
      }),
    );
  }
}

/** Whole original callback DATA only. This creates no producer, runtime, or publication authority. */
export function nodeManifestWholeFactoryData(
  projection: NodeManifestTurbopackProjection,
): NodeManifestWholeFactoryData {
  const { program, fresh } = checkedProgram(projection);
  const all = visitTree(program);
  const found = all.find(
    ({ node }) => node.start === fresh.factory.start && node.end === fresh.factory.end,
  );
  const scope = found?.scopes.at(-1);
  if (found === undefined || scope === undefined) return refuse('parsed factory identity');
  const visits = all.filter(
    ({ node }) => node.start >= found.node.start && node.end <= found.node.end,
  );
  const ports = new WholeFactoryPorts(found.node, scope, fresh, visits);
  const strict = strictContext(found.node, new Map(all.map((visit) => [visit.node, visit])));
  const selectedOrdinal = fresh.factory.ids.indexOf(fresh.moduleId);
  if (selectedOrdinal === -1) return refuse('selected module identity');
  const alpha = new NodeManifestAlpha({
    original: program,
    body: [found.node],
    importToken: (node) => ports.tokens.get(node),
  });
  const canonical = canonicalJson({
    version: 1,
    registeredTypes: fresh.factory.ids.map((id) => typeof id),
    selectedOrdinal,
    strictContext: strict,
    callbackDirectives: visits
      .filter(({ node }) => STRICT_SCOPES.has(node.type))
      .toSorted((a, b) => a.node.start - b.node.start)
      .map(({ node }) => ({ type: node.type, directives: directives(node) })),
    callback: alpha.shape(found.node),
  });
  return Object.freeze<NodeManifestWholeFactoryData>({
    version: 1,
    originalSha256: fresh.original.sha256,
    factory: Object.freeze({
      ...fresh.factory,
      ids: Object.freeze([...fresh.factory.ids]),
    }),
    selectedOrdinal,
    strictContext: strict,
    canonical,
    ports: ports.data(),
  });
}

function canonicalJson(value: unknown): string {
  const result = JSON.stringify(value, (_key, child: unknown) =>
    typeof child === 'bigint' ? { type: 'BigIntValue', decimal: child.toString() } : child,
  );
  return result ?? refuse('canonical JSON');
}
