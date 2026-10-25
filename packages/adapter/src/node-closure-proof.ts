import { parseAst } from 'rolldown/parseAst';

import {
  childrenOf,
  isNode,
  listOf,
  type Node,
  type Scope,
  scopeOpenedBy,
} from './lexical-scope.ts';

type Builtin = 'child_process' | 'module' | 'process' | 'vm';
interface Origin {
  readonly builtin: Builtin;
  readonly member?: string;
}
interface Visit {
  readonly node: Node;
  readonly parent: Node | undefined;
  readonly key: string | undefined;
  readonly scopes: readonly Scope[];
}

const MODULE_LOADERS = new Set([
  'Module',
  '_cache',
  '_compile',
  '_extensions',
  '_findPath',
  '_load',
  '_resolveFilename',
  'constructor',
  'createRequire',
  'createRequireFromPath',
  'load',
  'prototype',
  'register',
  'registerHooks',
  'runMain',
  'wrap',
]);
const PROCESS_LOADERS = new Set([
  '_linkedBinding',
  'binding',
  'dlopen',
  'getBuiltinModule',
  'mainModule',
]);
const VM_COMPILERS = new Set([
  'Script',
  'SourceTextModule',
  'SyntheticModule',
  'compileFunction',
  'runInContext',
  'runInNewContext',
  'runInThisContext',
]);
const CHILD_PROCESS_EXECUTORS = new Set([
  'ChildProcess',
  '_forkChild',
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);

function identifier(
  node: unknown,
  name?: string,
): node is Node & { readonly type: 'Identifier'; readonly name: string } {
  return (
    isNode(node) &&
    node.type === 'Identifier' &&
    typeof node['name'] === 'string' &&
    (name === undefined || node['name'] === name)
  );
}

function stringOf(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node.type !== 'TemplateLiteral' || listOf(node, 'expressions').length !== 0) return undefined;
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
  return node['computed'] === true
    ? stringOf(node['property'])
    : identifier(node['property'])
      ? (node['property']['name'] as string)
      : undefined;
}

function builtinOf(specifier: string | undefined): Builtin | undefined {
  const name = specifier?.replace(/^node:/u, '');
  return name === 'child_process' || name === 'module' || name === 'process' || name === 'vm'
    ? name
    : undefined;
}

function bindingOf(
  name: string,
  scopes: readonly Scope[],
): { node: Node | undefined; scopes: readonly Scope[] } | undefined {
  for (let at = scopes.length - 1; at >= 0; at -= 1) {
    const scope = scopes[at];
    if (scope?.declared.has(name) === true)
      return { node: scope.bindings.get(name), scopes: scopes.slice(0, at + 1) };
  }
  return undefined;
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
      const member = identifier(imported) ? (imported['name'] as string) : stringOf(imported);
      origins.set(specifier, {
        builtin,
        ...(member === undefined || member === 'default' ? {} : { member }),
      });
    }
  }
  return origins;
}

function originOf(
  value: unknown,
  scopes: readonly Scope[],
  imports: ReadonlyMap<Node, Origin>,
  seen = new Set<Node>(),
): Origin | undefined {
  if (!isNode(value) || seen.has(value)) return undefined;
  seen.add(value);
  const imported = imports.get(value);
  if (imported !== undefined) return imported;
  if (identifier(value)) {
    const binding = bindingOf(value['name'] as string, scopes);
    if (binding !== undefined) return originOf(binding.node, binding.scopes, imports, seen);
    return value['name'] === 'process' ? { builtin: 'process' } : undefined;
  }
  if (value.type === 'VariableDeclarator') return originOf(value['init'], scopes, imports, seen);
  if (value.type === 'MemberExpression') return memberOrigin(value, scopes, imports, seen);
  return requiredOrigin(value, scopes);
}

function memberOrigin(
  value: Node,
  scopes: readonly Scope[],
  imports: ReadonlyMap<Node, Origin>,
  seen: Set<Node>,
): Origin | undefined {
  const owner = originOf(value['object'], scopes, imports, seen);
  if (owner === undefined || owner.member !== undefined) return owner;
  const member = memberOf(value);
  return member === 'default' ? owner : { builtin: owner.builtin, member: member ?? '*' };
}

