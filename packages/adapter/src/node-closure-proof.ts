import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node, type Scope, scopeOpenedBy } from './lexical-scope.ts';
import { nativeBindings, walk } from './native-ast.ts';
import { hasRetainedWorkerCapability } from './native-worker.ts';
import {
  assignedNodeChoiceOrigin,
  nodeNamespaceAliasUse,
  type NodeClosureBuiltin as Builtin,
  type NodeClosureOrigin as Origin,
} from './node-closure-assigned-origins.ts';
import { globalPatternRefusal } from './node-closure-globals.ts';
import {
  assignedNodeHosts,
  hostObjectOf,
  nodeHostBinding as bindingOf,
  nodeHostIdentifier as isIdentifier,
  type AssignedNodeHosts,
} from './node-closure-hosts.ts';
import {
  NODE_MODULE_LOADERS as MODULE_LOADERS,
  type NodeClosureLoaders,
} from './node-closure-module-loaders.ts';
import {
  nodeClosureReference as isReference,
  nodeCompilerMetadataSites,
} from './node-compiler-metadata.ts';
import { nodeJwtCompilerSite, type NodeJwtCompilerProof } from './node-jwt-compiler-proof.ts';
import { isGlobalCompiler } from './node-jwt-compiler-sites.ts';
import { nodeNextRequireHookSites } from './node-next-require-hook-proof.ts';
import type { NodeNextRequireHookSites } from './node-next-require-hook-sites.ts';
import { nodeWsLoaderSites } from './node-ws-loader-proof.ts';

export { originalNodeHostLoaderRefusal } from './node-original-host-proof.ts';

type Origins = ReadonlyMap<Node, Origin> & { readonly assigned?: AssignedNodeHosts };
interface Visit {
  readonly node: Node;
  readonly parent: Node | undefined;
  readonly key: string | undefined;
  readonly scopes: readonly Scope[];
}
interface Traversal {
  readonly program: Node;
  readonly imports: Origins;
  readonly factories: ReadonlyMap<Node, string | null>;
  readonly contexts: Map<Scope, string>;
}
const NODE_LOADER_REFUSAL = 'an unproved Node module loader or code compiler';

const PROCESS_LOADERS = new Set([
  '_linkedBinding',
  'binding',
  'dlopen',
  'getBuiltinModule',
  'mainModule',
]);
const VM_COMPILERS = new Set([
  'compileFunction',
  'runInContext',
  'runInNewContext',
  'runInThisContext',
  'Script',
  'SourceTextModule',
  'SyntheticModule',
]);
const CHILD_PROCESS_EXECUTORS = new Set([
  '_forkChild',
  'ChildProcess',
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);

function stringOf(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node.type !== 'TemplateLiteral' || listOf(node, 'expressions').length > 0) return undefined;
  const quasi = listOf(node, 'quasis')[0];
  const value = isNode(quasi) ? quasi['value'] : undefined;
  return typeof value === 'object' &&
    value !== null &&
    'cooked' in value &&
    typeof value.cooked === 'string'
    ? value.cooked
    : undefined;
}

function memberOf(node: Node): string | undefined {
  const property = node['property'];
  if (node['computed'] === true) return stringOf(property);
  return isIdentifier(property) ? property.name : undefined;
}

function builtinOf(specifier: string | undefined): Builtin | undefined {
  const name = specifier?.replace(/^node:/u, '');
  return name === 'child_process' || name === 'module' || name === 'process' || name === 'vm'
    ? name
    : undefined;
}

function importedOrigins(program: Node): Map<Node, Origin> {
  const origins = new Map<Node, Origin>();
  for (const declaration of listOf(program, 'body')) {
    if (!isNode(declaration) || declaration.type !== 'ImportDeclaration') continue;
    const builtin = builtinOf(stringOf(declaration['source']));
    if (builtin === undefined) continue;
    for (const specifier of listOf(declaration, 'specifiers')) {
      if (!isNode(specifier)) continue;
      const imported = specifier['imported'];
      const member = isIdentifier(imported) ? imported.name : stringOf(imported);
      origins.set(specifier, {
        builtin,
        ...(!(member === undefined || member === 'default') && { member }),
      });
    }
  }
  return origins;
}

