import { createHash } from 'node:crypto';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import { isNode, listOf } from './lexical-scope.ts';
import { identifier, stringOf } from './node-manifest-consumer-ast.ts';

const MAX_RUNTIME_BYTES = 131_072;
const CONFIGURATION_STATEMENTS = 3;
const MAX_CONFIG_STRING_CHARACTERS = 4096;
const REVIEWED_RUNTIME = Symbol('reviewed Next.js Node production runtime');
// Normalized whole-body AST fingerprints from fixed Next.js 16.4.3 / 29bbeab09981148ade186e8599ecdede15abc281.
// The primary Node snapshot supplies the body. The exact shared async-module block may be
// inserted at the one position specified by nodejs_runtime.rs. Parsed using pinned Rolldown 1.2.15.
const REVIEWED_BODIES: ReadonlyMap<string, boolean> = new Map([
  ['940f4e1becca78a27a4773bf7517dd432909ed5db926aedc82857cc0379c82b6', false],
  ['bc70d80ec247f42eba92cc0376770310bf96aade6ceeefdcb44bcac0ce51edff', true],
  ['0ec227e1c5e05e7469cde4e6703b36e121c5f0cf7747b9e24b3320a772d70494', true],
]);
// The sole optional preamble written by node/entry/runtime.rs when forwarded globals are configured.
// This is inert syntax, never evaluated by the verifier.
const FORWARDED_GLOBALS = `if (typeof require !== 'undefined') {
  try {
    var { workerData } = require('worker_threads');
    if (workerData?.__turbopack_globals__) {
      Object.assign(globalThis, workerData.__turbopack_globals__);
      delete workerData.__turbopack_globals__;
    }
  } catch (_) {}
}`;

export interface NodeManifestTurbopackRuntimeInput {
  readonly source: { readonly code: string; readonly sha256: string };
  /** Canonical physical runtime and the compiler's trusted output/root coordinates. */
  readonly file: string;
  readonly distDir: string;
  readonly rootDir: string;
  readonly assetPrefix?: string | undefined;
}
export interface NodeManifestTurbopackRuntimeProof {
  readonly [REVIEWED_RUNTIME]: true;
  readonly file: string;
  readonly sha256: string;
  readonly runtimeRoot: string;
  readonly rootDir: string;
  readonly assetPrefix: string;
  readonly asyncModules: boolean;
}
function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js Turbopack runtime ${reason}; refusing native publication`);
}
function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function astShape(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    return key === 'start' || key === 'end' || key === 'raw' ? undefined : item;
  });
}
function statements(code: string): readonly unknown[] {
  try {
    const program: unknown = parseAst(code);
    if (!isNode(program) || program.type !== 'Program') return refuse('program');
    return listOf(program, 'body');
  } catch (error) {
    if (error instanceof AuditError) throw error;
    return refuse('syntax');
  }
}
function configuration(node: unknown, name: string): string {
  if (!isNode(node) || node.type !== 'VariableDeclaration' || node['kind'] !== 'var')
    return refuse('compiler preamble');
  const declarations = listOf(node, 'declarations');
  const declaration = declarations[0];
  if (declarations.length !== 1 || !isNode(declaration) || !identifier(declaration['id']) ||
    declaration['id'].name !== name) return refuse('compiler preamble binding');
  const initial = declaration['init'];
  if (!isNode(initial) || initial.type !== 'Literal') return refuse('compiler preamble literal');
  const value = stringOf(initial);
  if (value === undefined || value.length > MAX_CONFIG_STRING_CHARACTERS || value.includes('\0'))
    return refuse('compiler preamble value');
  return value;
}
function runtimeBody(body: readonly unknown[]): readonly unknown[] {
  const first = body[0];
  if (isNode(first) && first.type === 'IfStatement') {
    const expected = statements(FORWARDED_GLOBALS)[0];
    if (astShape(first) !== astShape(expected)) return refuse('forwarded globals preamble');
    return body.slice(1);
  }
  return body;
}
function configPaths(input: NodeManifestTurbopackRuntimeInput, body: readonly unknown[]): {
  readonly runtimeRoot: string; readonly rootDir: string; readonly assetPrefix: string;
} {
  if (!path.isAbsolute(input.file) || !path.isAbsolute(input.distDir) || !path.isAbsolute(input.rootDir))
    return refuse('physical runtime coordinates');
  const runtimeRoot = path.resolve(input.distDir);
  const rootDir = path.resolve(input.rootDir);
  const publicPath = configuration(body[0], 'RUNTIME_PUBLIC_PATH');
  const relativeRoot = configuration(body[1], 'RELATIVE_ROOT_PATH');
  const assetPrefix = configuration(body[2], 'ASSET_PREFIX');
  const expectedPublicPath = beneath(runtimeRoot, path.resolve(input.file))?.split(path.sep).join('/');
  if (expectedPublicPath === undefined || expectedPublicPath === '' || publicPath !== expectedPublicPath)
    return refuse('runtime public path');
  if (relativeRoot !== path.relative(runtimeRoot, rootDir).split(path.sep).join('/'))
    return refuse('compiler root path');
  // Mirror the pinned producer runtime's __filename-based computation, not a path-name heuristic.
  if (path.resolve(input.file, path.relative(publicPath, '.')) !== runtimeRoot ||
    path.resolve(runtimeRoot, relativeRoot) !== rootDir) return refuse('runtime root resolution');
  if (assetPrefix !== (input.assetPrefix ?? '/')) return refuse('asset prefix');
  return { runtimeRoot, rootDir, assetPrefix };
}

/** Seal the complete unmodified production runtime before interpreting any context method. */
export function assertNodeManifestTurbopackRuntime(
  input: NodeManifestTurbopackRuntimeInput,
): NodeManifestTurbopackRuntimeProof {
  if (Buffer.byteLength(input.source.code) > MAX_RUNTIME_BYTES ||
    digest(input.source.code) !== input.source.sha256) refuse('source byte identity or bounds');
  const body = statements(input.source.code);
  const coordinates = configPaths(input, body);
  const fingerprint = digest(astShape(runtimeBody(body.slice(CONFIGURATION_STATEMENTS))));
  const asyncModules = REVIEWED_BODIES.get(fingerprint);
  if (asyncModules === undefined) return refuse('changed production context semantics');
  return Object.freeze<NodeManifestTurbopackRuntimeProof>({
    [REVIEWED_RUNTIME]: true,
    file: path.resolve(input.file),
    sha256: input.source.sha256,
    ...coordinates,
    asyncModules,
  });
}
