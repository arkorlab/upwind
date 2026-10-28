import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node } from './lexical-scope.ts';
import { identifier, propertyName, stringOf, visitTree } from './node-manifest-consumer-ast.ts';
import { manifestConstructorImport } from './node-manifest-framework.ts';
import {
  projectNodeManifestTurbopackFactory,
  turbopackModuleId,
  turbopackModuleSpecifier,
  type NodeManifestTurbopackImport,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

const NAMES = [
  'AppRouterContext',
  'HeadManagerContext',
  'HooksClientContext',
  'HtmlContext',
  'ImageConfigContext',
  'Loadable',
  'LoadableContext',
  'RouterContext',
  'ServerInsertedHtml',
] as const;
const CONTEXT_NAMES: ReadonlySet<string> = new Set(NAMES);
const COMMONJS_PARAMETERS = 3;
const EXTERNAL_ARGUMENTS = 2;
const EXTERNAL_INTEROP_ARGUMENTS = 3;
interface Producer {
  readonly specifier: string;
  readonly file: string;
  readonly sha256: string;
}
interface Input {
  readonly projection: NodeManifestTurbopackProjection;
  /** An actual source-checked resolution from the original graph, never caller source text. */
  readonly producer: Producer;
}
export interface NodeManifestPagesContextProof extends Producer {
  readonly kind: 'pages-context-namespace';
  readonly namespace: (typeof NAMES)[number];
  readonly root: string;
}
const CERTIFICATES = new WeakMap<
  NodeManifestPagesContextProof,
  { readonly projection: NodeManifestTurbopackProjection; readonly fingerprint: string }
>();

function dot(node: unknown, name: string): node is Node {
  return (
    isNode(node) &&
    node.type === 'MemberExpression' &&
    node['computed'] !== true &&
    node['optional'] !== true &&
    propertyName(node) === name
  );
}
function contextIndex(node: unknown): node is Node {
  if (dot(node, 'contexts')) return true;
  if (!isNode(node) || node.type !== 'MemberExpression' || node['optional'] === true) return false;
  const key = node['property'];
  return (
    node['computed'] === true &&
    isNode(key) &&
    key.type === 'Literal' &&
    key['value'] === 'contexts'
  );
}
function strictDirective(node: unknown): boolean {
  if (!isNode(node) || node.type !== 'ExpressionStatement') return false;
  const value = node['expression'];
  return (
    isNode(value) &&
    value.type === 'Literal' &&
    value.start === node.start &&
    (value['raw'] === '"use strict"' || value['raw'] === "'use strict'")
  );
}
function dependencyOf(call: Node, context: string): NodeManifestTurbopackImport | undefined {
  const callee = call['callee'];
  if (!isNode(callee) || !identifier(callee['object']) || callee['object'].name !== context)
    return undefined;
  const args = listOf(call, 'arguments');
  if (dot(callee, 'i') || dot(callee, 'r')) {
    const id = turbopackModuleId(args[0]);
    return id !== undefined && args.length === 1
      ? {
          kind: propertyName(callee) === 'i' ? 'import' : 'require',
          targetId: id,
          specifier: turbopackModuleSpecifier(id),
        }
      : undefined;
  }
  if (!dot(callee, 'x')) return undefined;
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
function commonJsParameters(node: Node): readonly (Node & { readonly name: string })[] | undefined {
  const params = listOf(node, 'params');
  if (
    params.length !== COMMONJS_PARAMETERS ||
    !params.every(identifier) ||
    new Set(params.map((param) => param.name)).size !== COMMONJS_PARAMETERS ||
    !isNode(node['body'])
  )
    return undefined;
  return params;
}
function exportedValue(node: Node, module: string): Node | undefined {
  if (!isNode(node['body'])) return undefined;
  const statements = listOf(node['body'], 'body');
  const body = strictDirective(statements[0]) ? statements.slice(1) : statements;
  const only = body[0];
  if (body.length !== 1 || !isNode(only) || only.type !== 'ExpressionStatement') return undefined;
  const assignment = only['expression'];
  if (
    !isNode(assignment) ||
    assignment.type !== 'AssignmentExpression' ||
    assignment['operator'] !== '='
  )
    return undefined;
  const left = assignment['left'];
  if (!dot(left, 'exports') || !identifier(left['object']) || left['object'].name !== module)
    return undefined;
  return isNode(assignment['right']) ? assignment['right'] : undefined;
}
function selector(node: Node):
  | {
      readonly namespace: (typeof NAMES)[number];
      readonly dependency: NodeManifestTurbopackImport;
    }
  | undefined {
  const params = commonJsParameters(node);
  const context = params?.[0];
  const module = params?.[1];
  if (context === undefined || module === undefined) return undefined;
  const selected = exportedValue(node, module.name);
  if (!isNode(selected) || selected.type !== 'MemberExpression') return undefined;
  const name = propertyName(selected);
  if (name === undefined || !CONTEXT_NAMES.has(name) || !dot(selected, name)) return undefined;
  const index = selected['object'];
  if (!contextIndex(index)) return undefined;
  const vendored = index['object'];
  if (!dot(vendored, 'vendored')) return undefined;
  const call = vendored['object'];
  if (!isNode(call) || call.type !== 'CallExpression' || call['optional'] === true)
    return undefined;
  const dependency = dependencyOf(call, context.name);
  return dependency === undefined
    ? undefined
    : { namespace: name as (typeof NAMES)[number], dependency };
}

function fingerprint(input: Input): string | undefined {
  const serialized = JSON.stringify([
    input.projection,
    input.producer.specifier,
    input.producer.file,
    input.producer.sha256,
  ]);
  return typeof serialized === 'string'
    ? createHash('sha256').update(serialized).digest('hex')
    : undefined;
}

function sameProjection(
  checked: NodeManifestTurbopackProjection,
  current: NodeManifestTurbopackProjection,
): boolean {
  return JSON.stringify(checked) === JSON.stringify(current);
}

/** A benign context namespace is distinct from a route class, handler or factory authority. */
export function certifyNodeManifestPagesContext(
  input: Input,
): NodeManifestPagesContextProof | undefined {
  const producer = manifestConstructorImport(input.producer.file, input.producer.sha256);
  if (producer?.kind !== 'pages') return undefined;
  const projection = input.projection;
  if (projection.mode !== 'strict') return undefined;
  const checked = projectNodeManifestTurbopackFactory(projection.original, projection.moduleId);
  const imported = checked.imports[0];
  if (
    checked.exports.kind !== 'commonjs' ||
    checked.imports.length !== 1 ||
    checked.boundRuntimeInputs.length > 0 ||
    !sameProjection(checked, projection) ||
    imported?.specifier !== input.producer.specifier
  )
    return undefined;
  const parsed: unknown = parseAst(projection.original.code);
  if (!isNode(parsed)) return undefined;
  const factory = visitTree(parsed).find(({ node }) => {
    return (
      node.start === checked.factory.start &&
      node.end === checked.factory.end &&
      ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)
    );
  })?.node;
  const selected = factory === undefined ? undefined : selector(factory);
  if (
    selected?.dependency.kind !== imported.kind ||
    selected.dependency.specifier !== imported.specifier ||
    selected.dependency.targetId !== imported.targetId
  )
    return undefined;
  const key = fingerprint(input);
  if (key === undefined) return undefined;
  const proof = Object.freeze({
    kind: 'pages-context-namespace' as const,
    namespace: selected.namespace,
    specifier: input.producer.specifier,
    file: input.producer.file,
    sha256: input.producer.sha256,
    root: producer.root,
  });
  CERTIFICATES.set(proof, { projection, fingerprint: key });
  return proof;
}

/** Callers must still match the actual graph edge and its reviewed producer scope. */
export function isCertifiedNodeManifestPagesContext(
  proof: NodeManifestPagesContextProof,
  input: Input,
): boolean {
  const certificate = CERTIFICATES.get(proof);
  return (
    certificate?.projection === input.projection && certificate.fingerprint === fingerprint(input)
  );
}