function originOf(
  value: unknown,
  scopes: readonly Scope[],
  imports: Origins,
  seen = new Set<Node>(),
): Origin | undefined {
  let current = value;
  while (isNode(current) && !seen.has(current)) {
    seen.add(current);
    const imported = imports.get(current);
    if (imported !== undefined) return imported;
    if (isIdentifier(current)) return identifierOrigin(current.name, scopes, imports, seen);
    if (current.type === 'VariableDeclarator') {
      current = current['init'];
      continue;
    }
    if (current.type === 'MemberExpression') return memberOrigin(current, scopes, imports, seen);
    if (
      (imports.assigned?.size ?? 0) > 0 &&
      ['ConditionalExpression', 'LogicalExpression'].includes(current.type)
    )
      return assignedNodeChoiceOrigin(current, (choice) =>
        originOf(choice, scopes, imports, new Set(seen)),
      );
    return requiredOrigin(current, scopes);
  }
  return undefined;
}

function identifierOrigin(
  name: string,
  scopes: readonly Scope[],
  imports: Origins,
  seen: Set<Node>,
): Origin | undefined {
  const binding = bindingOf(name, scopes);
  if (binding !== undefined) return originOf(binding.node, binding.scopes, imports, seen);
  return name === 'process' ? { builtin: 'process' } : undefined;
}

function memberOrigin(
  value: Node,
  scopes: readonly Scope[],
  imports: Origins,
  seen: Set<Node>,
): Origin | undefined {
  const host = hostMemberOrigin(value, scopes, imports.assigned);
  if (host !== undefined) return host;
  const owner = originOf(value['object'], scopes, imports, seen);
  if (owner === undefined || owner.member !== undefined) return owner;
  const member = memberOf(value);
  return member === 'default' ? owner : { builtin: owner.builtin, member: member ?? '*' };
}

function hostMemberOrigin(
  value: Node,
  scopes: readonly Scope[],
  assigned?: AssignedNodeHosts,
): Origin | undefined {
  const owner = hostObjectOf(value['object'], scopes, new Set(), assigned);
  const member = memberOf(value);
  if (owner === 'global' && member === 'process') return { builtin: 'process' };
  if (owner !== 'cjs-module') return undefined;
  if (member === 'constructor') return { builtin: 'module', member: 'Module' };
  if (member === 'require' || member === 'load') return { builtin: 'module', member: 'load' };
  return member === undefined ? { builtin: 'module', member: '*' } : undefined;
}

function requiredOrigin(value: Node, scopes: readonly Scope[]): Origin | undefined {
  if (
    value.type !== 'CallExpression' ||
    !isIdentifier(value['callee'], 'require') ||
    bindingOf('require', scopes) !== undefined
  )
    return undefined;
  const builtin = builtinOf(stringOf(listOf(value, 'arguments')[0]));
  return builtin === undefined ? undefined : { builtin };
}

function isForbiddenOrigin(origin: Origin | undefined): boolean {
  if (origin?.member === undefined) return false;
  if (origin.member === '*') return true;
  switch (origin.builtin) {
    case 'child_process': {
      return CHILD_PROCESS_EXECUTORS.has(origin.member);
    }
    case 'module': {
      return MODULE_LOADERS.has(origin.member);
    }
    case 'process': {
      return PROCESS_LOADERS.has(origin.member);
    }
    case 'vm': {
      return VM_COMPILERS.has(origin.member);
    }
  }
}

function exportTable(assignment: Node): Node | undefined {
  if (assignment.type !== 'AssignmentExpression' || assignment['operator'] !== '=')
    return undefined;
  const left = assignment['left'];
  const right = assignment['right'];
  // Rolldown may rename the CommonJS wrapper's module parameter. Its exports table and the
  // numeric-id/factory protocol remain the same; no ordinary geometry member identifies it.
  return isNode(left) &&
    left.type === 'MemberExpression' &&
    isIdentifier(left['object']) &&
    memberOf(left) === 'exports' &&
    isNode(right) &&
    right.type === 'ArrayExpression'
    ? right
    : undefined;
}

