import type { Node } from '@oxc-project/types';

import { identifier, type NativeBindings, required, stringOf } from './native-ast.ts';

const MODIFIED_NAMESPACE = 'modified-namespace';
type ProcessOrigin = 'namespace' | typeof MODIFIED_NAMESPACE | 'dlopen' | 'ambiguous';

function processModule(specifier = ''): boolean {
  return ['node:process', 'process'].includes(specifier);
}

function propertyName(node: Extract<Node, { type: 'MemberExpression' }>): string | undefined {
  if (node.computed) return stringOf(node.property);
  return node.property.type === 'Identifier' ? node.property.name : undefined;
}

function destructuredKey(node: Extract<Node, { type: 'Property' }>): string | undefined {
  if (node.computed) return stringOf(node.key);
  return node.key.type === 'Identifier' ? node.key.name : stringOf(node.key);
}

function importedOrigin(node: Node, bindings: NativeBindings): ProcessOrigin | undefined {
  if (!processModule(bindings.importSource(node))) return undefined;
  if (node.type === 'ImportNamespaceSpecifier' || node.type === 'ImportDefaultSpecifier')
    return 'namespace';
  if (node.type !== 'ImportSpecifier') return undefined;
  const name = node.imported.type === 'Identifier' ? node.imported.name : stringOf(node.imported);
  if (name === 'default') return 'namespace';
  return name === 'dlopen' ? 'dlopen' : undefined;
}

function destructuredOrigin(pattern: Node, name: string): ProcessOrigin | undefined {
  if (pattern.type !== 'ObjectPattern') return undefined;
  for (const property of pattern.properties) {
    if (property.type !== 'Property') continue;
    const value =
      property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
    if (!identifier(value, name)) continue;
    const key = destructuredKey(property);
    if (key === undefined) return 'ambiguous';
    return key === 'dlopen' ? 'dlopen' : undefined;
  }
  return undefined;
}

function declaredOrigin(
  declaration: Node,
  name: string,
  bindings: NativeBindings,
  seen: ReadonlySet<Node>,
): ProcessOrigin | undefined {
  const imported = importedOrigin(declaration, bindings);
  if (imported !== undefined) return imported;
  if (declaration.type !== 'VariableDeclarator' || declaration.init === null) return undefined;
  const origin = processOrigin(declaration.init, bindings, seen);
  if (origin === 'ambiguous' || declaration.id.type === 'Identifier') return origin;
  if (origin !== 'namespace' && origin !== MODIFIED_NAMESPACE) return undefined;
  const member = destructuredOrigin(declaration.id, name);
  return origin === MODIFIED_NAMESPACE && member !== undefined ? 'ambiguous' : member;
}

function identifierOrigin(
  node: Extract<Node, { type: 'Identifier' }>,
  bindings: NativeBindings,
  seen: ReadonlySet<Node>,
): ProcessOrigin | undefined {
  const declaration = bindings.lookup(node, node.name);
  if (declaration === null) return undefined;
  let origin: ProcessOrigin | undefined;
  if (declaration === undefined) {
    if (node.name !== 'process') return undefined;
    origin = 'namespace';
  } else {
    origin = declaredOrigin(declaration, node.name, bindings, seen);
  }
  if (origin === undefined) return undefined;
  if (bindings.unmodified(node, node.name, true)) return origin;
  return origin === 'namespace' || origin === MODIFIED_NAMESPACE ? MODIFIED_NAMESPACE : 'ambiguous';
}

function memberOrigin(
  node: Extract<Node, { type: 'MemberExpression' }>,
  bindings: NativeBindings,
  seen: ReadonlySet<Node>,
): ProcessOrigin | undefined {
  const origin = processOrigin(node.object, bindings, seen);
  if (origin === 'ambiguous' || origin === 'dlopen') return 'ambiguous';
  if (origin !== 'namespace' && origin !== MODIFIED_NAMESPACE) return undefined;
  const name = propertyName(node);
  if (name === undefined) return 'ambiguous';
  if (name !== 'dlopen') return undefined;
  return origin === MODIFIED_NAMESPACE ? 'ambiguous' : 'dlopen';
}

function processOrigin(
  node: Node,
  bindings: NativeBindings,
  seen: ReadonlySet<Node> = new Set(),
): ProcessOrigin | undefined {
  if (seen.has(node)) return undefined;
  const next = new Set([...seen, node]);
  if (node.type === 'Identifier') return identifierOrigin(node, bindings, next);
  if (node.type === 'MemberExpression') return memberOrigin(node, bindings, next);
  if (!processModule(required(node))) return undefined;
  if (bindings.lookup(node, 'require') !== undefined) return undefined;
  return bindings.unmodified(node, 'require', false) ? 'namespace' : MODIFIED_NAMESPACE;
}

/** Only genuine Node process origins qualify; ambiguous aliases must fail after retention. */
export function processDlopen(
  callee: Node,
  bindings: NativeBindings,
): 'known' | 'ambiguous' | undefined {
  const origin = processOrigin(callee, bindings);
  if (origin === 'dlopen') return 'known';
  return origin === 'ambiguous' ? 'ambiguous' : undefined;
}
