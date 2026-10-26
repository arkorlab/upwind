import type { Node as AstNode } from '@oxc-project/types';
import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node } from './lexical-scope.ts';
import { nativeBindings } from './native-ast.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  stringOf,
  visitTree,
} from './node-manifest-consumer-ast.ts';
import {
  projectNodeManifestTurbopackFactory,
  turbopackModuleId,
  turbopackModuleSpecifier,
  type NodeManifestTurbopackImport,
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
function exportValue(statement: unknown, module: string): Node | undefined {
  if (!isNode(statement) || statement.type !== 'ExpressionStatement') return undefined;
  const value = statement['expression'];
  return isNode(value) &&
    value.type === 'AssignmentExpression' &&
    value['operator'] === '=' &&
    member(value['left'], module, 'exports') &&
    isNode(value['right'])
    ? value['right']
    : undefined;
}
function soleAliasRead(factory: Node, variable: Node, exported: Node, name: string): boolean {
  const visits = visitTree(factory);
  const use = visits.find((visit) => visit.node === exported);
  if (
    use === undefined ||
    declaration(name, use.scopes)?.node !== variable ||
    !nativeBindings(factory as unknown as AstNode).unmodified(
      variable as unknown as AstNode,
      name,
      true,
    )
  )
    return false;
  for (const visit of visits)
    if (
      identifier(visit.node) &&
      visit.node.name === name &&
      reference(visit) &&
      declaration(name, visit.scopes)?.node === variable &&
      visit.node !== exported
    )
      return false;
  return true;
}
function aliasInitializer(
  factory: Node,
  statement: unknown,
  exported: Node,
  parameters: readonly string[],
): Node | undefined {
  // Evaluating module.exports after the call is not equivalent for a sloppy ordinary
  // function whose module parameter can be replaced through mapped arguments.
  if (
    factory.type !== 'ArrowFunctionExpression' ||
    factory['async'] === true ||
    !isNode(statement) ||
    statement.type !== 'VariableDeclaration' ||
    statement['kind'] !== 'var' ||
    listOf(statement, 'declarations').length !== 1 ||
    !identifier(exported)
  )
    return undefined;
  const variable = listOf(statement, 'declarations')[0];
  const local = isNode(variable) ? variable['id'] : undefined;
  const init = isNode(variable) ? variable['init'] : undefined;
  if (
    !isNode(variable) ||
    variable.type !== 'VariableDeclarator' ||
    !identifier(local) ||
    parameters.includes(local.name) ||
    exported.name !== local.name ||
    !isNode(init)
  )
    return undefined;
  return soleAliasRead(factory, variable, exported, local.name) ? init : undefined;
}
function assignment(
  node: Node,
): { readonly kind: 'external' | 'require'; readonly call: Node } | undefined {
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
  if (body.length !== 1 && body.length !== 2) return undefined;
  const value = exportValue(body.at(-1), module.name);
  if (value === undefined) return undefined;
  const call =
    body.length === 1
      ? value
      : aliasInitializer(
          node,
          body[0],
          value,
          params.map((param) => param.name),
        );
  if (!isNode(call) || call.type !== 'CallExpression' || call['optional'] === true)
    return undefined;
  if (member(call['callee'], context.name, 'x')) return { kind: 'external', call };
  return member(call['callee'], context.name, 'r') ? { kind: 'require', call } : undefined;
}

function forwardedImport(
  exported: NonNullable<ReturnType<typeof assignment>>,
): NodeManifestTurbopackImport | undefined {
  const args = listOf(exported.call, 'arguments');
  if (exported.kind === 'require') {
    const targetId = turbopackModuleId(args[0]);
    return targetId !== undefined && args.length === 1
      ? { kind: 'require', targetId, specifier: turbopackModuleSpecifier(targetId) }
      : undefined;
  }
  if (args.length !== EXTERNAL_ARGUMENTS && args.length !== EXTERNAL_INTEROP_ARGUMENTS)
    return undefined;
  const flag = args[2];
  if (
    args.length === EXTERNAL_INTEROP_ARGUMENTS &&
    (!isNode(flag) || flag.type !== 'Literal' || flag['value'] !== false)
  )
    return undefined;
  const specifier = stringOf(args[0]);
  return specifier === undefined ? undefined : { kind: 'external', specifier };
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
  const expected = forwardedImport(exported);
  if (expected === undefined) return undefined;
  // Recomputing from the selected original module checks SHA, registration ownership,
  // lexical CommonJS identities and the bound require or unshadowed external-require thunk.
  const checked = projectNodeManifestTurbopackFactory(projection.original, projection.moduleId);
  const imported = checked.imports[0];
  return checked.factory.start === projection.factory.start &&
    checked.factory.end === projection.factory.end &&
    checked.exports.kind === 'commonjs' &&
    checked.imports.length === 1 &&
    imported?.kind === expected.kind &&
    imported.specifier === expected.specifier &&
    imported.targetId === expected.targetId
    ? expected.specifier
    : undefined;
}