function exportTables(program: Node): Node[] {
  const tables: Node[] = [];
  const pending = [program];
  for (let assignment = pending.pop(); assignment !== undefined; assignment = pending.pop()) {
    const children = childVisits(assignment, []);
    for (const child of children) pending.push(child.node);
    const table = exportTable(assignment);
    if (table !== undefined) tables.push(table);
  }
  return tables;
}

function registerFactory(element: Node, factories: Map<Node, string | null>): void {
  if (element.type !== 'ArrowFunctionExpression' && element.type !== 'FunctionExpression') return;
  const context = listOf(element, 'params')[0];
  if (context !== undefined) factories.set(element, isIdentifier(context) ? context.name : null);
}

function scanFactoryTable(table: Node, tables: Node[], factories: Map<Node, string | null>): void {
  let hasId = false;
  const elements = listOf(table, 'elements').entries();
  for (const [index, element] of elements) {
    if (!isNode(element)) {
      hasId = false;
      continue;
    }
    if (index === 0 && element.type === 'ArrayExpression') {
      tables.push(element);
      hasId = false;
      continue;
    }
    if (element.type === 'Literal' && typeof element['value'] === 'number') {
      hasId = true;
      continue;
    }
    if (hasId) registerFactory(element, factories);
    hasId = false;
  }
}

/** Reuse Turbopack's numeric-id/factory table shape, rather than a property's spelling alone. */
function factoriesOf(program: Node): Map<Node, string | null> {
  const factories = new Map<Node, string | null>();
  const tables = exportTables(program);
  for (let table = tables.pop(); table !== undefined; table = tables.pop())
    scanFactoryTable(table, tables, factories);
  return factories;
}

function installImports(scope: Scope, imports: ReadonlyMap<Node, Origin>): void {
  const specifiers = imports.keys();
  for (const specifier of specifiers) {
    const local = specifier['local'];
    if (!isIdentifier(local)) continue;
    scope.declared.add(local.name);
    scope.bindings.set(local.name, specifier);
  }
}

function visitScopes(visit: Visit, state: Traversal): readonly Scope[] {
  const scope = scopeOpenedBy(visit.node);
  if (scope === undefined) return visit.scopes;
  const context = state.factories.get(visit.node);
  if (context !== undefined && context !== null) state.contexts.set(scope, context);
  if (visit.node === state.program) installImports(scope, state.imports);
  return [...visit.scopes, scope];
}

function childVisits(node: Node, scopes: readonly Scope[]): Visit[] {
  const found: Visit[] = [];
  const properties = Object.entries(node);
  for (const [key, child] of properties) {
    if (key === 'parent') continue;
    const values: unknown[] = Array.isArray(child) ? child : [child];
    for (const value of values) {
      if (isNode(value)) found.push({ node: value, parent: node, key, scopes });
    }
  }
  return found;
}

function visits(
  program: Node,
  imports: Origins,
  factoryNames: ReadonlyMap<Node, string | null>,
): { visits: Visit[]; contexts: ReadonlyMap<Scope, string> } {
  const found: Visit[] = [];
  const contexts = new Map<Scope, string>();
  const state: Traversal = { program, imports, factories: factoryNames, contexts };
  const pending: Visit[] = [{ node: program, parent: undefined, key: undefined, scopes: [] }];
  for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
    const scopes = visitScopes(visit, state);
    found.push({ ...visit, scopes });
    const children = childVisits(visit.node, scopes);
    for (const child of children) pending.push(child);
  }
  return { visits: found, contexts };
}

