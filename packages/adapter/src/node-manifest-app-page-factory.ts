import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { beneath } from './build-paths.ts';
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
import { reviewedFrameworkSource } from './node-manifest-framework.ts';
import {
  projectedTemplateExports,
  type ManifestTemplateExports,
} from './node-manifest-template-exports.ts';
import type { NodeManifestTemplateImport } from './node-manifest-templates.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackModuleId,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

const TEMPLATE = 'dist/build/templates/app-page-runtime.js';
const TEMPLATE_SHA = '0a6a5c726f95e2df2600b2fd6d71e37fd72f936f8f4dc5b94fa38d40fcd62a6b';
const CLASS_MODULE = 'dist/server/route-modules/app-page/module.compiled.js';
const CLASS_SOURCES = [
  CLASS_MODULE,
  'dist/compiled/next-server/app-page.runtime.prod.js',
  'dist/compiled/next-server/app-page-turbo.runtime.prod.js',
  'dist/compiled/next-server/app-page-experimental.runtime.prod.js',
  'dist/compiled/next-server/app-page-turbo-experimental.runtime.prod.js',
] as const;
const FACTORY = 'createAppPageEntrypoint';
const MAX_SOURCE_BYTES = 134_217_728;
const DEFINE_PROPERTY_ARGUMENTS = 3;
const certified = new WeakSet<WeakKey>();

export type NodeManifestAppPageFactoryImport =
  | NodeManifestTemplateImport
  | {
      readonly specifier: string;
      readonly builtin: string;
    };