function requiredOrigin(value: Node, scopes: readonly Scope[]): Origin | undefined {
  if (
    value.type !== 'CallExpression' ||
    !identifier(value['callee'], 'require') ||
    bindingOf('require', scopes) !== undefined
  )
    return undefined;
  const builtin = builtinOf(stringOf(listOf(value, 'arguments')[0]));
  return builtin === undefined ? undefined : { builtin };
}

function forbidden(origin: Origin | undefined): boolean {
  if (origin?.member === undefined) return false;
  if (origin.member === '*') return true;
  switch (origin.builtin) {
    case 'child_process':
      return CHILD_PROCESS_EXECUTORS.has(origin.member);
    case 'module':
      return MODULE_LOADERS.has(origin.member);
    case 'process':
      return PROCESS_LOADERS.has(origin.member);
    case 'vm':
      return VM_COMPILERS.has(origin.member);
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
    identifier(left['object']) &&
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
    for (const child of childrenOf(assignment)) {
      for (const value of Array.isArray(child) ? child : [child])
        if (isNode(value)) pending.push(value);
    }
    const table = exportTable(assignment);
    if (table !== undefined) tables.push(table);
  }
  return tables;
}

/** Reuse Turbopack's numeric-id/factory table shape, rather than a property's spelling alone. */
function factoriesOf(program: Node): Map<Node, string | null> {
  const factories = new Map<Node, string | null>();
  const tables = exportTables(program);
  for (let table = tables.pop(); table !== undefined; table = tables.pop()) {
    let hasId = false;
    for (const [index, element] of listOf(table, 'elements').entries()) {
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
      if (
        hasId &&
        (element.type === 'ArrowFunctionExpression' || element.type === 'FunctionExpression')
      ) {
        const context = listOf(element, 'params')[0];
        if (context !== undefined)
          factories.set(element, identifier(context) ? (context['name'] as string) : null);
      }
      hasId = false;
    }
  }
  return factories;
}

function visits(
  program: Node,
  imports: ReadonlyMap<Node, Origin>,
  factoryNames: ReadonlyMap<Node, string | null>,
): { visits: Visit[]; contexts: ReadonlyMap<Scope, string> } {
  const found: Visit[] = [];
  const contexts = new Map<Scope, string>();
  const pending: Visit[] = [{ node: program, parent: undefined, key: undefined, scopes: [] }];
  for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
    const scope = scopeOpenedBy(visit.node);
    const scopes = scope === undefined ? visit.scopes : [...visit.scopes, scope];
    if (scope !== undefined) {
      const context = factoryNames.get(visit.node);
      if (context !== undefined && context !== null) contexts.set(scope, context);
      if (visit.node === program) {
        for (const specifier of imports.keys()) {
          const local = specifier['local'];
          if (identifier(local)) {
            scope.declared.add(local['name'] as string);
            scope.bindings.set(local['name'] as string, specifier);
          }
        }
      }
    }
    found.push({ ...visit, scopes });
    for (const [key, child] of Object.entries(visit.node)) {
      if (key === 'parent') continue;
      for (const value of Array.isArray(child) ? child : [child]) {
        if (isNode(value)) pending.push({ node: value, parent: visit.node, key, scopes });
      }
    }
  }
  return { visits: found, contexts };
}

