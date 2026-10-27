import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';

const SCOPE: unique symbol = Symbol('original Node mode scope');
const MODE: unique symbol = Symbol('original CommonJS goal');
const MAX_SOURCE_BYTES = 134_217_728;
const MAX_PACKAGE_BYTES = 65_536;
export interface OriginalNodeModeScope {
  readonly [SCOPE]: true;
}
export interface OriginalCommonJsMode {
  readonly [MODE]: true;
}
export interface OriginalNodeModeSource {
  readonly file: string;
  readonly sha256: string;
}
export interface OriginalNodeModeGraph {
  readonly sources: ReadonlyMap<string, OriginalNodeModeSource>;
  readonly retained: ReadonlySet<string>;
}
interface Row {
  readonly id: string;
  readonly original: OriginalNodeModeSource;
  readonly file: string;
  readonly sha256: string;
}
interface Roots {
  readonly root: string;
  readonly project: string;
  readonly dist: string;
}
type CanonicalRoots = Omit<Roots, 'dist'> & { readonly dist: string | undefined };
export interface OriginalNodeModeWitness {
  readonly source: OriginalNodeModeSource;
  readonly kind: 'cjs-extension' | 'explicit-package-commonjs';
  readonly missing: readonly string[];
  readonly metadata?: OriginalNodeModeSource;
}
interface UsedMode {
  readonly proof: OriginalCommonJsMode;
  readonly witness: OriginalNodeModeWitness;
}
interface Stored {
  readonly graph: OriginalNodeModeGraph;
  readonly sources: OriginalNodeModeGraph['sources'];
  readonly retained: OriginalNodeModeGraph['retained'];
  readonly rows: ReadonlyMap<string, Row>;
  readonly declared: Roots;
  readonly canonical: CanonicalRoots;
  readonly used: Map<string, UsedMode>;
  finalized?: readonly (readonly [string, UsedMode])[];
}
const SCOPES = new WeakMap<OriginalNodeModeScope, Stored>();
const MODES = new WeakMap<
  OriginalCommonJsMode,
  { readonly scope: OriginalNodeModeScope; readonly id: string; readonly row: Row }
>();
export function originalNodeModeHash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}
function fail(reason: string): never {
  throw new AuditError(`Unproved original CommonJS goal: ${reason}`);
}
function beneath(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ? relative
    : undefined;
}
function stored(scope: OriginalNodeModeScope): Stored {
  return SCOPES.get(scope) ?? fail('copied or missing scope');
}
/** The physical goal belongs to this exact original graph, never a structural graph copy. */
export function assertOriginalNodeModesGraph(
  scope: OriginalNodeModeScope,
  graph: OriginalNodeModeGraph,
): void {
  const own = stored(scope);
  if (own.graph !== graph || graph.sources !== own.sources || graph.retained !== own.retained)
    fail('foreign or changed original source graph');
}
class GoalUnavailableError extends Error {
  override name = 'GoalUnavailableError';
}
async function bytes(file: string, maximum = MAX_SOURCE_BYTES): Promise<Uint8Array> {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maximum ||
    (await realpath(file)) !== file
  )
    fail('noncanonical or unbounded regular file');
  const value = new Uint8Array(await readFile(file));
  if (value.byteLength !== info.size) fail('file changed while read');
  return value;
}
async function metadataBytes(file: string): Promise<Uint8Array> {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_PACKAGE_BYTES ||
    (await realpath(file)) !== file
  )
    throw new GoalUnavailableError('unsupported nearest metadata file');
  const value = new Uint8Array(await readFile(file));
  if (value.byteLength !== info.size)
    throw new GoalUnavailableError('unstable nearest metadata file');
  return value;
}
async function rootsCurrent(own: Stored): Promise<void> {
  for (const key of ['root', 'project'] as const)
    if ((await realpath(own.declared[key])) !== own.canonical[key]) fail('root changed');
  if (
    own.canonical.dist !== undefined &&
    (await realpath(own.declared.dist)) !== own.canonical.dist
  )
    fail('root changed');
}
function rowCurrent(own: Stored, id: string, source?: OriginalNodeModeSource): Row {
  const row = own.rows.get(id);
  if (
    row === undefined ||
    own.graph.sources !== own.sources ||
    own.graph.retained !== own.retained ||
    own.sources.get(id) !== row.original ||
    !own.retained.has(id) ||
    row.original.file !== row.file ||
    row.original.sha256 !== row.sha256 ||
    (source !== undefined && source !== row.original)
  )
    fail('graph or source identity changed');
  return row;
}
function explicitCommonJs(value: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    const metadata: unknown = JSON.parse(text);
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata) ||
      !Object.hasOwn(metadata, 'type') ||
      Reflect.get(metadata, 'type') !== 'commonjs'
    )
      return false;
    const parsed = parseAst(`(${text})`);
    const expression =
      parsed.body[0]?.type === 'ExpressionStatement' ? parsed.body[0].expression : undefined;
    if (expression?.type !== 'ObjectExpression') return false;
    return (
      expression.properties.filter((property) => {
        return (
          property.type === 'Property' &&
          property.key.type === 'Literal' &&
          property.key.value === 'type'
        );
      }).length === 1
    );
  } catch {
    return false;
  }
}
type Observation = { readonly witness: OriginalNodeModeWitness } | { readonly unknown: string };
function sourceBoundary(own: Stored, file: string): string {
  if (beneath(own.canonical.root, file) !== undefined) return own.canonical.root;
  if (own.canonical.dist !== undefined && beneath(own.canonical.dist, file) !== undefined)
    return own.canonical.dist;
  return fail('source escapes both owned roots');
}
type MetadataObservation =
  | { readonly bytes: Uint8Array }
  | { readonly unknown: string }
  | undefined;
