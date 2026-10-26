import { AuditError } from '../../packages/adapter/src/dependencies.ts';
import { isNode, listOf, type Node, type Scope } from '../../packages/adapter/src/lexical-scope.ts';
import { nativeSourceAnalysis } from '../../packages/adapter/src/native-source-parser.ts';
import {
  identifier,
  reference,
  visitTree,
  type Visit,
} from '../../packages/adapter/src/node-manifest-consumer-ast.ts';
import {
  nodeManifestTurbopackFactories,
  turbopackModuleId,
  type NodeManifestTurbopackModuleId,
} from '../../packages/adapter/src/node-manifest-turbopack.ts';
import {
  parsePagesHandlerProfile,
  type PagesHandlerProfileFile,
} from '../../packages/adapter/src/node-pages-handler-profile.ts';

const MARKER = '__upwind_public_pages_get_handler__';
const MAX_AST_NODES = 250_000;
const MAX_ALIASES = 16;
const MODULE_ORIGIN = 'module-origin-not-closed';
const CAPTURE = 'unclosed-function-capture';
const INVALID_SYNTAX = 'invalid-source-syntax';
const PORT_KINDS: ReadonlyMap<string, Port['kind']> = new Map([
  ['i', 'internal-import'],
  ['r', 'internal-require'],
  ['x', 'external-import'],
]);
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression']);
type Reason =
  | 'marker-absent'
  | 'duplicate-marker'
  | 'invalid-source-syntax'
  | 'unsupported-dynamic-scope'
  | 'ast-budget'
  | 'unsupported-marker-use'
  | 'shadowed-global'
  | 'reassigned-global'
  | 'global-object-escape'
  | 'unsupported-rhs'
  | 'unknown-binding'
  | 'mutable-binding'
  | 'cyclic-binding'
  | 'module-origin-not-closed'
  | 'unclosed-function-capture'
  | 'escaping-function-binding'
  | 'direct-function-data';