function isContext(
  node: unknown,
  scopes: readonly Scope[],
  contexts: ReadonlyMap<Scope, string>,
  seen = new Set<Node>(),
): boolean {
  if (!identifier(node) || seen.has(node)) return false;
  seen.add(node);
  const name = node['name'] as string;
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

function globalCompiler(node: Node, scopes: readonly Scope[]): boolean {
  if (identifier(node))
    return (
      ['eval', 'Function'].includes(node['name'] as string) &&
      bindingOf(node['name'] as string, scopes) === undefined
    );
  if (
    node.type !== 'MemberExpression' ||
    !identifier(node['object'], 'globalThis') ||
    bindingOf('globalThis', scopes) !== undefined
  )
    return false;
  return ['eval', 'Function'].includes(memberOf(node) ?? '');
}

/** A key or binding name is not a reference to the global or namespace it spells. */
function isReference({ parent, key }: Visit): boolean {
  if (parent === undefined) return true;
  if (parent.type.startsWith('Import')) return false;
  if (parent.type === 'VariableDeclarator' && key === 'id') return false;
  if (key === 'params' || (key === 'id' && parent.type.endsWith('Declaration'))) return false;
  if (
    (parent.type === 'MemberExpression' && key === 'property') ||
    ((parent.type === 'Property' || parent.type === 'MethodDefinition') && key === 'key')
  )
    return parent['computed'] === true;
  return true;
}

function namespaceEscapes(
  visit: Visit,
  imports: ReadonlyMap<Node, Origin>,
  builtin: 'child_process' | 'module',
): boolean {
  if (!['Identifier', 'CallExpression', 'MemberExpression'].includes(visit.node.type)) return false;
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
  return !(
    (visit.parent?.type === 'VariableDeclarator' && visit.key === 'init') ||
    (visit.parent?.type === 'MemberExpression' && visit.key === 'object')
  );
}

function destructuredMember(property: Node): string | undefined {
  if (property['computed'] === true) return stringOf(property['key']);
  const key = property['key'];
  return identifier(key) ? (key['name'] as string) : stringOf(key);
}

function destructuredLoader(
  node: Node,
  scopes: readonly Scope[],
  imports: ReadonlyMap<Node, Origin>,
): boolean {
  const pattern = node['id'];
  if (node.type !== 'VariableDeclarator' || !isNode(pattern) || pattern.type !== 'ObjectPattern')
    return false;
  const owner = originOf(node['init'], scopes, imports);
  if (owner === undefined) return false;
  return listOf(pattern, 'properties').some(
    (property) =>
      isNode(property) &&
      (property.type === 'RestElement' ||
        forbidden({ builtin: owner.builtin, member: destructuredMember(property) ?? '*' })),
  );
}

function contextLoader(visit: Visit, contexts: ReadonlyMap<Scope, string>): boolean {
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
  return listOf(pattern, 'properties').some(
    (property) =>
      isNode(property) &&
      (property.type === 'RestElement' ||
        destructuredMember(property) === 'y' ||
        destructuredMember(property) === undefined),
  );
}

function contextEscapes(visit: Visit, contexts: ReadonlyMap<Scope, string>): boolean {
  if (!isReference(visit) || !isContext(visit.node, visit.scopes, contexts)) return false;
  return !(
    (visit.parent?.type === 'VariableDeclarator' && visit.key === 'init') ||
    (visit.parent?.type === 'MemberExpression' && visit.key === 'object')
  );
}

function loaderRefusal(visit: Visit, imports: ReadonlyMap<Node, Origin>): string | undefined {
  const { node, scopes } = visit;
  if (isReference(visit) && globalCompiler(node, scopes))
    return 'an unproved JavaScript code compiler';
  if (
    (node.type === 'MemberExpression' && forbidden(originOf(node, scopes, imports))) ||
    destructuredLoader(node, scopes, imports)
  )
    return 'an unproved Node module loader or code compiler';
  if (
    node.type === 'ImportDeclaration' &&
    listOf(node, 'specifiers').some(
      (specifier) => isNode(specifier) && forbidden(imports.get(specifier)),
    )
  )
    return 'an unproved Node module loader or code compiler';
  if (node.type === 'ImportExpression' && builtinOf(stringOf(node['source'])) !== undefined)
    return 'an unproved dynamically imported Node loader namespace';
  if (
    (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
    builtinOf(stringOf(node['source'])) === 'child_process'
  )
    return 'an unproved Node child-process namespace escape';
  if (namespaceEscapes(visit, imports, 'module')) return 'an unproved Node Module namespace escape';
  if (namespaceEscapes(visit, imports, 'child_process'))
    return 'an unproved Node child-process namespace escape';
  return undefined;
}

/** Refuse executable closures the physical Node graph has not proved; never a Worker fallback. */
export function dynamicNodeClosureRefusal(file: string, code: string): string | undefined {
  const program: unknown = parseAst(code);
  if (!isNode(program)) throw new TypeError('Node closure proof requires a JavaScript program');
  const imports = importedOrigins(program);
  const factories = factoriesOf(program);
  const { visits: all, contexts } = visits(program, imports, factories);
  const serverChunk = /[/\\]server[/\\]chunks[/\\]/u.test(file);
  if (serverChunk && [...factories.values()].includes(null))
    return 'an unproved Turbopack factory context';
  for (const visit of all) {
    if (serverChunk && (contextLoader(visit, contexts) || contextEscapes(visit, contexts)))
      return 'an unproved Turbopack external import';
    const refusal = loaderRefusal(visit, imports);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}
