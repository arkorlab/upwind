import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { NodeManifestAlpha } from './node-manifest-alpha.ts';
import {
  declaration,
  getterValue,
  identifier,
  propertyName,
  stringOf,
  swcHeader,
  visitTree,
} from './node-manifest-consumer-ast.ts';

const GETTER_PREFIX = '__upwind_turbopack_getter_';
const SWC_HELPER =
  'function _export(target,all){for(var name in all)Object.defineProperty(target,name,{enumerable:true,get:all[name]});}';
export interface ManifestTemplateExports {
  readonly body: readonly unknown[];
  readonly fields: ReadonlyMap<string, Node>;
}
function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js template exports ${reason}; refusing native publication`);
}
function programWith(program: Node, body: readonly unknown[]): Node {
  return { ...program, body };
}
function helperDeclaration(node: unknown, program: Node): node is Node {
  if (!isNode(node) || node.type !== 'FunctionDeclaration') return false;
  const expected: unknown = parseAst(SWC_HELPER);
  if (!isNode(expected)) return false;
  const actualView = new NodeManifestAlpha({
    original: programWith(program, [node]),
    body: [node],
  });
  const expectedView = new NodeManifestAlpha({
    original: expected,
    body: listOf(expected, 'body'),
  });
  return JSON.stringify(actualView.body()) === JSON.stringify(expectedView.body());
}
function deadAnnotation(node: unknown): boolean {
  if (!isNode(node) || node.type !== 'ExpressionStatement') return false;
  const logical = node['expression'];
  if (!isNode(logical) || logical.type !== 'LogicalExpression' || logical['operator'] !== '&&')
    return false;
  const left = logical['left'];
  const right = logical['right'];
  if (
    !isNode(left) ||
    left.type !== 'Literal' ||
    left['value'] !== 0 ||
    !isNode(right) ||
    right.type !== 'AssignmentExpression' ||
    right['operator'] !== '='
  )
    return false;
  const member = right['left'];
  const object = right['right'];
  if (
    !isNode(member) ||
    member.type !== 'MemberExpression' ||
    !identifier(member['object']) ||
    member['object'].name !== 'module' ||
    propertyName(member) !== 'exports' ||
    !isNode(object) ||
    object.type !== 'ObjectExpression'
  )
    return false;
  return listOf(object, 'properties').every((property) => {
    const value = isNode(property) ? property['value'] : undefined;
    return (
      isNode(property) &&
      property.type === 'Property' &&
      property['kind'] === 'init' &&
      property['computed'] !== true &&
      property['method'] !== true &&
      propertyName(property) !== undefined &&
      isNode(value) &&
      value.type === 'Literal' &&
      value['value'] === null
    );
  });
}
function add(fields: Map<string, Node>, name: string | undefined, value: unknown): void {
  if (name === undefined || fields.has(name) || !isNode(value))
    refuse('duplicate or opaque selector');
  fields.set(name, value);
}

function exportHelper(body: readonly unknown[], program: Node): Node {
  const helpers = body.filter((node) => helperDeclaration(node, program));
  const helper = helpers[0];
  if (helpers.length !== 1 || !isNode(helper) || !identifier(helper['id']))
    return refuse('helper identity');
  return helper;
}
function helperCall(
  statement: unknown,
  helper: Node,
  visits: ReadonlyMap<Node, ReturnType<typeof visitTree>[number]>,
): Node | undefined {
  if (!isNode(statement) || statement.type !== 'ExpressionStatement') return undefined;
  const expression = statement['expression'];
  if (
    !isNode(expression) ||
    expression.type !== 'CallExpression' ||
    !identifier(expression['callee'])
  )
    return undefined;
  const visit = visits.get(expression);
  if (visit === undefined || declaration(expression['callee'].name, visit.scopes)?.node !== helper)
    return undefined;
  return expression;
}
function helperSelectors(
  call: Node,
  visits: ReadonlyMap<Node, ReturnType<typeof visitTree>[number]>,
  fields: Map<string, Node>,
): void {
  const args = listOf(call, 'arguments');
  const target = args[0];
  const values = args[1];
  const visit = visits.get(call);
  if (
    visit === undefined ||
    args.length !== 2 ||
    !identifier(target) ||
    target.name !== 'exports' ||
    declaration('exports', visit.scopes) !== undefined ||
    !isNode(values) ||
    values.type !== 'ObjectExpression'
  )
    return refuse('helper call');
  for (const property of listOf(values, 'properties')) {
    const fn = isNode(property) ? property['value'] : undefined;
    if (!isNode(fn) || (fn['id'] !== null && fn['id'] !== undefined)) refuse('named getter scope');
    add(fields, isNode(property) ? propertyName(property) : undefined, getterValue(property));
  }
}
function header(statement: unknown): boolean {
  return (
    isNode(statement) &&
    statement.type === 'ExpressionStatement' &&
    isNode(statement['expression']) &&
    swcHeader(statement['expression'])
  );
}
/** Remove only the reviewed, binding-bound SWC export scaffold from the inert template view. */
export function swcTemplateExports(program: Node): ManifestTemplateExports {
  const body = listOf(program, 'body');
  const helper = exportHelper(body, program);
  const visits = new Map(visitTree(program).map((visit) => [visit.node, visit]));
  const fields = new Map<string, Node>();
  const kept: unknown[] = [];
  let calls = 0;
  for (const statement of body) {
    if (statement === helper || deadAnnotation(statement) || header(statement)) continue;
    const call = helperCall(statement, helper, visits);
    if (call === undefined) kept.push(statement);
    else {
      helperSelectors(call, visits, fields);
      calls += 1;
    }
  }
  if (calls !== 1 || fields.size === 0) return refuse('helper invocation count');
  return { body: kept, fields };
}
function noOp(node: unknown): boolean {
  if (!isNode(node) || node.type !== 'ExpressionStatement') return false;
  const unary = node['expression'];
  const value = isNode(unary) ? unary['argument'] : undefined;
  return (
    isNode(unary) &&
    unary.type === 'UnaryExpression' &&
    unary['operator'] === 'void' &&
    isNode(value) &&
    value.type === 'Literal' &&
    value['value'] === 0
  );
}
function projectedSelector(
  statement: unknown,
  next: unknown,
): { readonly name: string | undefined; readonly value: unknown } | undefined {
  const declarations =
    isNode(statement) && statement.type === 'VariableDeclaration'
      ? listOf(statement, 'declarations')
      : [];
  const variable = declarations[0];
  const local = isNode(variable) ? variable['id'] : undefined;
  if (!identifier(local) || !local.name.startsWith(GETTER_PREFIX)) return undefined;
  const specifiers =
    isNode(next) && next.type === 'ExportNamedDeclaration' ? listOf(next, 'specifiers') : [];
  const exported = specifiers[0];
  if (
    !isNode(statement) ||
    !isNode(next) ||
    declarations.length !== 1 ||
    statement['kind'] !== 'const' ||
    (next['source'] !== null && next['source'] !== undefined) ||
    specifiers.length !== 1 ||
    !isNode(exported) ||
    !identifier(exported['local']) ||
    exported['local'].name !== local.name
  )
    return refuse('projected selector declaration');
  const name = identifier(exported['exported'])
    ? exported['exported'].name
    : stringOf(exported['exported']);
  return { name, value: isNode(variable) ? variable['init'] : undefined };
}
/** Only selectors emitted by the recomputed Turbopack projector may use this scaffold. */
export function projectedTemplateExports(program: Node): ManifestTemplateExports {
  const body = listOf(program, 'body');
  const fields = new Map<string, Node>();
  const kept: unknown[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const statement = body[index];
    if (noOp(statement)) continue;
    const selected = projectedSelector(statement, body[index + 1]);
    if (selected === undefined) kept.push(statement);
    else {
      add(fields, selected.name, selected.value);
      index += 1;
    }
  }
  if (fields.size === 0) return refuse('missing projected exports');
  return { body: kept, fields };
}