function isContext(
  node: unknown,
  scopes: readonly Scope[],
  contexts: ReadonlyMap<Scope, string>,
  seen = new Set<Node>(),
): boolean {
  if (!isIdentifier(node) || seen.has(node)) return false;
  seen.add(node);
  const name = node.name;
  for (let at = scopes.length - 1; at >= 0; at -= 1) {
    const scope = scopes[at];
    if (scope?.declared.has(name) !== true) continue;
    if (contexts.get(scope) === name) return true;
    const declaration = scope.bindings.get(name);
    return (
      declaration?.type === 'VariableDeclarator' &&
      isContext(declaration['init'], scopes.slice(0, at + 1), contexts, seen)
    );
  }
  return false;
}

function isNamespaceEscape(
  visit: Visit,
  imports: Origins,
  builtin: 'child_process' | 'module' | 'process',
): boolean {
  const processChoice =
    builtin === 'process' &&
    ['ConditionalExpression', 'LogicalExpression'].includes(visit.node.type);
  if (
    !processChoice &&
    !['CallExpression', 'Identifier', 'MemberExpression'].includes(visit.node.type)
  )
    return false;
  const origin = originOf(visit.node, visit.scopes, imports);
  if (origin?.builtin !== builtin || origin.member !== undefined || !isReference(visit))
    return false;
  if (
    builtin === 'child_process' &&
    (visit.parent?.type === 'ExpressionStatement' ||
      (visit.parent?.type === 'UnaryExpression' && visit.parent['operator'] === 'typeof'))
  )
    return false;
  // A namespace alias remains tracked. All other exports/calls/returns would hand out a loader.
  return !nodeNamespaceAliasUse(visit, builtin === 'process');
}

function destructuredMember(property: Node): string | undefined {
  if (property['computed'] === true) return stringOf(property['key']);
  const key = property['key'];
  return isIdentifier(key) ? key.name : stringOf(key);
}

function isDestructuredLoader(
  node: Node,
  scopes: readonly Scope[],
  imports: ReadonlyMap<Node, Origin>,
): boolean {
  const pattern = node['id'];
  if (node.type !== 'VariableDeclarator' || !isNode(pattern) || pattern.type !== 'ObjectPattern')
    return false;
  const owner = originOf(node['init'], scopes, imports);
  if (owner === undefined) return false;
  return listOf(pattern, 'properties').some((property) => {
    return (
      isNode(property) &&
      (property.type === 'RestElement' ||
        isForbiddenOrigin({ builtin: owner.builtin, member: destructuredMember(property) ?? '*' }))
    );
  });
}

function isContextLoader(visit: Visit, contexts: ReadonlyMap<Scope, string>): boolean {
  const { node, scopes } = visit;
  if (node.type === 'MemberExpression')
    return (
      isContext(node['object'], scopes, contexts) &&
      (memberOf(node) === 'y' || memberOf(node) === undefined)
    );
  const pattern = node['id'];
  if (
    node.type !== 'VariableDeclarator' ||
    !isNode(pattern) ||
    pattern.type !== 'ObjectPattern' ||
    !isContext(node['init'], scopes, contexts)
  )
    return false;
  return listOf(pattern, 'properties').some((property) => {
    return (
      isNode(property) &&
      (property.type === 'RestElement' ||
        destructuredMember(property) === 'y' ||
        destructuredMember(property) === undefined)
    );
  });
}

function isContextEscape(visit: Visit, contexts: ReadonlyMap<Scope, string>): boolean {
  if (!isReference(visit) || !isContext(visit.node, visit.scopes, contexts)) return false;
  return !(
    (visit.parent?.type === 'VariableDeclarator' && visit.key === 'init') ||
    (visit.parent?.type === 'MemberExpression' && visit.key === 'object')
  );
}

