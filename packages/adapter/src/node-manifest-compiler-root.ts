import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';

const ROOT: unique symbol = Symbol('persisted compiler root basis');
const METADATA = 'required-server-files.json';
const MAX_METADATA_BYTES = 4_194_304;
const MAX_PATH_CHARACTERS = 4096;
const MAX_METADATA_NODES = 100_000;
const MAX_METADATA_DEPTH = 128;
const MAX_MANIFEST_PATHS = 100_000;
export interface NodeManifestCompilerRootInput {
  readonly distDir: string;
  readonly projectDir: string;
}
export interface NodeManifestCompilerRootProof {
  readonly [ROOT]: true;
}
/** Exact opaque token plus its original input object; equal JSON is not a binding. */
export interface NodeManifestCompilerRootBinding {
  readonly proof: NodeManifestCompilerRootProof;
  readonly input: NodeManifestCompilerRootInput;
}
export interface NodeManifestCompilerRootData {
  readonly kind: 'persisted build compiler root';
  readonly basis: 'turbopack.root' | 'outputFileTracingRoot' | 'appDir';
  readonly compilerRoot: string;
  readonly canonicalCompilerRoot: string;
  readonly projectDir: string;
  readonly canonicalProjectDir: string;
  readonly appDir: string;
  readonly distDir: string;
  readonly canonicalDistDir: string;
  readonly metadata: { readonly file: string; readonly sha256: string };
}
interface DirectoryIdentity {
  readonly declared: string;
  readonly canonical: string;
  readonly identity: string;
}
interface Inspection {
  readonly data: NodeManifestCompilerRootData;
  readonly identities: readonly string[];
}
interface Stored {
  readonly input: NodeManifestCompilerRootInput;
  readonly captured: NodeManifestCompilerRootInput;
  readonly inspection: Inspection;
}
const PROOFS = new WeakMap<NodeManifestCompilerRootProof, Stored>();

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js compiler root ${reason}; refusing path basis`);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || value.length > 0) &&
    value.length <= MAX_PATH_CHARACTERS &&
    !value.includes('\0') &&
    !value.includes('\\')
  );
}
function absolute(value: unknown): value is string {
  return text(value) && path.isAbsolute(value);
}
function captured(input: NodeManifestCompilerRootInput): NodeManifestCompilerRootInput {
  const dist = Object.getOwnPropertyDescriptor(input, 'distDir');
  const project = Object.getOwnPropertyDescriptor(input, 'projectDir');
  if (
    dist === undefined ||
    project === undefined ||
    !('value' in dist) ||
    !('value' in project) ||
    !absolute(dist.value) ||
    !absolute(project.value)
  )
    refuse('absolute input paths');
  return Object.freeze({ distDir: dist.value, projectDir: project.value });
}
function assertInput(
  input: NodeManifestCompilerRootInput,
  snapshot: NodeManifestCompilerRootInput,
): void {
  const actual = captured(input);
  if (actual.distDir !== snapshot.distDir || actual.projectDir !== snapshot.projectDir)
    refuse('changed input paths');
}
async function stable<T>(
  input: Stored['input'],
  snapshot: Stored['captured'],
  operation: Promise<T>,
): Promise<T> {
  assertInput(input, snapshot);
  try {
    return await operation;
  } finally {
    assertInput(input, snapshot);
  }
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function directory(
  declared: string,
  input: Stored['input'],
  snapshot: Stored['captured'],
): Promise<DirectoryIdentity> {
  const canonical = await stable(input, snapshot, realpath(declared));
  const info = await stable(input, snapshot, stat(canonical));
  if (!info.isDirectory()) return refuse('directory identity');
  return Object.freeze({ declared, canonical, identity: `${info.dev}:${info.ino}` });
}
async function assertDirectories(
  known: readonly DirectoryIdentity[],
  input: Stored['input'],
  snapshot: Stored['captured'],
): Promise<void> {
  for (const original of known) {
    const actual = await directory(original.declared, input, snapshot);
    if (actual.canonical !== original.canonical || actual.identity !== original.identity)
      refuse('directory changed while sealing');
  }
}
function children(node: Node): readonly Node[] {
  return Object.values(node).flatMap((child) =>
    (Array.isArray(child) ? child : [child]).filter(isNode),
  );
}
function uniqueObject(node: Node): void {
  const names = new Set<string>();
  for (const item of listOf(node, 'properties')) {
    const key = isNode(item) ? item['key'] : undefined;
    if (
      !isNode(item) ||
      item.type !== 'Property' ||
      !isNode(key) ||
      key.type !== 'Literal' ||
      typeof key['value'] !== 'string' ||
      names.has(key['value'])
    )
      refuse('duplicate metadata fields');
    names.add(key['value']);
  }
}
function jsonObject(code: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch {
    return refuse('metadata JSON');
  }
  if (!record(value)) return refuse('metadata object');
  const parsed: unknown = parseAst(`(${code});`);
  if (!isNode(parsed)) return refuse('metadata syntax');
  const pending = [{ node: parsed, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    count += 1;
    if (count > MAX_METADATA_NODES || next.depth > MAX_METADATA_DEPTH)
      refuse('metadata AST bounds');
    if (next.node.type === 'ObjectExpression') uniqueObject(next.node);
    for (const node of children(next.node)) pending.push({ node, depth: next.depth + 1 });
  }
  return value;
}
function paths(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.length <= MAX_MANIFEST_PATHS && value.every((item) => text(item))
  );
}
function optionalRoot(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  return absolute(value) ? value : refuse('config root path');
}
interface Selection {
  readonly appDir: string;
  readonly buildDistDir: string;
  readonly compilerRoot: string;
  readonly basis: NodeManifestCompilerRootData['basis'];
}
function buildMetadata(metadata: Record<string, unknown>, project: DirectoryIdentity) {
  const config = metadata['config'];
  if (
    metadata['version'] !== 1 ||
    !record(config) ||
    !absolute(metadata['appDir']) ||
    metadata['appDir'] !== project.canonical ||
    !text(metadata['relativeAppDir'], true) ||
    !paths(metadata['files']) ||
    !paths(metadata['ignore'])
  )
    refuse('build metadata shape or appDir');
  return {
    config,
    appDir: metadata['appDir'],
    relativeAppDir: metadata['relativeAppDir'],
    files: metadata['files'],
  };
}
function assertBuildMode(config: Record<string, unknown>): void {
  const experimental = config['experimental'];
  if (
    !record(experimental) ||
    typeof experimental['isExperimentalCompile'] !== 'boolean' ||
    (experimental['runtimeServerDeploymentId'] !== undefined &&
      typeof experimental['runtimeServerDeploymentId'] !== 'boolean')
  )
    refuse('build config mode');
  if (experimental['runtimeServerDeploymentId'] === true)
    refuse('filtered config omits root evidence');
}
function rootSelection(turbo: string | undefined, tracing: string | undefined, appDir: string) {
  if (turbo !== undefined) return { compilerRoot: turbo, basis: 'turbopack.root' as const };
  if (tracing !== undefined)
    return { compilerRoot: tracing, basis: 'outputFileTracingRoot' as const };
  return { compilerRoot: appDir, basis: 'appDir' as const };
}
function selection(metadata: Record<string, unknown>, project: DirectoryIdentity): Selection {
  const { config, appDir, relativeAppDir, files } = buildMetadata(metadata, project);
  assertBuildMode(config);
  const turbopack = config['turbopack'];
  if (turbopack !== undefined && !record(turbopack)) refuse('turbopack config');
  const turbo = optionalRoot(record(turbopack) ? turbopack['root'] : undefined);
  const tracing = optionalRoot(config['outputFileTracingRoot']);
  const buildDistDir = config['distDir'];
  if (
    !text(buildDistDir) ||
    relativeAppDir !== path.relative(tracing ?? appDir, appDir) ||
    !files.includes(path.join(buildDistDir, METADATA)) ||
    !files.includes(path.join(buildDistDir, 'BUILD_ID'))
  )
    refuse('build directory evidence');
  return {
    appDir,
    buildDistDir,
    ...rootSelection(turbo, tracing, appDir),
  };
}
function sameFile(a: Stats, b: Stats): boolean {
  return (
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
async function boundedBytes(
  file: string,
  before: Stats,
  input: Stored['input'],
  snapshot: Stored['captured'],
): Promise<Buffer> {
  assertInput(input, snapshot);
  const handle = await open(file, 'r');
  try {
    assertInput(input, snapshot);
    const opened = await stable(input, snapshot, handle.stat());
    if (!sameFile(before, opened)) refuse('metadata changed before reading');
    const bytes = Buffer.alloc(before.size + 1);
    const read = await stable(input, snapshot, handle.read(bytes, 0, bytes.length, 0));
    const after = await stable(input, snapshot, handle.stat());
    if (read.bytesRead !== before.size || !sameFile(before, after))
      refuse('metadata changed while reading');
    return bytes.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
    assertInput(input, snapshot);
  }
}
async function metadataSource(
  dist: DirectoryIdentity,
  input: Stored['input'],
  snapshot: Stored['captured'],
) {
  const file = path.join(dist.canonical, METADATA);
  let before: Stats;
  try {
    before = await stable(input, snapshot, lstat(file));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (!before.isFile() || before.size > MAX_METADATA_BYTES) refuse('regular bounded metadata');
  if ((await stable(input, snapshot, realpath(file))) !== file) refuse('metadata path boundary');
  const bytes = await boundedBytes(file, before, input, snapshot);
  const after = await stable(input, snapshot, lstat(file));
  if (!sameFile(before, after)) refuse('metadata changed while reading');
  const code = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(code))) refuse('metadata encoding');
  return { file, bytes, after, code };
}
async function inspect(
  input: Stored['input'],
  snapshot: Stored['captured'],
): Promise<Inspection | undefined> {
  const project = await directory(snapshot.projectDir, input, snapshot);
  let dist: DirectoryIdentity;
  try {
    dist = await directory(snapshot.distDir, input, snapshot);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const metadata = await metadataSource(dist, input, snapshot);
  if (metadata === undefined) return undefined;
  const { file, bytes, after, code } = metadata;
  const selected = selection(jsonObject(code), project);
  const output = await directory(
    path.join(selected.appDir, selected.buildDistDir),
    input,
    snapshot,
  );
  if (output.canonical !== dist.canonical) refuse('metadata output directory mismatch');
  const root = await directory(selected.compilerRoot, input, snapshot);
  if (beneath(root.canonical, project.canonical) === undefined)
    refuse('compiler root outside project scope');
  if (beneath(dist.canonical, project.canonical) !== undefined)
    refuse('output contains project directory');
  await assertDirectories([project, dist, output, root], input, snapshot);
  const final = await stable(input, snapshot, lstat(file));
  if (!sameFile(after, final)) refuse('metadata changed while sealing');
  const data = Object.freeze<NodeManifestCompilerRootData>({
    kind: 'persisted build compiler root',
    basis: selected.basis,
    compilerRoot: root.declared,
    canonicalCompilerRoot: root.canonical,
    projectDir: project.declared,
    canonicalProjectDir: project.canonical,
    appDir: selected.appDir,
    distDir: dist.declared,
    canonicalDistDir: dist.canonical,
    metadata: Object.freeze({ file, sha256: createHash('sha256').update(bytes).digest('hex') }),
  });
  return {
    data,
    identities: Object.freeze([
      project.identity,
      dist.identity,
      root.identity,
      `${after.dev}:${after.ino}`,
    ]),
  };
}

/** Persisted build path basis only; this grants no helper, VM, runtime, or constructor authority. */
export async function certifyNodeManifestCompilerRoot(
  input: NodeManifestCompilerRootInput,
): Promise<NodeManifestCompilerRootProof | undefined> {
  const snapshot = captured(input);
  const inspection = await inspect(input, snapshot);
  assertInput(input, snapshot);
  if (inspection === undefined) return undefined;
  const proof = Object.freeze<NodeManifestCompilerRootProof>({ [ROOT]: true });
  PROOFS.set(proof, { input, captured: snapshot, inspection });
  return proof;
}
function current(
  proof: NodeManifestCompilerRootProof,
  input: NodeManifestCompilerRootInput,
): Stored {
  const stored = PROOFS.get(proof);
  if (stored?.input !== input) return refuse('foreign or copied proof');
  assertInput(input, stored.captured);
  return stored;
}
/** Frozen DATA, not a filesystem freshness assertion. Revalidate after asynchronous boundaries. */
export function nodeManifestCompilerRoot(
  proof: NodeManifestCompilerRootProof,
  input: NodeManifestCompilerRootInput,
): NodeManifestCompilerRootData {
  return current(proof, input).inspection.data;
}
export async function assertCurrentNodeManifestCompilerRoot(
  proof: NodeManifestCompilerRootProof,
  input: NodeManifestCompilerRootInput,
): Promise<void> {
  const stored = current(proof, input);
  const checked = await inspect(input, stored.captured);
  current(proof, input);
  if (JSON.stringify(checked) !== JSON.stringify(stored.inspection))
    refuse('stale metadata or root identity');
}
