import type { Node as AstNode } from '@oxc-project/types';
import { parseAst } from 'rolldown/parseAst';

import { jsLiteral } from './codegen.ts';
import { AuditError } from './dependencies.ts';
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
import type { NodeManifestTurbopackProjection } from './node-manifest-turbopack.ts';

const PREFIX = '__upwind_pages_esm_';
const IMPORTS = [
  ['../../server/route-modules/pages/module.compiled', 'PagesRouteModule'],
  ['../../server/route-kind', 'RouteKind'],
  ['./helpers', 'hoist'],
  ['VAR_MODULE_DOCUMENT', 'document'],
  ['VAR_MODULE_APP', 'app'],
  ['VAR_USERLAND', 'userland'],
  ['../../server/route-modules/pages/pages-handler', 'getHandler'],
] as const;
const EXPORTS = [
  'default',
  'getStaticProps',
  'getStaticPaths',
  'getServerSideProps',
  'config',
  'reportWebVitals',
  'unstable_getStaticProps',
  'unstable_getStaticPaths',
  'unstable_getStaticParams',
  'unstable_getServerProps',
  'unstable_getServerSideProps',
  'routeModule',
  'handler',
] as const;
const SWC_EXPORT =
  'function __upwind_pages_esm_exports(target,all){for(var name in all)Object.defineProperty(target,name,{enumerable:true,get:all[name]});}';
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly code: string;
}
function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Pages ESM template ${reason}; refusing native publication`,
  );
}
function parsed(code: string): Node {
  const value: unknown = parseAst(code);
  if (!isNode(value) || value.type !== 'Program') return refuse('program');
  return value;
}
function edited(code: string, edits: readonly Edit[]): string {
  let boundary = code.length;
  let result = code;
  const ordered = edits.toSorted((left, right) => right.start - left.start);
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end > boundary || edit.end < edit.start) refuse('overlapping view');
    result = result.slice(0, edit.start) + edit.code + result.slice(edit.end);
    boundary = edit.start;
  }
  return result;
}
function namedUse(
  node: Node,
  parent: Node | undefined,
  imported: string,
  namespace: string,
): string {
  if (imported === 'PagesRouteModule') {
    if (parent?.type !== 'NewExpression' || parent['callee'] !== node) refuse('class import use');
  } else if (imported === 'RouteKind') {
    if (
      parent?.type !== 'MemberExpression' ||
      parent['object'] !== node ||
      propertyName(parent) !== 'PAGES'
    )
      refuse('route kind use');
  } else {
    if (
      parent?.type !== 'CallExpression' ||
      parent['callee'] !== node ||
      parent['optional'] === true
    )
      refuse('helper receiver');
    return `(0,${namespace}.${imported})`;
  }
  return `${namespace}.${imported}`;
}

type ExpectedImport = (typeof IMPORTS)[number];
function importSpecifier(statement: Node, expected: ExpectedImport): Node {
  const specs = listOf(statement, 'specifiers');
  const spec = specs[0];
  if (
    specs.length !== 1 ||
    !isNode(spec) ||
    !identifier(spec['local']) ||
    spec['local'].name !== expected[1] ||
    stringOf(statement['source']) !== expected[0]
  )
    return refuse('fixed import inventory');
  if (expected[0].startsWith('VAR_')) {
    if (spec.type !== 'ImportNamespaceSpecifier') return refuse('namespace import semantics');
  } else if (
    spec.type !== 'ImportSpecifier' ||
    !identifier(spec['imported']) ||
    spec['imported'].name !== expected[1]
  )
    return refuse('named import semantics');
  return spec;
}
class ExpectedPagesEsm {
  private readonly code: string;
  private readonly program: Node;
  private readonly visits: ReturnType<typeof visitTree>;
  private readonly edits: Edit[] = [];
  private readonly fields: [string, string][] = [];
  private imported = 0;
  constructor(code: string) {
    this.code = code;
    if (code.includes(PREFIX)) refuse('reserved expected name');
    this.program = parsed(code);
    this.visits = visitTree(this.program);
  }
  private references(statement: Node, spec: Node, name: string, namespace: string): void {
    for (const visit of this.visits) {
      if (
        !identifier(visit.node) ||
        !reference(visit) ||
        visit.node.start < statement.end ||
        declaration(visit.node.name, visit.scopes)?.node !== spec
      )
        continue;
      this.edits.push({
        start: visit.node.start,
        end: visit.node.end,
        code: namedUse(visit.node, visit.parent, name, namespace),
      });
    }
  }
  private importedStatement(statement: Node): void {
    const expected = IMPORTS[this.imported];
    if (expected === undefined) refuse('extra import');
    const spec = importSpecifier(statement, expected);
    const namespace = expected[0].startsWith('VAR_');
    const local = namespace ? expected[1] : `${PREFIX}import_${this.imported}`;
    this.edits.push({
      start: statement.start,
      end: statement.end,
      code: `const ${local}=require(${jsLiteral(expected[0])});`,
    });
    if (!namespace) this.references(statement, spec, expected[1], local);
    this.imported += 1;
  }
  private defaultExport(statement: Node): void {
    const value = statement['declaration'];
    if (!isNode(value) || value.type !== 'CallExpression') refuse('default expression');
    const local = `${PREFIX}default`;
    this.fields.push(['default', local]);
    this.edits.push({ start: statement.start, end: value.start, code: `const ${local}=` });
  }
  private namedExport(statement: Node): void {
    const value = statement['declaration'];
    if (
      !isNode(value) ||
      value.type !== 'VariableDeclaration' ||
      value['kind'] !== 'const' ||
      listOf(statement, 'specifiers').length > 0 ||
      listOf(value, 'declarations').length !== 1
    )
      refuse('fixed export declaration');
    const variable = listOf(value, 'declarations')[0];
    if (!isNode(variable) || !identifier(variable['id']) || !isNode(variable['init']))
      refuse('initialized export');
    this.fields.push([variable['id'].name, variable['id'].name]);
    this.edits.push({ start: statement.start, end: value.start, code: '' });
  }
  codeView(): string {
    for (const statement of listOf(this.program, 'body')) {
      if (!isNode(statement)) refuse('statement');
      switch (statement.type) {
        case 'ImportDeclaration': {
          this.importedStatement(statement);
          break;
        }
        case 'ExportDefaultDeclaration': {
          this.defaultExport(statement);
          break;
        }
        case 'ExportNamedDeclaration': {
          this.namedExport(statement);
          break;
        }
        default: {
          refuse('unreviewed top-level statement');
        }
      }
    }
    if (
      this.imported !== IMPORTS.length ||
      JSON.stringify(this.fields.map(([name]) => name)) !== JSON.stringify(EXPORTS)
    )
      refuse('fixed import/export inventory');
    const getters = this.fields.map(
      ([name, local]) => `${jsLiteral(name)}:function(){return ${local};}`,
    );
    return `${SWC_EXPORT}\n${PREFIX}exports(exports,{${getters.join(',')}});\n${edited(this.code, this.edits)}`;
  }
}
/** Expected inspection DATA only; the caller first verifies the complete fixed public source. */
export function nodeManifestPagesEsmExpectedCode(code: string): string {
  return new ExpectedPagesEsm(code).codeView();
}

interface NamespaceInput {
  readonly program: Node;
  readonly projection: NodeManifestTurbopackProjection;
  readonly slots: ReadonlyMap<Node, string>;
  /** Only the enclosing checked private coalesced profile can supply this existing slot. */
  readonly namespace?: string;
}
function genuineStrictDirective(node: Node): boolean {
  const body = node.type === 'Program' ? node : node['body'];
  if (!isNode(body)) return false;
  for (const statement of listOf(body, 'body')) {
    const value = isNode(statement) ? statement['expression'] : undefined;
    if (
      !isNode(statement) ||
      statement.type !== 'ExpressionStatement' ||
      !isNode(value) ||
      value.type !== 'Literal' ||
      typeof value['value'] !== 'string' ||
      value.start !== statement.start
    )
      break;
    if (value['raw'] === '"use strict"' || value['raw'] === "'use strict'") return true;
  }
  return false;
}
function assertOriginalStrictness(projection: NodeManifestTurbopackProjection): void {
  const visits = new Map(
    visitTree(parsed(projection.original.code)).map((visit) => [visit.node, visit]),
  );
  let node: Node | undefined;
  for (const candidate of visits.keys())
    if (candidate.start === projection.factory.start && candidate.end === projection.factory.end) {
      node = candidate;
      break;
    }
  while (node !== undefined) {
    if (['ClassDeclaration', 'ClassExpression'].includes(node.type)) return;
    if (
      ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression', 'Program'].includes(
        node.type,
      ) &&
      genuineStrictDirective(node)
    )
      return;
    node = visits.get(node)?.parent;
  }
  refuse('genuine original factory strictness');
}
function assertNamespacePort(variable: Node, input: NamespaceInput): void {
  const local = variable['id'];
  const call = variable['init'];
  if (
    variable.type !== 'VariableDeclarator' ||
    !identifier(local) ||
    !isNode(call) ||
    call.type !== 'CallExpression' ||
    call['optional'] === true ||
    !identifier(call['callee'])
  )
    refuse('namespace binding');
  const visits = new Map(visitTree(input.program).map((visit) => [visit.node, visit]));
  const visit = visits.get(call);
  if (
    visit === undefined ||
    call['callee'].name !== 'require' ||
    declaration('require', visit.scopes) !== undefined ||
    listOf(call, 'arguments').length !== 1 ||
    !nativeBindings(input.program as unknown as AstNode).unmodified(
      variable as unknown as AstNode,
      local.name,
      true,
    )
  )
    refuse('namespace binding');
  const specifier = stringOf(listOf(call, 'arguments')[0]);
  const ports = input.projection.imports.filter((entry) => entry.specifier === specifier);
  if (
    specifier === undefined ||
    ports.length === 0 ||
    ports.some((entry) => entry.kind !== 'import' || entry.targetId === undefined)
  )
    refuse('namespace import mode');
}
const NAMESPACES = ['VAR_USERLAND', 'VAR_MODULE_APP', 'VAR_MODULE_DOCUMENT'];
/** VAR namespaces require original reviewed esmImport ports, never raw require equivalence. */
export function assertNodeManifestPagesEsmPorts(input: NamespaceInput): void {
  assertOriginalStrictness(input.projection);
  const roles = new Set<string>();
  if (input.namespace !== undefined) roles.add('VAR_USERLAND');
  for (const [variable, role] of input.slots) {
    if (roles.has(role)) refuse('duplicate namespace');
    assertNamespacePort(variable, input);
    roles.add(role);
  }
  if (roles.size !== NAMESPACES.length || NAMESPACES.some((role) => !roles.has(role)))
    refuse('namespace inventory');
}
