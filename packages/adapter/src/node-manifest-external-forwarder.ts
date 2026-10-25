import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node } from './lexical-scope.ts';
import { identifier, propertyName, stringOf, visitTree } from './node-manifest-consumer-ast.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

const COMMONJS_PARAMETERS = 3;
const EXTERNAL_ARGUMENTS = 2;
const EXTERNAL_INTEROP_ARGUMENTS = 3;

function member(value: unknown, object: string, property: string): boolean {
  return (
    isNode(value) &&
    value.type === 'MemberExpression' &&
    value['optional'] !== true &&
    value['computed'] !== true &&
    identifier(value['object']) &&
    value['object'].name === object &&
    propertyName(value) === property
  );
}
function strictDirective(value: unknown): boolean {
  if (!isNode(value) || value.type !== 'ExpressionStatement') return false;
  const expression = value['expression'];
  return (
    isNode(expression) &&
    expression.type === 'Literal' &&
    expression.start === value.start &&
    (expression['raw'] === '"use strict"' || expression['raw'] === "'use strict'")
  );
}
function assignment(node: Node): { readonly context: string; readonly call: Node } | undefined {
  const params = listOf(node, 'params');
  if (
    params.length !== COMMONJS_PARAMETERS ||
    !params.every(identifier) ||
    new Set(params.map((param) => param.name)).size !== COMMONJS_PARAMETERS
  )
    return undefined;
  const context = params[0];
  const module = params[1];
  if (context === undefined || module === undefined || !isNode(node['body'])) return undefined;
  const statements = listOf(node['body'], 'body');
  const body = strictDirective(statements[0]) ? statements.slice(1) : statements;
  const only = body[0];
  if (body.length !== 1 || !isNode(only) || only.type !== 'ExpressionStatement') return undefined;
  const value = only['expression'];
  if (
    !isNode(value) ||
    value.type !== 'AssignmentExpression' ||
    value['operator'] !== '=' ||
    !member(value['left'], module.name, 'exports')
  )
    return undefined;
  const call = value['right'];
  return isNode(call) &&
    call.type === 'CallExpression' &&
    call['optional'] !== true &&
    member(call['callee'], context.name, 'x')
    ? { context: context.name, call }
    : undefined;
}

/** Identity-only classification. The actual resolved producer and all callers still need proof. */
export function directExternalNamespace(
  projection: NodeManifestTurbopackProjection,
): string | undefined {
  if (projection.exports.kind !== 'commonjs') return undefined;
  const program: unknown = parseAst(projection.original.code);
  if (!isNode(program)) return undefined;
  const node = visitTree(program).find((visit) => {
    return (
      visit.node.start === projection.factory.start &&
      visit.node.end === projection.factory.end &&
      ['ArrowFunctionExpression', 'FunctionExpression'].includes(visit.node.type)
    );
  })?.node;
  if (node === undefined) return undefined;
  const exported = assignment(node);
  if (exported === undefined) return undefined;
  const args = listOf(exported.call, 'arguments');
  if (args.length !== EXTERNAL_ARGUMENTS && args.length !== EXTERNAL_INTEROP_ARGUMENTS)
    return undefined;
  const flag = args[2];
  if (
    args.length === EXTERNAL_INTEROP_ARGUMENTS &&
    (!isNode(flag) || flag.type !== 'Literal' || flag['value'] !== false)
  )
    return undefined;
  const specifier = stringOf(args[0]);
  if (specifier === undefined) return undefined;
  // Recomputing from the selected original module checks SHA, registration ownership,
  // lexical CommonJS identities and the exact unshadowed external-require thunk.
  const checked = projectNodeManifestTurbopackFactory(projection.original, projection.moduleId);
  const imported = checked.imports[0];
  return checked.factory.start === projection.factory.start &&
    checked.factory.end === projection.factory.end &&
    checked.exports.kind === 'commonjs' &&
    checked.imports.length === 1 &&
    imported?.kind === 'external' &&
    imported.specifier === specifier
    ? specifier
    : undefined;
}
