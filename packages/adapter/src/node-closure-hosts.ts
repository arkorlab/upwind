import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';

type HostObject = 'global' | 'cjs-module';

function namedHost(name: unknown): HostObject | undefined {
  if (name === 'globalThis' || name === 'global') return 'global';
  return name === 'module' ? 'cjs-module' : undefined;
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

function memberName(value: Node): string | undefined {
  const property = value['property'];
  if (!isNode(property)) return undefined;
  const name = value['computed'] === true ? property['value'] : property['name'];
  if (typeof name === 'string') return name;
  if (property.type !== 'TemplateLiteral' || listOf(property, 'expressions').length !== 0)
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
  const member = memberName(value);
  if (owner === 'global') return namedHost(member);
  return owner === 'cjs-module' && member === 'parent' ? owner : undefined;
}

/** Only unshadowed host objects and their lexical aliases; ordinary objects stay ordinary. */
export function hostObjectOf(
  value: unknown,
  scopes: readonly Scope[],
  seen = new Set<Node>(),
): HostObject | undefined {
  if (!isNode(value) || seen.has(value)) return undefined;
  seen.add(value);
  if (value.type === 'Identifier') return aliasedHost(value, scopes, seen);
  if (value.type === 'VariableDeclarator') return hostObjectOf(value['init'], scopes, seen);
  if (value.type !== 'MemberExpression') return undefined;
  const owner = hostObjectOf(value['object'], scopes, seen);
  return hostMember(value, owner);
}