interface Location {
  readonly file: string;
  readonly sha256: string;
  readonly start: number;
  readonly end: number;
}
interface FactoryContext {
  readonly start: number;
  readonly end: number;
  readonly context: { readonly name: string; readonly start: number; readonly end: number };
  readonly registeredIds: readonly NodeManifestTurbopackModuleId[];
}
interface Selection {
  readonly declaration: Location;
  readonly function: Location & {
    readonly type: string;
    readonly async: boolean;
    readonly generator: boolean;
  };
  readonly aliases: readonly Location[];
  readonly factory?: FactoryContext | undefined;
}
interface Port {
  readonly kind: 'internal-import' | 'internal-require' | 'external-import';
  readonly call: Location;
  readonly targetId?: NodeManifestTurbopackModuleId | undefined;
}
export interface PagesHandlerSelection {
  readonly status: 'UNQUALIFIED';
  readonly reason: Reason;
  readonly marker?: Location | undefined;
  readonly selection?: Selection | undefined;
  readonly port?: Port | undefined;
}
interface Analysis {
  readonly file: PagesHandlerProfileFile;
  readonly visits: readonly Visit[];
  readonly byNode: ReadonlyMap<Node, Visit>;
}
interface Marker {
  readonly analysis: Analysis;
  readonly member: Node;
  readonly visit: Visit;
}
interface Binding {
  readonly scope: Scope;
  readonly declaration: Node | undefined;
}
interface Resolved {
  readonly fn: Node;
  readonly declaration: Node;
  readonly aliases: readonly {
    readonly name: string;
    readonly binding: Binding;
    readonly use: Node;
  }[];
}
function result(
  reason: Reason,
  values: Omit<PagesHandlerSelection, 'status' | 'reason'> = {},
): PagesHandlerSelection {
  return Object.freeze({ status: 'UNQUALIFIED', reason, ...values });
}
function location(analysis: Analysis, node: Node): Location {
  return Object.freeze({
    file: analysis.file.name,
    sha256: analysis.file.sha256,
    start: node.start,
    end: node.end,
  });
}
function keyOf(member: Node): string | undefined {
  const property = member['property'];
  if (member['computed'] !== true) return identifier(property) ? property.name : undefined;
  return isNode(property) && property.type === 'Literal' && typeof property['value'] === 'string'
    ? property['value']
    : undefined;
}
function bindingOf(visit: Visit, name: string): Binding | undefined {
  const scope = visit.scopes.findLast((value) => value.declared.has(name));
  return scope === undefined ? undefined : { scope, declaration: scope.bindings.get(name) };
}
function sameBinding(visit: Visit, name: string, binding: Binding | undefined): boolean {
  return bindingOf(visit, name)?.scope === binding?.scope;
}
function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const child of Object.values(node)) {
    const values: unknown[] = Array.isArray(child) ? child : [child];
    for (const value of values) if (isNode(value)) found.push(value);
  }
  return found;
}
function boundedTree(program: Node): boolean {
  const pending = [program];
  let count = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    count += 1;
    if (count > MAX_AST_NODES) return false;
    for (const child of children(node)) pending.push(child);
  }
  return true;
}
function analysisOf(file: PagesHandlerProfileFile): {
  readonly analysis?: Analysis;
  readonly reason?: Reason;
} {
  let program: unknown;
  try {
    const parsed = nativeSourceAnalysis(file.source, file.name);
    program = parsed.code === file.source ? parsed.program : undefined;
  } catch {
    return { reason: INVALID_SYNTAX };
  }
  if (!isNode(program)) return { reason: INVALID_SYNTAX };
  if (!boundedTree(program)) return { reason: 'ast-budget' };
  const visits = visitTree(program);
  if (
    visits.some((visit) => {
      const callee = visit.node['callee'];
      return (
        visit.node.type === 'WithStatement' ||
        (visit.node.type === 'CallExpression' &&
          identifier(callee) &&
          callee.name === 'eval' &&
          bindingOf(visit, 'eval') === undefined)
      );
    })
  )
    return { reason: 'unsupported-dynamic-scope' };
  return {
    analysis: { file, visits, byNode: new Map(visits.map((visit) => [visit.node, visit])) },
  };
}
function patternParent(parent: Node, node: Node): boolean {
  return (
    ['ArrayPattern', 'ObjectPattern', 'RestElement'].includes(parent.type) ||
    (parent.type === 'Property' && parent['value'] === node) ||
    (parent.type === 'AssignmentPattern' && parent['left'] === node)
  );
}
function written(node: Node, analysis: Analysis): boolean {
  let current = node;
  for (
    let parent = analysis.byNode.get(current)?.parent;
    parent !== undefined;
    parent = analysis.byNode.get(current)?.parent
  ) {
    if (parent.type === 'AssignmentExpression') return parent['left'] === current;
    if (parent.type === 'UpdateExpression') return parent['argument'] === current;
    if (parent.type === 'UnaryExpression')
      return parent['operator'] === 'delete' && parent['argument'] === current;
    if (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement')
      return parent['left'] === current;
    if (!patternParent(parent, current)) return false;
    current = parent;
  }
  return false;
}
function globalReference(visit: Visit): boolean {
  if (visit.parent?.type === 'UnaryExpression' && visit.parent['operator'] === 'typeof')
    return false;
  return (
    identifier(visit.node) &&
    visit.node.name === 'globalThis' &&
    reference(visit) &&
    bindingOf(visit, 'globalThis') === undefined
  );
}
function changedGlobal(member: Node, analysis: Analysis): boolean {
  return (
    written(member, analysis) && (keyOf(member) === undefined || keyOf(member) === 'globalThis')
  );
}
function globalIssue(analysis: Analysis): Reason | undefined {
  for (const visit of analysis.visits) {
    if (!globalReference(visit)) continue;
    const { node, parent } = visit;
    if (written(node, analysis)) return 'reassigned-global';
    if (parent?.type === 'MemberExpression' && parent['object'] === node) {
      if (changedGlobal(parent, analysis)) return 'reassigned-global';
      if (keyOf(parent) === 'globalThis') return 'global-object-escape';
      continue;
    }
    return 'global-object-escape';
  }
  return undefined;
}
function factoryOf(node: Node, analysis: Analysis): FactoryContext | undefined {
  let factories: ReturnType<typeof nodeManifestTurbopackFactories>;
  try {
    factories = nodeManifestTurbopackFactories({
      code: analysis.file.source,
      sha256: analysis.file.sha256,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'PARSE_ERROR') return undefined;
    if (!(error instanceof AuditError)) throw error;
    return undefined;
  }
  const factory = factories.find((value) => value.start <= node.start && value.end >= node.end);
  if (factory === undefined) return undefined;
  const fn = analysis.visits.find(
    (visit) => visit.node.start === factory.start && visit.node.end === factory.end,
  )?.node;
  const context = fn === undefined ? undefined : listOf(fn, 'params')[0];
  if (!identifier(context)) return undefined;
  return Object.freeze({
    start: factory.start,
    end: factory.end,
    context: Object.freeze({ name: context.name, start: context.start, end: context.end }),
    registeredIds: Object.freeze([...factory.ids]),
  });
}
function portOf(node: Node, analysis: Analysis): Port | undefined {
  if (node.type !== 'CallExpression' || node['optional'] === true) return undefined;
  const callee = node['callee'];
  if (
    !isNode(callee) ||
    callee.type !== 'MemberExpression' ||
    callee['optional'] === true ||
    !identifier(callee['object'])
  )
    return undefined;
  const factory = factoryOf(node, analysis);
  const found =
    factory === undefined
      ? undefined
      : analysis.visits.find(
          (visit) => visit.node.start === factory.start && visit.node.end === factory.end,
        );
  const visit = analysis.byNode.get(node);
  if (
    found === undefined ||
    visit === undefined ||
    factory?.context.name !== callee['object'].name ||
    bindingOf(visit, callee['object'].name)?.scope !== found.scopes.at(-1)
  )
    return undefined;
  const method = keyOf(callee);
  const kind = PORT_KINDS.get(method ?? '');
  if (kind === undefined) return undefined;
  const targetId = turbopackModuleId(listOf(node, 'arguments')[0]);
  return Object.freeze({
    kind,
    call: location(analysis, node),
    ...(method !== 'x' && { targetId }),
  });
}
function memberPort(node: Node, analysis: Analysis): Port | undefined {
  const receiver = node['object'];
  if (!isNode(receiver)) return undefined;
  if (!identifier(receiver)) return portOf(receiver, analysis);
  const visit = analysis.byNode.get(receiver);
  const declaration =
    visit === undefined ? undefined : bindingOf(visit, receiver.name)?.declaration;
  const statement =
    declaration === undefined ? undefined : analysis.byNode.get(declaration)?.parent;
  const init = declaration?.['init'];
  return statement?.type === 'VariableDeclaration' && statement['kind'] === 'const' && isNode(init)
    ? portOf(init, analysis)
    : undefined;
}
interface Unresolved {
  readonly reason: Reason;
  readonly port?: Port | undefined;
}
interface OriginStep {
  readonly declaration: Node;
  readonly binding: Binding;
  readonly name: string;
  readonly value: Node;
}
function unresolved(node: Node, analysis: Analysis): Unresolved {
  if (node.type === 'MemberExpression')
    return { reason: MODULE_ORIGIN, port: memberPort(node, analysis) };
  if (node.type === 'CallExpression')
    return { reason: MODULE_ORIGIN, port: portOf(node, analysis) };
  return { reason: 'unsupported-rhs' };
}
function constValue(declaration: Node, analysis: Analysis): Node | undefined {
  const parent = analysis.byNode.get(declaration)?.parent;
  const init = declaration['init'];
  return declaration.type === 'VariableDeclarator' &&
    parent?.type === 'VariableDeclaration' &&
    parent['kind'] === 'const' &&
    isNode(init)
    ? init
    : undefined;
}
function originStep(node: Node, analysis: Analysis): OriginStep | Unresolved {
  if (!identifier(node)) return unresolved(node, analysis);
  const visit = analysis.byNode.get(node);
  const binding = visit === undefined ? undefined : bindingOf(visit, node.name);
  const declaration = binding?.declaration;
  if (binding === undefined || declaration === undefined) return { reason: 'unknown-binding' };
  if (declaration.type.startsWith('Import')) return { reason: MODULE_ORIGIN };
  const value =
    declaration.type === 'FunctionDeclaration' ? declaration : constValue(declaration, analysis);
  if (value === undefined) return { reason: 'mutable-binding' };
  if (!FUNCTIONS.has(value.type) && !identifier(value)) return unresolved(value, analysis);
  return { declaration, binding, name: node.name, value };
}
function origin(
  node: Node,
  analysis: Analysis,
): { readonly resolved?: Resolved; readonly reason?: Reason; readonly port?: Port | undefined } {
  const aliases: Resolved['aliases'][number][] = [];
  const seen = new Set<Node>();
  let current = node;
  for (let depth = 0; depth < MAX_ALIASES; depth += 1) {
    const step = originStep(current, analysis);
    if ('reason' in step) return step;
    if (seen.has(step.declaration)) return { reason: 'cyclic-binding' };
    seen.add(step.declaration);
    aliases.push({ name: step.name, binding: step.binding, use: current });
    if (FUNCTIONS.has(step.value.type))
      return { resolved: { fn: step.value, declaration: step.declaration, aliases } };
    current = step.value;
  }
  return { reason: 'cyclic-binding' };
}
function unstable(alias: Resolved['aliases'][number], visit: Visit, analysis: Analysis): boolean {
  const node = visit.node;
  if (
    !identifier(node) ||
    node.name !== alias.name ||
    !sameBinding(visit, node.name, alias.binding) ||
    node === alias.binding.declaration?.['id']
  )
    return false;
  if (
    visit.key === 'id' &&
    ['FunctionDeclaration', 'VariableDeclarator'].includes(visit.parent?.type ?? '')
  )
    return true;
  return reference(visit) && written(node, analysis);
}
function stable(resolved: Resolved, analysis: Analysis): boolean {
  return resolved.aliases.every((alias) =>
    analysis.visits.every((visit) => !unstable(alias, visit, analysis)),
  );
}
function matchingAlias(visit: Visit, resolved: Resolved): Resolved['aliases'][number] | undefined {
  const node = visit.node;
  return identifier(node)
    ? resolved.aliases.find(
        (value) => value.name === node.name && sameBinding(visit, node.name, value.binding),
      )
    : undefined;
}
function closedIdentifier(visit: Visit, resolved: Resolved, scope: Scope): boolean {
  const node = visit.node;
  if (!identifier(node)) return false;
  const binding = bindingOf(visit, node.name);
  if (binding === undefined && node.name === 'undefined') return true;
  return (
    (binding !== undefined &&
      visit.scopes.slice(visit.scopes.indexOf(scope)).includes(binding.scope)) ||
    matchingAlias(visit, resolved) !== undefined
  );
}
function issueAt(visit: Visit, resolved: Resolved, scope: Scope): Reason | undefined {
  const node = visit.node;
  const inside = node.start >= resolved.fn.start && node.end <= resolved.fn.end;
  if (inside && ['MetaProperty', 'Super', 'ThisExpression'].includes(node.type)) return CAPTURE;
  if (!identifier(node) || !reference(visit)) return undefined;
  if (inside) return closedIdentifier(visit, resolved, scope) ? undefined : CAPTURE;
  const alias = matchingAlias(visit, resolved);
  return alias !== undefined && node !== alias.use && node !== alias.binding.declaration?.['id']
    ? 'escaping-function-binding'
    : undefined;
}
function functionIssue(resolved: Resolved, analysis: Analysis): Reason | undefined {
  const fnVisit = analysis.byNode.get(resolved.fn);
  const scope = fnVisit?.scopes.at(-1);
  if (scope === undefined) return CAPTURE;
  for (const visit of analysis.visits) {
    const issue = issueAt(visit, resolved, scope);
    if (issue !== undefined) return issue;
  }
  return undefined;
}
function selected(resolved: Resolved, analysis: Analysis): Selection {
  return Object.freeze({
    declaration: location(analysis, resolved.declaration),
    function: Object.freeze({
      ...location(analysis, resolved.fn),
      type: resolved.fn.type,
      async: resolved.fn['async'] === true,
      generator: resolved.fn['generator'] === true,
    }),
    aliases: Object.freeze(
      resolved.aliases.map((value) =>
        location(analysis, value.binding.declaration ?? resolved.declaration),
      ),
    ),
    factory: factoryOf(resolved.fn, analysis),
  });
}
function fromMarker(marker: Marker): PagesHandlerSelection {
  const { analysis, member, visit } = marker;
  const object = member['object'];
  const at = location(analysis, member);
  if (!identifier(object) || object.name !== 'globalThis' || member['optional'] === true)
    return result('unsupported-marker-use', { marker: at });
  if (bindingOf(visit, 'globalThis') !== undefined)
    return result('shadowed-global', { marker: at });
  const assignment = visit.parent;
  if (
    assignment?.type !== 'AssignmentExpression' ||
    assignment['operator'] !== '=' ||
    assignment['left'] !== member ||
    !isNode(assignment['right'])
  )
    return result('unsupported-marker-use', { marker: at });
  const found = origin(assignment['right'], analysis);
  if (found.resolved === undefined)
    return result(found.reason ?? 'unknown-binding', {
      marker: at,
      ...(found.port !== undefined && { port: found.port }),
    });
  if (!stable(found.resolved, analysis)) return result('mutable-binding', { marker: at });
  return result(functionIssue(found.resolved, analysis) ?? 'direct-function-data', {
    marker: at,
    selection: selected(found.resolved, analysis),
  });
}
export function selectPagesHandlerOrigin(value: unknown): PagesHandlerSelection {
  const profile = parsePagesHandlerProfile(value);
  const markers: Marker[] = [];
  let global: Reason | undefined;
  for (const file of profile.files) {
    const parsed = analysisOf(file);
    const analysis = parsed.analysis;
    if (analysis === undefined) return result(parsed.reason ?? INVALID_SYNTAX);
    global ??= globalIssue(analysis);
    for (const visit of analysis.visits) {
      if (visit.node.type !== 'MemberExpression' || keyOf(visit.node) !== MARKER) continue;
      markers.push({ analysis, member: visit.node, visit });
      if (markers.length > 1) return result('duplicate-marker');
    }
  }
  const marker = markers[0];
  if (marker === undefined) return result('marker-absent');
  if (global !== undefined)
    return result(global, { marker: location(marker.analysis, marker.member) });
  return fromMarker(marker);
}
