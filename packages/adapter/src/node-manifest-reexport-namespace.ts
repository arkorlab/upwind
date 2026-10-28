import type { Node as AstNode } from '@oxc-project/types';

import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { nativeBindings } from './native-ast.ts';
import { declaration, identifier, propertyName, type Visit } from './node-manifest-consumer-ast.ts';
import { turbopackModuleId } from './node-manifest-turbopack-values.ts';
import type { NodeManifestTurbopackModuleId } from './node-manifest-turbopack.ts';

export interface NamespaceReexportInput {
  readonly factory: Node;
  readonly body: Node;
  readonly parents: ReadonlyMap<Node, Visit>;
  readonly context: { readonly name: string; readonly scope: Scope };
}

function namespaceCall(initial: unknown, input: NamespaceReexportInput): Node | undefined {
  if (!isNode(initial) || initial.type !== 'CallExpression' || initial['optional'] === true)
    return undefined;
  const member = initial['callee'];
  if (
    !isNode(member) ||
    member.type !== 'MemberExpression' ||
    member['computed'] === true ||
    member['optional'] === true ||
    propertyName(member) !== 'i'
  )
    return undefined;
  const receiver = member['object'];
  const scopes = input.parents.get(member)?.scopes;
  if (scopes === undefined || !identifier(receiver) || receiver.name !== input.context.name)
    return undefined;
  const scope = scopes.findLast((candidate) => candidate.declared.has(receiver.name));
  return scope === input.context.scope && !scope.bindings.has(receiver.name) ? initial : undefined;
}

/** Fixed runtime-utils.ts (5e93b55b) esmReexport accepts an already imported namespace. */
export function reexportNamespaceId(
  head: unknown,
  input: NamespaceReexportInput,
): NodeManifestTurbopackModuleId | undefined {
  if (!identifier(head)) return undefined;
  const visit = input.parents.get(head);
  const bound = visit === undefined ? undefined : declaration(head.name, visit.scopes)?.node;
  const statement = bound === undefined ? undefined : input.parents.get(bound)?.parent;
  if (
    bound?.type !== 'VariableDeclarator' ||
    !identifier(bound['id']) ||
    statement?.type !== 'VariableDeclaration' ||
    input.parents.get(statement)?.parent !== input.body
  )
    return undefined;
  const call = namespaceCall(bound['init'], input);
  if (call === undefined || call.end >= head.start) return undefined;
  const args = listOf(call, 'arguments');
  const id = turbopackModuleId(args[0]);
  if (
    id === undefined ||
    args.length !== 1 ||
    !nativeBindings(input.factory as unknown as AstNode).unmodified(head, head.name, true)
  )
    return undefined;
  return id;
}