export interface NodeManifestAppPageFactoryProof {
  readonly file: string;
  readonly sha256: string;
  readonly moduleId: NodeManifestTurbopackModuleId;
  readonly projectionSha256: string;
  readonly imports: readonly NodeManifestAppPageFactoryImport[];
}
export interface NodeManifestAppPageFactoryInput {
  readonly file: string;
  readonly projection: NodeManifestTurbopackProjection;
  readonly imports: readonly NodeManifestAppPageFactoryImport[];
}

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js AppPage factory ${reason}; refusing native publication`);
}
function digest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}
function program(code: string): Node {
  const parsed: unknown = parseAst(code);
  return isNode(parsed) ? parsed : refuse('program');
}
async function bytesOf(file: string): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return refuse('source bounds');
  const bytes = await readFile(file);
  if (bytes.length !== info.size) return refuse('changed source bytes');
  return bytes;
}
function constructorIdentity(file: string, sha256: string): { readonly root: string } | undefined {
  const normal = file.replaceAll('\\', '/');
  for (const relative of CLASS_SOURCES) {
    if (normal.endsWith(`/${relative}`) && reviewedFrameworkSource(relative) === sha256)
      return { root: file.slice(0, -relative.length - 1) };
  }
  return undefined;
}
function strict(statement: unknown): boolean {
  return (
    isNode(statement) &&
    statement.type === 'ExpressionStatement' &&
    stringOf(statement['expression']) === 'use strict'
  );
}
function assertStrict(projection: NodeManifestTurbopackProjection): void {
  const visits = visitTree(program(projection.original.code));
  const parents = new Map(visits.map((visit) => [visit.node, visit.parent]));
  let node = visits.find(
    ({ node: candidate }) =>
      candidate.start === projection.factory.start && candidate.end === projection.factory.end,
  )?.node;
  while (node !== undefined) {
    const body = node.type === 'Program' ? node : node['body'];
    if (isNode(body) && strict(listOf(body, 'body')[0])) return;
    node = parents.get(node);
  }
  refuse('factory strictness');
}
function exportDescriptor(call: Node): Node | undefined {
  const callee = call['callee'];
  const args = listOf(call, 'arguments');
  const owner = args[0];
  const descriptor = args[2];
  if (
    !isNode(callee) ||
    callee.type !== 'MemberExpression' ||
    !identifier(callee['object']) ||
    callee['object'].name !== 'Object' ||
    propertyName(callee) !== 'defineProperty' ||
    args.length !== DEFINE_PROPERTY_ARGUMENTS ||
    !identifier(owner) ||
    owner.name !== 'exports' ||
    stringOf(args[1]) !== FACTORY ||
    !isNode(descriptor) ||
    descriptor.type !== 'ObjectExpression'
  )
    return undefined;
  return descriptor;
}
function exportCall(statement: Node): { readonly value: Node } | undefined {
  if (statement.type !== 'ExpressionStatement') return undefined;
  const call = statement['expression'];
  if (!isNode(call) || call.type !== 'CallExpression') return undefined;
  const descriptor = exportDescriptor(call);
  if (descriptor === undefined) return undefined;
  const fields = listOf(descriptor, 'properties');
  if (fields.length !== 2) return refuse('export descriptor');
  const enumerable = fields.find((field) => isNode(field) && propertyName(field) === 'enumerable');
  const getter = fields.find((field) => isNode(field) && propertyName(field) === 'get');
  const value = isNode(enumerable) ? enumerable['value'] : undefined;
  const selected = getterValue(getter);
  if (
    !isNode(value) ||
    value.type !== 'Literal' ||
    value['value'] !== true ||
    !identifier(selected)
  )
    return refuse('export getter');
  const fn = isNode(getter) ? getter['value'] : undefined;
  if (!isNode(fn) || (fn['id'] !== null && fn['id'] !== undefined))
    return refuse('named export getter');
  return { value: selected };
}
function exportsOf(
  value: Node,
  projection?: NodeManifestTurbopackProjection,
): ManifestTemplateExports {
  if (projection?.exports.kind === 'getters') return projectedTemplateExports(value);
  const body: unknown[] = [];
  const fields = new Map<string, Node>();
  for (const statement of listOf(value, 'body')) {
    if (!isNode(statement)) return refuse('export statement');
    const expression = statement['expression'];
    if (strict(statement) || (isNode(expression) && swcHeader(expression))) continue;
    const selected = exportCall(statement);
    if (selected === undefined) body.push(statement);
    else {
      if (fields.has(FACTORY)) return refuse('duplicate factory export');
      fields.set(FACTORY, selected.value);
    }
  }
  if (fields.size !== 1) return refuse('factory export');
  return { body, fields };
}

interface ImportView {
  readonly root: string;
  readonly require: NodeRequire;
  readonly imports?: ReadonlyMap<string, NodeManifestAppPageFactoryImport>;
  readonly visits: ReadonlyMap<Node, ReturnType<typeof visitTree>[number]>;
  readonly closed: Map<string, NodeManifestAppPageFactoryImport>;
}
function staticRequire(node: Node, context: ImportView): string | undefined {
  if (
    node.type !== 'CallExpression' ||
    !identifier(node['callee']) ||
    node['callee'].name !== 'require'
  )
    return undefined;
  const visit = context.visits.get(node);
  if (visit === undefined || declaration('require', visit.scopes) !== undefined) return undefined;
  const args = listOf(node, 'arguments');
  const specifier = stringOf(args[0]);
  if (specifier === undefined || args.length !== 1) return refuse('static import');
  return specifier;
}
function importedFile(
  specifier: string,
  context: ImportView,
  imported: NodeManifestAppPageFactoryImport | undefined,
): string {
  if (imported === undefined) {
    const target = specifier.startsWith('next/')
      ? path.join(context.root, specifier.slice('next/'.length))
      : specifier;
    return context.require.resolve(target);
  }
  return 'builtin' in imported ? imported.builtin : imported.file;
}
function importToken(node: Node, context: ImportView): string | undefined {
  const specifier = staticRequire(node, context);
  if (specifier === undefined) return undefined;
  const imported = context.imports?.get(specifier);
  if (imported === undefined && context.imports !== undefined)
    return refuse('missing resolved import');
  if (imported !== undefined) context.closed.set(specifier, imported);
  const file = importedFile(specifier, context, imported);
  if (isBuiltin(file)) return `builtin:${file.replace(/^node:/u, '')}`;
  if (imported !== undefined && 'builtin' in imported) return refuse('unknown builtin identity');
  const relative = beneath(context.root, file)?.split(path.sep).join('/');
  if (relative === undefined) return refuse('framework import root');
  const identity = imported === undefined ? undefined : constructorIdentity(file, imported.sha256);
  if (identity !== undefined || relative === CLASS_MODULE) {
    if (imported !== undefined && identity === undefined) return refuse('changed class namespace');
    return `next:${CLASS_MODULE}`;
  }
  return `next:${relative}`;
}

async function primaryFor(
  imports: readonly NodeManifestAppPageFactoryImport[],
): Promise<{ readonly root: string; readonly template: string; readonly bytes: Buffer }> {
  const constructors = imports
    .map((entry) =>
      'builtin' in entry ? undefined : constructorIdentity(entry.file, entry.sha256),
    )
    .filter((entry) => entry !== undefined);
  const constructor = constructors[0];
  if (constructor === undefined || constructors.length !== 1) return refuse('constructor identity');
  const root = await realpath(constructor.root);
  const template = await realpath(path.join(root, TEMPLATE));
  if (beneath(root, template) === undefined) return refuse('template path');
  const bytes = await bytesOf(template);
  if (digest(bytes) !== TEMPLATE_SHA) return refuse('template bytes');
  return { root, template, bytes };
}
function view(
  value: Node,
  exports: ManifestTemplateExports,
  context: Omit<ImportView, 'visits'>,
): NodeManifestAlpha {
  const visits = new Map(visitTree(value).map((visit) => [visit.node, visit]));
  return new NodeManifestAlpha({
    original: value,
    body: exports.body.filter((statement) => !strict(statement)),
    importToken: (node) => importToken(node, { ...context, visits }),
  });
}

/** Full immutable official producer body only; arbitrary AppPage class consumers are never certified. */
export async function certifyNodeManifestAppPageFactory(
  input: NodeManifestAppPageFactoryInput,
): Promise<NodeManifestAppPageFactoryProof> {
  const projection = projectNodeManifestTurbopackFactory(
    input.projection.original,
    input.projection.moduleId,
  );
  if (
    JSON.stringify(projection) !== JSON.stringify(input.projection) ||
    projection.boundRuntimeInputs.length > 0
  )
    return refuse('projection provenance');
  assertStrict(projection);
  const file = await realpath(input.file);
  if (digest(await bytesOf(file)) !== projection.original.sha256)
    return refuse('physical factory source');
  const { root, template, bytes } = await primaryFor(input.imports);
  const imports = new Map(input.imports.map((entry) => [entry.specifier, entry]));
  if (imports.size !== input.imports.length) return refuse('ambiguous imports');
  for (const entry of imports.values()) {
    if ('builtin' in entry) {
      if (!isBuiltin(entry.builtin)) return refuse('unknown builtin identity');
      continue;
    }
    if (
      (await realpath(entry.file)) !== entry.file ||
      digest(await bytesOf(entry.file)) !== entry.sha256
    )
      return refuse('closed import bytes');
  }
  const actualProgram = program(projection.source.code);
  const expectedProgram = program(bytes.toString('utf8'));
  const actualExports = exportsOf(actualProgram, projection);
  if (actualExports.fields.size !== 1 || !actualExports.fields.has(FACTORY))
    return refuse('protected factory export');
  const expectedExports = exportsOf(expectedProgram);
  const closed = new Map<string, NodeManifestAppPageFactoryImport>();
  const require = createRequire(template);
  const actual = view(actualProgram, actualExports, { root, require, imports, closed });
  const expected = view(expectedProgram, expectedExports, { root, require, closed: new Map() });
  if (
    JSON.stringify(actual.body()) !== JSON.stringify(expected.body()) ||
    JSON.stringify(actual.shape(actualExports.fields.get(FACTORY))) !==
      JSON.stringify(expected.shape(expectedExports.fields.get(FACTORY)))
  )
    return refuse('changed fixed producer body');
  if (closed.size !== imports.size) return refuse('unused import identity');
  const proof = Object.freeze({
    file,
    sha256: projection.original.sha256,
    moduleId: projection.moduleId,
    projectionSha256: projection.source.sha256,
    imports: Object.freeze([...closed.values()].map((entry) => Object.freeze({ ...entry }))),
  });
  certified.add(proof);
  return proof;
}

/** A copy or serialized object is not the authority created by the closed producer proof. */
export function isCertifiedNodeManifestAppPageFactory(
  proof: unknown,
  imported: { readonly file: string; readonly sha256: string },
): boolean {
  return (
    typeof proof === 'object' &&
    proof !== null &&
    certified.has(proof) &&
    'file' in proof &&
    typeof proof.file === 'string' &&
    proof.file === imported.file &&
    'sha256' in proof &&
    typeof proof.sha256 === 'string' &&
    proof.sha256 === imported.sha256
  );
}