async function scopeMetadata(file: string): Promise<MetadataObservation> {
  try {
    return { bytes: await metadataBytes(file) };
  } catch (error) {
    if (error instanceof GoalUnavailableError) return { unknown: error.message };
    if (error instanceof Error && 'code' in error) {
      if (['EACCES', 'ELOOP', 'ENOTDIR', 'EPERM'].includes(String(error.code)))
        return { unknown: 'nearest metadata is unavailable' };
      if (error.code === 'ENOENT') return undefined;
    }
    throw error;
  }
}
async function observeJsScope(
  row: Row,
  source: OriginalNodeModeSource,
  boundary: string,
): Promise<Observation> {
  const missing: string[] = [];
  for (
    let dir = path.dirname(row.file);
    beneath(boundary, dir) !== undefined && path.basename(dir) !== 'node_modules';
    dir = path.dirname(dir)
  ) {
    if ((await realpath(dir)) !== dir) fail('scope directory changed');
    const file = path.join(dir, 'package.json');
    const metadata = await scopeMetadata(file);
    if (metadata === undefined) {
      missing.push(file);
      if (dir === boundary) break;
      continue;
    }
    if ('unknown' in metadata) return metadata;
    if (!explicitCommonJs(metadata.bytes))
      return { unknown: 'nearest scope lacks unique explicit commonjs type' };
    return {
      witness: Object.freeze({
        source: Object.freeze(source),
        kind: 'explicit-package-commonjs',
        missing: Object.freeze(missing),
        metadata: Object.freeze({ file, sha256: originalNodeModeHash(metadata.bytes) }),
      }),
    };
  }
  return { unknown: 'no owned explicit scope before boundary' };
}
async function observe(own: Stored, row: Row): Promise<Observation> {
  await rootsCurrent(own);
  const boundary = sourceBoundary(own, row.file);
  const source = { file: row.file, sha256: originalNodeModeHash(await bytes(row.file)) };
  if (source.sha256 !== row.sha256) fail('source bytes changed');
  if (row.file.endsWith('.cjs'))
    return {
      witness: Object.freeze({
        source: Object.freeze(source),
        kind: 'cjs-extension',
        missing: Object.freeze([]),
      }),
    };
  if (row.file.endsWith('.js')) return observeJsScope(row, source, boundary);
  return { unknown: 'unsupported extension' };
}
async function canonicalDist(file: string): Promise<string | undefined> {
  try {
    return await realpath(file);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return undefined;
  }
}
/** Conditional target contract: fixed standard node-container loader only. No flags can mint it. */
export async function prepareOriginalNodeModes(
  input: { readonly rootDir: string; readonly projectDir: string; readonly distDir: string },
  graph: OriginalNodeModeGraph,
  physicalIds: readonly string[],
): Promise<OriginalNodeModeScope> {
  const declared = Object.freeze({
    root: path.resolve(input.rootDir),
    project: path.resolve(input.projectDir),
    dist: path.resolve(input.distDir),
  });
  const sources = graph.sources;
  const retained = graph.retained;
  const rows = new Map(
    physicalIds.map((id) => {
      const source = sources.get(id);
      if (source === undefined || !retained.has(id)) fail('missing original descriptor');
      return [
        id,
        Object.freeze({ id, original: source, file: source.file, sha256: source.sha256 }),
      ] as const;
    }),
  );
  const canonical = Object.freeze({
    root: await realpath(declared.root),
    project: await realpath(declared.project),
    dist: await canonicalDist(declared.dist),
  });
  if (beneath(canonical.root, canonical.project) === undefined) fail('project outside trace root');
  const scope = Object.freeze<OriginalNodeModeScope>({ [SCOPE]: true });
  SCOPES.set(scope, { graph, sources, retained, rows, declared, canonical, used: new Map() });
  return scope;
}
/** Candidate DATA does not mark a mode used and cannot be supplied to useOriginalCommonJsMode. */
export async function inspectOriginalNodeMode(
  scope: OriginalNodeModeScope,
  id: string,
): Promise<
  | { readonly kind: 'commonjs-candidate'; readonly basis: OriginalNodeModeWitness['kind'] }
  | { readonly kind: 'unknown'; readonly reason: string }
