import { isNode, listOf, type Node } from './lexical-scope.ts';
import { identifier, propertyName, stringOf } from './node-manifest-consumer-ast.ts';
import {
  turbopackModuleId,
  turbopackModuleSpecifier,
  type NodeManifestTurbopackImport,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

interface Forwarded {
  readonly imported: NodeManifestTurbopackImport;
  readonly interop: boolean;
}
interface Parameters {
  readonly context: string;
  readonly module: string | undefined;
  readonly names: readonly string[];
}
const COMMONJS_PARAMETERS = 3;
const EXTERNAL_ARGUMENTS = 2;
const EXTERNAL_INTEROP_ARGUMENTS = 3;
function member(value: unknown, name: string, property: string): boolean {
  return (
    isNode(value) &&
    value.type === 'MemberExpression' &&
    value['optional'] !== true &&
    value['computed'] !== true &&
    identifier(value['object']) &&
    value['object'].name === name &&
    propertyName(value) === property
  );
}
function factoryBody(factory: Node): readonly unknown[] {
  const body = factory['body'];
  if (!isNode(body) || body.type !== 'BlockStatement') return [];
  const bodyStatements = listOf(body, 'body');
  const first = bodyStatements[0];
  const directive = isNode(first) ? first['expression'] : undefined;
  const strict =
    isNode(first) &&
    first.type === 'ExpressionStatement' &&
    isNode(directive) &&
    directive.type === 'Literal' &&
    directive.start === first.start &&
    (directive['raw'] === '"use strict"' || directive['raw'] === "'use strict'");
  return strict ? bodyStatements.slice(1) : bodyStatements;
}
function statementExpression(value: unknown): Node | undefined {
  return isNode(value) && value.type === 'ExpressionStatement' && isNode(value['expression'])
    ? value['expression']
    : undefined;
}
function named(value: Node): boolean {
  return value['id'] !== undefined && value['id'] !== null;
}
function literalRequire(value: unknown, specifier: string): boolean {
  if (
    !isNode(value) ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type) ||
    value['async'] === true ||
    value['generator'] === true ||
    named(value) ||
    listOf(value, 'params').length > 0
  )
    return false;
  let call = value['body'];
  if (isNode(call) && call.type === 'BlockStatement') {
    const bodyStatements = listOf(call, 'body');
    const only = bodyStatements[0];
    if (bodyStatements.length !== 1 || !isNode(only) || only.type !== 'ReturnStatement')
      return false;
    call = only['argument'];
  }
  return (
    isNode(call) &&
    call.type === 'CallExpression' &&
    call['optional'] !== true &&
    identifier(call['callee']) &&
    call['callee'].name === 'require' &&
    listOf(call, 'arguments').length === 1 &&
    stringOf(listOf(call, 'arguments')[0]) === specifier
  );
}
function imported(value: unknown, context: string, commonjsOnly: boolean): Forwarded | undefined {
  if (!isNode(value) || value.type !== 'CallExpression' || value['optional'] === true)
    return undefined;
  const args = listOf(value, 'arguments');
  const methods = commonjsOnly ? ['r'] : ['i', 'r'];
  for (const method of methods) {
    if (!member(value['callee'], context, method)) continue;
    const id = turbopackModuleId(args[0]);
    if (id === undefined || args.length !== 1) return undefined;
    return {
      imported: {
        kind: method === 'i' ? 'import' : 'require',
        targetId: id,
        specifier: turbopackModuleSpecifier(id),
      },
      interop: false,
    };
  }
  if (
    !member(value['callee'], context, 'x') ||
    (args.length !== EXTERNAL_ARGUMENTS && args.length !== EXTERNAL_INTEROP_ARGUMENTS)
  )
    return undefined;
  const specifier = stringOf(args[0]);
  const flag = args[2];
  if (
    specifier === undefined ||
    !literalRequire(args[1], specifier) ||
    (args.length === EXTERNAL_INTEROP_ARGUMENTS &&
      (!isNode(flag) || flag.type !== 'Literal' || typeof flag['value'] !== 'boolean'))
  )
    return undefined;
  return {
    imported: { kind: 'external', specifier },
    interop: isNode(flag) && flag['value'] === true,
  };
}
function commonjs(
  body: readonly unknown[],
  context: string,
  module: string,
): Forwarded | undefined {
  const assignment = statementExpression(body[0]);
  if (
    body.length !== 1 ||
    assignment?.type !== 'AssignmentExpression' ||
    assignment['operator'] !== '=' ||
    !member(assignment['left'], module, 'exports')
  )
    return undefined;
  return imported(assignment['right'], context, true);
}
function namespace(
  body: readonly unknown[],
  params: Parameters,
): { readonly target: Forwarded; readonly method: string } | undefined {
  const declaration = body[0];
  const call = statementExpression(body[1]);
  if (
    body.length !== 2 ||
    !isNode(declaration) ||
    declaration.type !== 'VariableDeclaration' ||
    listOf(declaration, 'declarations').length !== 1 ||
    call?.type !== 'CallExpression' ||
    call['optional'] === true ||
    listOf(call, 'arguments').length !== 1
  )
    return undefined;
  const variable = listOf(declaration, 'declarations')[0];
  const value = listOf(call, 'arguments')[0];
  if (
    !isNode(variable) ||
    variable.type !== 'VariableDeclarator' ||
    !identifier(variable['id']) ||
    !identifier(value) ||
    value.name !== variable['id'].name ||
    params.names.includes(value.name)
  )
    return undefined;
  const method = ['n', 'v'].find((candidate) => member(call['callee'], params.context, candidate));
  const target = imported(variable['init'], params.context, false);
  return method === undefined || target === undefined ? undefined : { target, method };
}

