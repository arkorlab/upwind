import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { identifier as nativeIdentifier, nativeBindings, walk } from './native-ast.ts';
import { processDlopen } from './native-process.ts';
import { nativeSourceAnalysis, type NativeSourceAnalysis } from './native-source-parser.ts';
import { hostPropertyName, isCommonJsHost } from './node-closure-hosts.ts';
import { reference, visitTree, type Visit } from './node-manifest-consumer-ast.ts';

const HOST_LOADERS: ReadonlySet<string> = new Set(['_compile', 'constructor', 'load', 'require']);
const HOST_ARRAY_MEMBERS: ReadonlySet<string> = new Set(['children', 'paths']);
const HOST_VALUE_MEMBERS: ReadonlySet<string> = new Set(['children', 'parent', 'paths']);
const METADATA_UNARY: ReadonlySet<string> = new Set(['!', 'typeof', 'void']);
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;
const ASSIGNMENT_PATTERNS: ReadonlySet<string> = new Set([
  'ArrayPattern',
  'AssignmentPattern',
  'ObjectPattern',
  'Property',
  'RestElement',
]);

export const ORIGINAL_HOST_MARKER_PREFIX = '__UPWIND_ORIGINAL_HOST_';

export interface OriginalNodeHostLoaderSite {
  readonly start: number;
  readonly end: number;
  readonly expressionStart: number;
  readonly expressionEnd: number;
}

function isLoaderMember(name: string | undefined): boolean {
  return name === undefined || HOST_LOADERS.has(name);
}

function isLoaderPattern(pattern: unknown): boolean {
  if (!isNode(pattern) || pattern.type !== 'ObjectPattern') return false;
  return listOf(pattern, 'properties').some((property) => {
    return (
      !isNode(property) ||
      property.type === 'RestElement' ||
      isLoaderMember(hostPropertyName(property)) ||
      HOST_VALUE_MEMBERS.has(hostPropertyName(property) ?? '')
    );
  });
}

