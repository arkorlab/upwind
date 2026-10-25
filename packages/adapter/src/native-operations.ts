import { createRequire } from 'node:module';
import path from 'node:path';

import type { Node } from '@oxc-project/types';

import { AuditError } from './dependencies.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import { identifier, nativePath, type NativeBindings, required, stringOf } from './native-ast.ts';
import { nativeLoaderBinary, UnreviewedNativeLoaderError } from './native-loaders.ts';
import type { NativeLoad } from './native-loads.ts';
import { ownedBinary } from './native-ownership.ts';
import { processDlopen } from './native-process.ts';

type Call = Extract<Node, { type: 'CallExpression' }>;
const DLOPEN_ARGUMENTS = 2;
export interface NativeOperationContext {
  readonly importer: string;
  readonly traces: readonly NativeAddonEntryTrace[];
  readonly bindings: NativeBindings;
  readonly guards: ReadonlyMap<number, 'plain' | 'ambiguous'>;
  readonly nodeTarget: boolean;
  mark(load: NativeLoad | Error): string;
}
const STATIC_LOADER_ARGUMENT = 'Native loader requires a statically known argument';

export interface NativeEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
type Candidate = Pick<NativeLoad, 'kind' | 'binary' | 'loaderSources'>;

function directNative(call: Call, context: NativeOperationContext): Candidate | undefined {
  const specifier = required(call);
  if (!specifier?.endsWith('.node')) return undefined;
  if (!globalRequire(call, context)) return undefined;
  if (path.isAbsolute(specifier))
    throw new AuditError('Absolute native imports are not relocatable');
  if (context.guards.has(call.start))
    throw new AuditError('A guarded native load has no proved Worker-safe representation');
  return { kind: 'direct', binary: createRequire(context.importer).resolve(specifier) };
}

function globalRequire(call: Call, context: NativeOperationContext): boolean {
  if (context.bindings.lookup(call, 'require') !== undefined) return false;
  if (!context.bindings.unmodified(call, 'require', false))
    throw new AuditError('A modified require binding has no statically known native loader');
  return true;
}

function loaderArgument(
  call: Call,
  kind: 'bindings' | 'node-gyp-build',
  context: NativeOperationContext,
): string {
  if (call.arguments.length !== 1) throw new AuditError(STATIC_LOADER_ARGUMENT);
  const value = stringOf(call.arguments[0]);
  if (kind === 'bindings' && value === undefined) throw new AuditError(STATIC_LOADER_ARGUMENT);
  if (
    kind === 'node-gyp-build' &&
    (!identifier(call.arguments[0], '__dirname') ||
      context.bindings.lookup(call, '__dirname') !== undefined ||
      !context.bindings.unmodified(call, '__dirname', false))
  )
    throw new AuditError(STATIC_LOADER_ARGUMENT);
  return value ?? '';
}

async function loaderNative(
  call: Call,
  context: NativeOperationContext,
): Promise<Candidate | undefined> {
  if (call.callee.type !== 'CallExpression') return undefined;
  const kind = required(call.callee);
  if (!isNativeLoader(kind)) return undefined;
  if (!globalRequire(call.callee, context)) return undefined;
  if (context.guards.has(call.start))
    throw new AuditError(
      'A guarded native loader is ambiguous; refusing automatic backend selection',
    );
  const selected = await nativeLoaderBinary({
    kind,
    value: loaderArgument(call, kind, context),
    importer: context.importer,
    traces: context.traces,
  });
  return { kind, binary: selected.binary, loaderSources: selected.sources };
}

function isNativeLoader(value: string | undefined): value is 'bindings' | 'node-gyp-build' {
  return ['bindings', 'node-gyp-build'].includes(value ?? '');
}

function namesNativeFile(value: string | undefined): boolean {
  return value?.endsWith('.node') === true;
}

/** Keep non-loading AST nodes off the asynchronous filesystem proof path. */
export function isNativeOperation(node: Node, bindings: NativeBindings): boolean {
  if (node.type === 'ImportDeclaration') return namesNativeFile(stringOf(node.source));
  if (node.type === 'ImportExpression') return namesNativeFile(stringOf(node.source));
  if (node.type !== 'CallExpression') return false;
  if (namesNativeFile(required(node))) return true;
  if (node.callee.type === 'CallExpression') return isNativeLoader(required(node.callee));
  return processDlopen(node.callee, bindings) !== undefined;
}