function parameters(factory: Node): Parameters | undefined {
  const params = listOf(factory, 'params');
  if (
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(factory.type) ||
    factory['async'] === true ||
    factory['generator'] === true ||
    named(factory) ||
    (params.length !== 1 && params.length !== COMMONJS_PARAMETERS) ||
    !params.every(identifier) ||
    new Set(params.map((param) => param.name)).size !== params.length ||
    params.some((param) => param.name === 'require')
  )
    return undefined;
  const names = params.map((param) => param.name);
  const context = names[0];
  return context === undefined ? undefined : { context, module: names[1], names };
}
function isolated(factory: Node, projection: NodeManifestTurbopackProjection): boolean {
  return (
    factory.start === projection.factory.start &&
    factory.end === projection.factory.end &&
    projection.mode === 'dependencies' &&
    projection.imports.length === 1 &&
    projection.cacheInitializers.length === 0 &&
    projection.boundRuntimeInputs.length === 0 &&
    projection.asyncLoads.length === 0 &&
    projection.asyncLoader === undefined
  );
}

/** A finite raw-body classification, not arbitrary alpha or directive-stripping equivalence. */
export function nodeManifestRegistrationForwarder(
  factory: Node,
  projection: NodeManifestTurbopackProjection,
): string | undefined {
  const params = parameters(factory);
  if (params === undefined || !isolated(factory, projection)) return undefined;
  const body = factoryBody(factory);
  const direct =
    params.module !== undefined && projection.exports.kind === 'commonjs'
      ? commonjs(body, params.context, params.module)
      : undefined;
  const forwarded = projection.exports.kind === 'namespace' ? namespace(body, params) : undefined;
  const target = direct ?? forwarded?.target;
  const actual = projection.imports[0];
  if (
    target === undefined ||
    actual?.kind !== target.imported.kind ||
    actual.specifier !== target.imported.specifier ||
    actual.targetId !== target.imported.targetId
  )
    return undefined;
  return JSON.stringify([direct === undefined ? forwarded?.method : 'commonjs', target]);
}