> {
  const own = stored(scope);
  const row = rowCurrent(own, id);
  const result = await observe(own, row);
  rowCurrent(own, id);
  return Object.freeze(
    'witness' in result
      ? { kind: 'commonjs-candidate', basis: result.witness.kind }
      : { kind: 'unknown', reason: result.unknown },
  );
}
export async function useOriginalCommonJsMode(
  scope: OriginalNodeModeScope,
  id: string,
  source: OriginalNodeModeSource,
): Promise<OriginalCommonJsMode | undefined> {
  const own = stored(scope);
  const row = rowCurrent(own, id, source);
  if (own.finalized !== undefined && !own.used.has(id)) fail('used ledger finalized');
  const result = await observe(own, row);
  rowCurrent(own, id, source);
  const previous = own.used.get(id);
  // A use started before finalization may still be awaiting its filesystem observation.
  if (previous === undefined && own.finalized !== undefined) fail('used ledger finalized');
  if (!('witness' in result)) {
    if (previous !== undefined) fail('used scope no longer CommonJS');
    return undefined;
  }
  if (previous !== undefined) {
    if (JSON.stringify(previous.witness) !== JSON.stringify(result.witness))
      fail('used scope changed');
    return previous.proof;
  }
  const proof = Object.freeze<OriginalCommonJsMode>({ [MODE]: true });
  MODES.set(proof, Object.freeze({ scope, id, row }));
  own.used.set(id, Object.freeze({ proof, witness: result.witness }));
  return proof;
}
export async function assertOriginalCommonJsMode(
  proof: OriginalCommonJsMode,
  scope: OriginalNodeModeScope,
  id: string,
  source: OriginalNodeModeSource,
): Promise<void> {
  const known = MODES.get(proof);
  const own = stored(scope);
  if (known?.scope !== scope || known.id !== id || known.row !== rowCurrent(own, id, source))
    fail('copied or retargeted mode');
  if ((await useOriginalCommonJsMode(scope, id, source)) !== proof)
    fail('mode no longer supported');
}
export function originalNodeModeMetadata(
  scope: OriginalNodeModeScope,
): readonly OriginalNodeModeSource[] {
  const files = new Map<string, OriginalNodeModeSource>();
  for (const { witness } of stored(scope).used.values()) {
    if (witness.metadata === undefined) continue;
    const previous = files.get(witness.metadata.file);
    if (previous !== undefined && previous.sha256 !== witness.metadata.sha256)
      fail('conflicting used metadata');
    files.set(witness.metadata.file, witness.metadata);
  }
  return Object.freeze([...files.values()]);
}
export function originalNodeModeProofFiles(
  scope: OriginalNodeModeScope,
): readonly OriginalNodeModeSource[] {
  return Object.freeze([
    ...[...stored(scope).used.values()].map(({ witness }) => witness.source),
    ...originalNodeModeMetadata(scope),
  ]);
}
/** Close the private inventory synchronously, once, before final archive validation can await. */
export function closeOriginalNodeModes(
  scope: OriginalNodeModeScope,
): readonly (readonly [string, UsedMode])[] {
  const own = stored(scope);
  own.finalized ??= Object.freeze([...own.used].map((entry) => Object.freeze(entry)));
  return own.finalized;
}
export async function currentOriginalNodeModes(
  scope: OriginalNodeModeScope,
): Promise<readonly OriginalNodeModeWitness[]> {
  const own = stored(scope);
  const values = closeOriginalNodeModes(scope);
  for (const [id, { proof }] of values)
    await assertOriginalCommonJsMode(proof, scope, id, rowCurrent(own, id).original);
  return Object.freeze(values.map(([, value]) => value.witness));
}
export function originalNodeModeArchiveName(scope: OriginalNodeModeScope, file: string): string {
  const roots = stored(scope).canonical;
  const relative = beneath(roots.root, file);
  if (relative !== undefined) return path.posix.join('project', relative.split(path.sep).join('/'));
  const built = roots.dist === undefined ? undefined : beneath(roots.dist, file);
  if (built === undefined) fail('unowned archive coordinate');
  const project = beneath(roots.root, roots.project);
  if (project === undefined) fail('project coordinate changed');
  return path.posix.join(
    'project',
    project.split(path.sep).join('/'),
    '.upwind-build',
    built.split(path.sep).join('/'),
  );
}

/** Only sources copied for raw execution consume mode facts; bundled-only hooks stay unclaimed. */
export async function usePhysicalOriginalNodeModes(
  scope: OriginalNodeModeScope,
  sourcePaths: ReadonlyMap<string, string>,
): Promise<void> {
  const own = stored(scope);
  const physical = new Set(sourcePaths.values());
  for (const [id, row] of own.rows) {
    if (physical.has(row.file)) await useOriginalCommonJsMode(scope, id, row.original);
  }
}