function assertDlopenArguments(call: Call, context: NativeOperationContext): void {
  if (context.bindings.moduleSyntax || context.importer.endsWith('.mjs'))
    throw new AuditError(
      'ES module native loaders require explicitly proved module and directory objects; this operand form is unsupported',
    );
  const moduleKnown =
    identifier(call.arguments[0], 'module') &&
    context.bindings.lookup(call, 'module') === undefined &&
    context.bindings.unmodified(call, 'module', false);
  const directoryKnown =
    context.bindings.lookup(call, '__dirname') === undefined &&
    context.bindings.unmodified(call, '__dirname', false);
  if (!moduleKnown || !directoryKnown || call.arguments.length !== DLOPEN_ARGUMENTS)
    throw new AuditError(
      'custom process.dlopen flags, shadowed module objects or directories are unsupported',
    );
}

function dlopenNative(call: Call, context: NativeOperationContext): Candidate | undefined {
  const origin = processDlopen(call.callee, context.bindings);
  if (origin === undefined) return undefined;
  if (origin === 'ambiguous')
    throw new AuditError('An ambiguous or modified process loader cannot be classified');
  if (context.guards.get(call.start) === 'plain') {
    if (context.nodeTarget)
      throw new AuditError('A guarded process.dlopen is unclassified on the Node target');
    return undefined;
  }
  if (context.guards.has(call.start))
    throw new AuditError('A guarded process.dlopen has no proved Worker-safe fallback');
  assertDlopenArguments(call, context);
  const binary = nativePath(call.arguments[1], context.importer, context.bindings);
  if (!binary?.endsWith('.node'))
    throw new AuditError('process.dlopen has no statically known native binary');
  return { kind: 'dlopen', binary };
}

async function callNative(
  call: Call,
  context: NativeOperationContext,
): Promise<NativeLoad | undefined> {
  const candidate =
    directNative(call, context) ??
    (await loaderNative(call, context)) ??
    dlopenNative(call, context);
  if (candidate === undefined) return undefined;
  const owners = await ownedBinary(candidate.binary, context.importer, context.traces);
  return { ...candidate, importer: context.importer, owners };
}

async function importNative(
  specifier: string,
  context: NativeOperationContext,
): Promise<NativeLoad> {
  const binary = createRequire(context.importer).resolve(specifier);
  const owners = await ownedBinary(binary, context.importer, context.traces);
  return { kind: 'direct', importer: context.importer, binary, owners, esm: true };
}

function declarationSource(
  node: Extract<Node, { type: 'ImportDeclaration' }>,
  proof: string,
  local: string,
): string {
  const declarations = node.specifiers.map(
    (specifier) => `const ${specifier.local.name}=${local}${importMember(specifier)};`,
  );
  return `const ${local}=${proof};${declarations.join('')}`;
}

function importMember(specifier: Node): string {
  if (specifier.type !== 'ImportSpecifier') return '';
  const name =
    specifier.imported.type === 'Identifier'
      ? specifier.imported.name
      : stringOf(specifier.imported);
  if (name === undefined) throw new AuditError('Native import has an unknown exported member');
  return `[${JSON.stringify(name)}]`;
}

async function operationSource(
  node: Node,
  context: NativeOperationContext,
  local: () => string,
): Promise<string | undefined> {
  if (node.type === 'ImportDeclaration') {
    const source = stringOf(node.source);
    if (!source?.endsWith('.node')) return undefined;
    const proof = context.mark(await importNative(source, context));
    return declarationSource(node, proof, local());
  }
  if (node.type === 'ImportExpression') {
    const specifier = stringOf(node.source);
    if (!specifier?.endsWith('.node')) return undefined;
    return `Promise.resolve(${context.mark(await importNative(specifier, context))})`;
  }
  if (node.type !== 'CallExpression') return undefined;
  const load = await callNative(node, context);
  return load === undefined ? undefined : context.mark(load);
}

/** Refusals are deferred until their operation survives tree shaking, as the proof requires. */
export async function nativeOperationEdit(
  node: Node,
  context: NativeOperationContext,
  local: () => string,
): Promise<NativeEdit | undefined> {
  try {
    const text = await operationSource(node, context, local);
    return text === undefined ? undefined : { start: node.start, end: node.end, text };
  } catch (error) {
    if (error instanceof UnreviewedNativeLoaderError) return undefined;
    if (!(error instanceof Error)) throw error;
    const text = context.mark(error) + (node.type === 'ImportDeclaration' ? ';' : '');
    return { start: node.start, end: node.end, text };
  }
}