function memberExpression(node: Node, parent: Node | undefined): Node {
  if (parent === undefined) return node;
  if (
    (parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
    parent['callee'] === node
  )
    return parent;
  if (parent.type === 'AssignmentExpression' && parent['left'] === node) return parent;
  if (parent.type === 'UpdateExpression' && parent['argument'] === node) return parent;
  if (parent.type === 'UnaryExpression' && parent['operator'] === 'delete') return parent;
  return node;
}

function hostExpression(
  node: Node,
  parent: Node | undefined,
  scopes: readonly Scope[],
): Node | undefined {
  if (
    node.type === 'MemberExpression' &&
    isCommonJsHost(node['object'], scopes) &&
    isLoaderMember(hostPropertyName(node))
  )
    return memberExpression(node, parent);
  if (
    node.type === 'VariableDeclarator' &&
    isLoaderPattern(node['id']) &&
    isCommonJsHost(node['init'], scopes) &&
    isNode(node['init'])
  )
    return node['init'];
  return undefined;
}

function isAliasInitializer(visit: Visit, byNode: ReadonlyMap<Node, Visit>): boolean {
  const parent = visit.parent;
  if (parent?.type !== 'VariableDeclarator' || visit.key !== 'init') return false;
  const declaration = byNode.get(parent)?.parent;
  return (
    declaration === undefined || byNode.get(declaration)?.parent?.type !== 'ExportNamedDeclaration'
  );
}

function isMetadataUse(visit: Visit): boolean {
  const parent = visit.parent;
  if (parent === undefined) return false;
  if (parent.type === 'MemberExpression' && visit.key === 'object') return true;
  if (parent.type === 'ExpressionStatement') return true;
  if (parent.type === 'UnaryExpression' && METADATA_UNARY.has(String(parent['operator'])))
    return true;
  return visit.key === 'test';
}

function directWriteTarget(parent: Node, value: Node): boolean | undefined {
  if (parent.type === 'AssignmentExpression') return parent['left'] === value;
  if (parent.type === 'UpdateExpression') return parent['argument'] === value;
  if (parent.type === 'UnaryExpression') return parent['operator'] === 'delete';
  if (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement')
    return parent['left'] === value;
  return undefined;
}

function isWriteTarget(node: Node, byNode: ReadonlyMap<Node, Visit>): boolean {
  let current = node;
  for (
    let parent = byNode.get(current)?.parent;
    parent !== undefined;
    parent = byNode.get(current)?.parent
  ) {
    const isDirectTarget = directWriteTarget(parent, current);
    if (isDirectTarget !== undefined) return isDirectTarget;
    if (!ASSIGNMENT_PATTERNS.has(parent.type)) return false;
    if (parent.type === 'Property' && parent['value'] !== current) return false;
    if (parent.type === 'AssignmentPattern' && parent['left'] !== current) return false;
    current = parent;
  }
  return false;
}

function isPathIndex(node: Node): boolean {
  const property = node['property'];
  if (node['computed'] !== true || !isNode(property) || property.type !== 'Literal') return false;
  const value = property['value'];
  return typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string' && ARRAY_INDEX.test(value);
}

function isArrayMetadata(node: Node, name: string): boolean {
  if (hostPropertyName(node) === 'length') return true;
  return name === 'paths' && isPathIndex(node);
}

function hostArray(visit: Visit, byNode: ReadonlyMap<Node, Visit>): Node | undefined {
  const node = visit.node;
  const name = hostPropertyName(node);
  if (
    node.type !== 'MemberExpression' ||
    !HOST_ARRAY_MEMBERS.has(name ?? '') ||
    !isCommonJsHost(node['object'], visit.scopes)
  )
    return undefined;
  const parent = visit.parent;
  if (
    parent?.type === 'MemberExpression' &&
    parent['object'] === node &&
    isArrayMetadata(parent, name ?? '') &&
    !isWriteTarget(parent, byNode)
  )
    return undefined;
  if (isWriteTarget(node, byNode) && isNode(node['object'])) return node['object'];
  return memberExpression(node, parent);
}

function hostEscape(
  visit: Visit,
  byNode: ReadonlyMap<Node, Visit>,
  nativeOperands: ReadonlySet<unknown>,
): Node | undefined {
  if (visit.node.type !== 'Identifier' && visit.node.type !== 'MemberExpression') return undefined;
  if (!reference(visit) || !isCommonJsHost(visit.node, visit.scopes)) return undefined;
  if (nativeOperands.has(visit.node) || isMetadataUse(visit) || isAliasInitializer(visit, byNode))
    return undefined;
  if (isWriteTarget(visit.node, byNode)) return undefined;
  if (visit.parent?.type === 'Property' && visit.parent['shorthand'] === true) {
    const object = byNode.get(visit.parent)?.parent;
    return object?.type === 'ObjectExpression' ? object : undefined;
  }
  return visit.node;
}

function originalSites(
  program: Node,
  nativeOperands: ReadonlySet<unknown>,
): OriginalNodeHostLoaderSite[] {
  const sites = new Map<string, OriginalNodeHostLoaderSite>();
  const visits = visitTree(program);
  const byNode = new Map(visits.map((visit) => [visit.node, visit]));
  for (const visit of visits) {
    const expression =
      hostExpression(visit.node, visit.parent, visit.scopes) ??
      hostArray(visit, byNode) ??
      hostEscape(visit, byNode, nativeOperands);
    if (expression !== undefined)
      sites.set(`${visit.node.start}:${visit.node.end}:${expression.start}:${expression.end}`, {
        start: visit.node.start,
        end: visit.node.end,
        expressionStart: expression.start,
        expressionEnd: expression.end,
      });
  }
  return [...sites.values()];
}

function classifiedNativeOperands(program: NativeSourceAnalysis['program']): ReadonlySet<unknown> {
  const operands = new Set<unknown>();
  const bindings = nativeBindings(program);
  for (const node of walk(program)) {
    if (node.type === 'Identifier' && node.name.startsWith(ORIGINAL_HOST_MARKER_PREFIX))
      throw new AuditError('Reserved original host analysis marker appears in application source');
    if (node.type !== 'CallExpression' || processDlopen(node.callee, bindings) !== 'known')
      continue;
    const module = node.arguments[0];
    if (nativeIdentifier(module, 'module')) operands.add(module);
  }
  return operands;
}

/** Offsets and source stay together after trusted, inspection-only TypeScript lowering. */
export function originalNodeHostLoaderAnalysis(
  file: string,
  code: string,
): { readonly code: string; readonly sites: readonly OriginalNodeHostLoaderSite[] } {
  const analysis = nativeSourceAnalysis(code, file);
  const program: unknown = analysis.program;
  if (!isNode(program)) throw new TypeError('Original host-loader proof requires a program');
  return {
    code: analysis.code,
    sites: originalSites(program, classifiedNativeOperands(analysis.program)),
  };
}

/** Source-proven host operations, before a CommonJS wrapper can shadow the host module. */
export function originalNodeHostLoaderSites(
  file: string,
  code: string,
): readonly OriginalNodeHostLoaderSite[] {
  return originalNodeHostLoaderAnalysis(file, code).sites;
}

/**
 * A compiler's CommonJS wrapper shadows the real host `module`. Check retained original source
 * too; classified native operations and separately proved manifest VM calls stay independent.
 */
export function originalNodeHostLoaderRefusal(file: string, code: string): string | undefined {
  return originalNodeHostLoaderSites(file, code).length > 0
    ? 'an unproved original CommonJS host loader'
    : undefined;
}
