import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { NodeManifestAlpha } from './node-manifest-alpha.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  stringOf,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import type { NodeManifestTurbopackGraphFactory } from './node-manifest-turbopack-graph.ts';
import { defaultExportTarget, exportBindings } from './node-manifest-turbopack-values.ts';
import { projectNodeManifestTurbopackFactory } from './node-manifest-turbopack.ts';

// next@16.4.3 helpers.js SHA256 b9dd74a9ba684af8c21a7204d79c63f08683e22cf5e49d4e133ab5e2d9149b03.
// Only its function body is an inspection profile; no physical module identity is invented.
const HOIST = `function hoist(module,name){
  if(name in module){return module[name];}
  if('then' in module && typeof module.then === 'function'){
    return module.then((mod)=>hoist(mod,name));
  }
  if(typeof module === 'function' && name === 'default'){return module;}
  return undefined;
}`;
// The same ordered direct-return branches, compressed into one conditional return.
const CONDITIONAL_HOIST = `function hoist(module,name){
  return name in module ? module[name] :
    'then' in module && typeof module.then === 'function' ?
      module.then((mod)=>hoist(mod,name)) :
      typeof module === 'function' && name === 'default' ? module : undefined;
}`;
const BRAND: unique symbol = Symbol('node-manifest-hoist');
const EXPORT_METHODS: ReadonlySet<string> = new Set(['n', 's', 'v']);
const MAX_EXPORT_ARGUMENTS = 3;
export interface NodeManifestHoistProof {
  readonly [BRAND]: true;
}
export interface NodeManifestHoistInput {
  /** Actual per-build consumer identity, not a serialized scope hash. */
  readonly owner: { readonly identity: symbol };
  readonly factory: NodeManifestTurbopackGraphFactory;
  /** The actual registered namespace property selected by the importing source. */
  readonly exportName: string;
}
interface Original {
  readonly program: Node;
  readonly factory: Node;
  readonly body: Node;
  readonly context: string;
  readonly scope: Scope;
  readonly visits: readonly Visit[];
  readonly parents: ReadonlyMap<Node, Visit>;
}
interface SelectedFunction {
  readonly fn: Node;
  readonly selector: Node;
  readonly inline: boolean;
}
interface Certificate {
  readonly owner: NodeManifestHoistInput['owner'];
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly projection: NodeManifestTurbopackGraphFactory['projection'];
  readonly original: NodeManifestTurbopackGraphFactory['projection']['original'];
  readonly fingerprint: string;
}
const CERTIFIED = new WeakMap<NodeManifestHoistProof, Certificate>();

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js hoist helper ${reason}; refusing native publication`);
}
function fingerprint(input: NodeManifestHoistInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.factory, input.exportName]))
    .digest('hex');
}
function bindingScope(name: string, scopes: readonly Scope[]): Scope | undefined {
  return scopes.findLast((scope) => scope.declared.has(name));
}
function strict(statement: unknown): boolean {
  if (!isNode(statement) || statement.type !== 'ExpressionStatement') return false;
  const expression = statement['expression'];
  return (
    isNode(expression) &&
    expression.type === 'Literal' &&
    expression.start === statement.start &&
    (expression['raw'] === '"use strict"' || expression['raw'] === "'use strict'")
  );
}
function originalOf(input: NodeManifestHoistInput): Original {
  const projection = input.factory.projection;
  const checked = projectNodeManifestTurbopackFactory(
    projection.original,
    projection.moduleId,
    projection.mode,
  );
  if (JSON.stringify(checked) !== JSON.stringify(projection)) refuse('projection binding');
  const parsed: unknown = parseAst(projection.original.code);
  if (!isNode(parsed)) return refuse('original parser');
  const all = visitTree(parsed);
  const found = all.find(
    ({ node }) => node.start === checked.factory.start && node.end === checked.factory.end,
  );
  const factory = found?.node;
  const body = factory?.['body'];
  const context = factory === undefined ? undefined : listOf(factory, 'params')[0];
  const scope = found?.scopes.at(-1);
  if (factory === undefined || scope === undefined || !isNode(body) || !identifier(context))
    return refuse('original factory');
  if (!checked.factory.ids.includes(checked.moduleId)) refuse('unregistered selected helper');
  return {
    program: parsed,
    factory,
    body,
    context: context.name,
    scope,
    parents: new Map(all.map((visit) => [visit.node, visit])),
    visits: all.filter(({ node }) => node.start >= factory.start && node.end <= factory.end),
  };
}
function contextExport(visit: Visit, original: Original): Node | undefined {
  const call = visit.node;
  const callee = call['callee'];
  if (
    call.type !== 'CallExpression' ||
    call['optional'] === true ||
    !isNode(callee) ||
    callee.type !== 'MemberExpression' ||
    callee['optional'] === true ||
    !identifier(callee['object']) ||
    callee['object'].name !== original.context ||
    bindingScope(original.context, visit.scopes) !== original.scope ||
    !EXPORT_METHODS.has(propertyName(callee) ?? '')
  )
    return undefined;
  return call;
}
function selectedExportTarget(call: Node, visit: Visit, input: NodeManifestHoistInput): boolean {
  const args = listOf(call, 'arguments');
  const target = args[1];
  if (defaultExportTarget(target, visit)) return true;
  return (
    isNode(target) &&
    target.type === 'Literal' &&
    target['value'] === input.factory.projection.moduleId
  );
}
function standalone(call: Node, original: Original): void {
  let value = call;
  let statement = original.parents.get(value)?.parent;
  while (
    statement?.type === 'SequenceExpression' &&
    listOf(statement, 'expressions').includes(value)
  ) {
    value = statement;
    statement = original.parents.get(value)?.parent;
  }
  if (
    statement?.type !== 'ExpressionStatement' ||
    statement['expression'] !== value ||
    original.parents.get(statement)?.parent !== original.body
  )
    refuse('conditional or effectful export registration');
}
function inlineFunction(table: unknown, exportName: string): Node | undefined {
  if (!isNode(table) || table.type !== 'ArrayExpression') return undefined;
  const entries = listOf(table, 'elements');
  const tag = entries[1];
  const value = entries[2];
  return entries.length === MAX_EXPORT_ARGUMENTS &&
    stringOf(entries[0]) === exportName &&
    isNode(tag) &&
    tag.type === 'Literal' &&
    tag['value'] === 0 &&
    isNode(value) &&
    value.type === 'FunctionExpression' &&
    identifier(value['id'])
    ? value
    : undefined;
}
function registrationArguments(call: Node): readonly unknown[] {
  const callee = call['callee'];
  const args = listOf(call, 'arguments');
  if (!isNode(callee) || propertyName(callee) !== 's') refuse('selected namespace registration');
  const flag = args[2];
  if (
    args.length > MAX_EXPORT_ARGUMENTS ||
    (flag !== undefined && (!isNode(flag) || flag.type !== 'Literal' || flag['value'] !== false))
  )
    refuse('dynamic namespace');
  return args;
}
function exportedFunction(input: NodeManifestHoistInput, original: Original): SelectedFunction {
  const exports = original.visits.filter((visit) => {
    const call = contextExport(visit, original);
    return call !== undefined && selectedExportTarget(call, visit, input);
  });
  const registration = exports[0];
  if (registration === undefined || exports.length !== 1) return refuse('selected export count');
  const call = registration.node;
  const args = registrationArguments(call);
  standalone(call, original);
  const inline = inlineFunction(args[0], input.exportName);
  if (inline !== undefined) return { fn: inline, selector: inline, inline: true };
  const bindings = exportBindings(args[0]);
  const only = bindings[0];
  if (bindings.length !== 1 || only?.name !== input.exportName || !identifier(only.value))
    return refuse('actual export member');
  const visit = original.parents.get(only.value);
  const fn = visit === undefined ? undefined : declaration(only.value.name, visit.scopes)?.node;
  if (fn?.type !== 'FunctionDeclaration' || original.parents.get(fn)?.parent !== original.body)
    return refuse('helper declaration binding');
  return { fn, selector: only.value, inline: false };
}
function assertStrict(fn: Node, original: Original): void {
  let ancestor: Node | undefined = fn;
  while (ancestor !== undefined) {
    const body = ancestor['body'];
    if (
      (ancestor.type === 'Program' && strict(listOf(ancestor, 'body')[0])) ||
      (['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(
        ancestor.type,
      ) &&
        isNode(body) &&
        strict(listOf(body, 'body')[0]))
    )
      return;
    ancestor = original.parents.get(ancestor)?.parent;
  }
  refuse('original helper strictness');
}
function helperScopeOffset(fn: Node, original: Original): number {
  const found = original.parents.get(fn);
  if (found?.scopes.at(-1) === undefined) return refuse('helper scope');
  return found.scopes.length - 1;
}
function assertCaptures(fn: Node, original: Original): void {
  const offset = helperScopeOffset(fn, original);
  for (const visit of original.visits) {
    const { node } = visit;
    if (node.start < fn.start || node.end > fn.end || !identifier(node) || !reference(visit))
      continue;
    const bound = bindingScope(node.name, visit.scopes);
    if (bound !== undefined && node.name === 'undefined') refuse('shadowed undefined');
    if (bound === undefined && node.name === 'undefined') continue;
    if (bound !== undefined && visit.scopes.slice(offset).includes(bound)) continue;
    if (declaration(node.name, visit.scopes)?.node === fn) continue;
    refuse('unclosed lexical capture');
  }
}
function outerCommonJs(visit: Visit, original: Original): boolean {
  const { node } = visit;
  if (!identifier(node) || !reference(visit)) return false;
  const bound = bindingScope(node.name, visit.scopes);
  const commonJs = listOf(original.factory, 'params').slice(1).filter(identifier);
  return (
    (bound === original.scope && commonJs.some((param) => param.name === node.name)) ||
    (bound === undefined && ['exports', 'module'].includes(node.name))
  );
}
function allowedHelperReference(visit: Visit, fn: Node, selector: Node): boolean {
  const { node } = visit;
  return (
    node === fn['id'] ||
    node === selector ||
    (node.start >= fn.start && node.end <= fn.end && reference(visit))
  );
}
function assertReferences(selected: SelectedFunction, original: Original): void {
  const { fn, selector } = selected;
  const id = fn['id'];
  const found = original.parents.get(fn);
  if (found === undefined || !identifier(id)) return refuse('helper binding');
  const ancestors = new Set(selected.inline ? found.scopes.slice(-1) : found.scopes);
  for (const visit of original.visits) {
    if (!identifier(visit.node)) continue;
    const { node } = visit;
    const bound = bindingScope(node.name, visit.scopes);
    const helperBinding = bound !== undefined && node.name === id.name && ancestors.has(bound);
    if (helperBinding && !allowedHelperReference(visit, fn, selector))
      refuse('helper alias, mutation or duplicate declaration');
    if (outerCommonJs(visit, original)) refuse('outer CommonJS namespace use');
  }
}
function typeofOperand(node: Node): Node | undefined {
  if (node.type !== 'BinaryExpression' || !['==', '==='].includes(String(node['operator'])))
    return undefined;
  for (const [value, literal] of [
    [node['left'], node['right']],
    [node['right'], node['left']],
  ]) {
    if (
      isNode(value) &&
      value.type === 'UnaryExpression' &&
      value['operator'] === 'typeof' &&
      stringOf(literal) === 'function' &&
      isNode(value['argument'])
    )
      return value['argument'];
  }
  return undefined;
}
function primitiveUndefined(node: Node): boolean {
  const argument = node['argument'];
  return (
    (identifier(node) && node.name === 'undefined') ||
    (node.type === 'UnaryExpression' &&
      node['operator'] === 'void' &&
      isNode(argument) &&
      argument.type === 'Literal' &&
      argument['value'] === 0)
  );
}
function strictDefaultOperand(node: Node): Node | undefined {
  if (node.type !== 'BinaryExpression' || node['operator'] !== '===') return undefined;
  const left = node['left'];
  const right = node['right'];
  if (identifier(left) && stringOf(right) === 'default') return left;
  return identifier(right) && stringOf(left) === 'default' ? right : undefined;
}
function functionShape(fn: Node): string {
  const body = fn['body'];
  if (!isNode(body)) return refuse('helper body');
  const statements = listOf(body, 'body');
  const view = {
    ...fn,
    type: 'FunctionDeclaration',
    body: { ...body, body: strict(statements[0]) ? statements.slice(1) : statements },
  };
  const program: unknown = parseAst(HOIST);
  if (!isNode(program)) return refuse('profile parser');
  const alpha: NodeManifestAlpha = new NodeManifestAlpha({
    original: { ...program, body: [view] },
    body: [view],
    importToken: (node) => {
      // Capture validation already proved that an actual `undefined` is the immutable global.
      if (primitiveUndefined(node)) return 'primitive:undefined';
      const name = strictDefaultOperand(node);
      if (name !== undefined) return `strict-default:${JSON.stringify(alpha.shape(name))}`;
      const operand = typeofOperand(node);
      return operand === undefined
        ? undefined
        : `typeof-function:${JSON.stringify(alpha.shape(operand))}`;
    },
  });
  return JSON.stringify(alpha.body());
}
function validate(input: NodeManifestHoistInput): void {
  const original = originalOf(input);
  const selected = exportedFunction(input, original);
  const { fn } = selected;
  assertStrict(fn, original);
  assertCaptures(fn, original);
  assertReferences(selected, original);
  const actual = functionShape(fn);
  for (const profile of [HOIST, CONDITIONAL_HOIST]) {
    const expected: unknown = parseAst(profile);
    const canonical = isNode(expected) ? listOf(expected, 'body')[0] : undefined;
    if (isNode(canonical) && actual === functionShape(canonical)) return;
  }
  refuse('whole function profile');
}

/** A helper value certificate grants no module, route, VM or compiler-source authority. */
export function certifyNodeManifestHoist(input: NodeManifestHoistInput): NodeManifestHoistProof {
  validate(input);
  const proof = Object.freeze<NodeManifestHoistProof>({ [BRAND]: true });
  CERTIFIED.set(proof, {
    owner: input.owner,
    factory: input.factory,
    projection: input.factory.projection,
    original: input.factory.projection.original,
    fingerprint: fingerprint(input),
  });
  return proof;
}

/** Forged, copied or stale tokens return undefined; fresh proof failures still refuse publication. */
export function nodeManifestHoistMember(
  proof: NodeManifestHoistProof,
  input: NodeManifestHoistInput,
): 'hoist' | undefined {
  const certificate = CERTIFIED.get(proof);
  if (
    certificate?.owner !== input.owner ||
    certificate.factory !== input.factory ||
    certificate.projection !== input.factory.projection ||
    certificate.original !== input.factory.projection.original ||
    certificate.fingerprint !== fingerprint(input)
  )
    return undefined;
  validate(input);
  return 'hoist';
}
