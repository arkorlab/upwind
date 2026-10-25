import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';

const COMMON_JS_HOST = 'cjs-module';
type HostObject = 'global' | typeof COMMON_JS_HOST;

function namedHost(name: unknown): HostObject | undefined {
  if (name === 'globalThis' || name === 'global') return 'global';
  return name === 'module' ? COMMON_JS_HOST : undefined;
}

function aliasedHost(
  value: Node,
  scopes: readonly Scope[],
  seen: Set<Node>,
): HostObject | undefined {
  const name = value['name'];
  if (typeof name !== 'string') return undefined;
  for (let at = scopes.length - 1; at >= 0; at -= 1) {
    const scope = scopes[at];
    if (scope?.declared.has(name) === true)
      return hostObjectOf(scope.bindings.get(name), scopes.slice(0, at + 1), seen);
  }
  return namedHost(name);
}

export function hostPropertyName(value: Node): string | undefined {
  const property = value['property'] ?? value['key'];
  if (!isNode(property)) return undefined;
  const name =
    value['computed'] !== true && property.type === 'Identifier'
      ? property['name']
      : property['value'];
  if (typeof name === 'string') return name;
  if (property.type !== 'TemplateLiteral' || listOf(property, 'expressions').length > 0)
    return undefined;
  const first = listOf(property, 'quasis')[0];
  const data = isNode(first) ? first['value'] : undefined;
  return typeof data === 'object' &&
    data !== null &&
    'cooked' in data &&
    typeof data.cooked === 'string'
    ? data.cooked
    : undefined;
}

function hostMember(value: Node, owner: HostObject | undefined): HostObject | undefined {
  const member = hostPropertyName(value);
  if (owner === 'global') return namedHost(member);
  return owner === COMMON_JS_HOST && member === 'parent' ? owner : undefined;
}

/** Only unshadowed host objects and their lexical aliases; ordinary objects stay ordinary. */
export function hostObjectOf(
  value: unknown,
  scopes: readonly Scope[],
  seen = new Set<Node>(),
): HostObject | undefined {
  let current = value;
  while (isNode(current) && !seen.has(current)) {
    seen.add(current);
    if (current.type === 'VariableDeclarator') {
      current = current['init'];
      continue;
    }
    if (current.type === 'Identifier') return aliasedHost(current, scopes, seen);
    if (current.type !== 'MemberExpression') return undefined;
    const owner = hostObjectOf(current['object'], scopes, seen);
    return hostMember(current, owner);
  }
  return undefined;
}

export function isCommonJsHost(value: unknown, scopes: readonly Scope[]): boolean {
  return hostObjectOf(value, scopes) === COMMON_JS_HOST;
}