function importRefusal(node: Node, imports: ReadonlyMap<Node, Origin>): string | undefined {
  if (
    node.type === 'ImportDeclaration' &&
    listOf(node, 'specifiers').some(
      (specifier) => isNode(specifier) && isForbiddenOrigin(imports.get(specifier)),
    )
  )
    return NODE_LOADER_REFUSAL;
  if (node.type === 'ImportExpression' && builtinOf(stringOf(node['source'])) !== undefined)
    return 'an unproved dynamically imported Node loader namespace';
  if (
    (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
    builtinOf(stringOf(node['source'])) === 'child_process'
  )
    return 'an unproved Node child-process namespace escape';
  return undefined;
}

function loaderRefusal(
  visit: Visit,
  imports: Origins,
  compilers: ReadonlySet<Node>,
  hook: NodeNextRequireHookSites,
): string | undefined {
  const { node, scopes } = visit;
  const globalPattern = globalPatternRefusal(node, scopes, imports.assigned);
  if (globalPattern !== undefined) return globalPattern;
  if (
    !compilers.has(node) &&
    isReference(visit) &&
    isGlobalCompiler(node, scopes, imports.assigned)
  )
    return 'an unproved JavaScript code compiler';
  if (isNamespaceRebinding(visit, imports)) return 'an unproved rebound Node loader namespace';
  if (
    (node.type === 'MemberExpression' &&
      !hook.operations.has(node) &&
      isForbiddenOrigin(originOf(node, scopes, imports))) ||
    isDestructuredLoader(node, scopes, imports)
  )
    return NODE_LOADER_REFUSAL;
  const imported = importRefusal(node, imports);
  if (imported !== undefined) return imported;
  if (!hook.namespaceOperands.has(node) && isNamespaceEscape(visit, imports, 'module'))
    return 'an unproved Node Module namespace escape';
  if (isNamespaceEscape(visit, imports, 'child_process'))
    return 'an unproved Node child-process namespace escape';
  if ((imports.assigned?.size ?? 0) > 0 && isNamespaceEscape(visit, imports, 'process'))
    return 'an unproved assigned Node process namespace escape';
  return undefined;
}

function isNamespaceRebinding(visit: Visit, imports: Origins): boolean {
  const { node, scopes } = visit;
  if (node.type !== 'AssignmentExpression' || !isIdentifier(node['left'])) return false;
  if (imports.assigned?.has(node) === true) return false;
  if (hostObjectOf(node['right'], scopes, new Set(), imports.assigned) !== undefined) return true;
  const origin = originOf(node['right'], scopes, imports);
  return origin !== undefined && origin.member === undefined;
}

/** Refuse executable closures the physical Node graph has not proved; never a Worker fallback. */
export function dynamicNodeClosureRefusal(
  file: string,
  code: string,
  jwt?: NodeJwtCompilerProof,
  loaders?: NodeClosureLoaders,
): string | undefined {
  const parsed = parseAst(code);
  const program: unknown = parsed;
  if (!isNode(program)) throw new TypeError('Node closure proof requires a JavaScript program');
  if (hasRetainedWorkerCapability(walk(parsed), nativeBindings(parsed)))
    return 'an unproved Node Worker native-child closure';
  const imports = importedOrigins(program);
  const factories = factoriesOf(program);
  const { visits: all, contexts } = visits(program, imports, factories);
  const origins = Object.assign(imports, { assigned: assignedNodeHosts(all) });
  const serverChunk = /[/\\]server[/\\]chunks[/\\]/u.test(file);
  if (serverChunk && [...factories.values()].includes(null))
    return 'an unproved Turbopack factory context';
  const jwtSite = nodeJwtCompilerSite(jwt, file, code, program);
  const compilerSites = new Set(nodeCompilerMetadataSites(all));
  if (jwtSite !== undefined) compilerSites.add(jwtSite);
  const wsSites = nodeWsLoaderSites(loaders?.ws, file, code, program);
  for (const site of wsSites) compilerSites.add(site);
  const hookSites = nodeNextRequireHookSites(loaders?.nextRequireHook, file, code, program);
  for (const visit of all) {
    if (serverChunk && (isContextLoader(visit, contexts) || isContextEscape(visit, contexts)))
      return 'an unproved Turbopack external import';
    const refusal = loaderRefusal(visit, origins, compilerSites, hookSites);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}
