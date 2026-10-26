import { createHash } from 'node:crypto';

import { AuditError } from './dependencies.ts';
import type { NodeArchiveFile } from './node-archive.ts';
import {
  closeOriginalNodeModes,
  currentOriginalNodeModes,
  originalNodeModeArchiveName,
  originalNodeModeHash,
  originalNodeModeMetadata,
  originalNodeModeProofFiles,
  type OriginalNodeModeScope,
  type OriginalNodeModeSource,
  type OriginalNodeModeWitness,
} from './node-original-load-mode.ts';
import type { NodeFunctionProof } from './node-proof.ts';
import { assertRawNodeSource } from './node-source-runtime.ts';

type OriginalNodeSource = OriginalNodeModeSource;
interface CopiedNodeSources {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly nameOf: (file: string) => string;
  readonly sourceNames: ReadonlyMap<string, string>;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertCopiedSource(
  original: OriginalNodeSource,
  copied: CopiedNodeSources,
  bundledHash: string | undefined,
): void {
  if (bundledHash !== undefined) {
    if (bundledHash !== original.sha256)
      throw new AuditError('Original Node instrumentation changed after its source proof');
    if (!copied.sourceNames.has(original.file)) return;
  }
  const name = copied.sourceNames.get(original.file) ?? copied.nameOf(original.file);
  const bytes = copied.files.get(name);
  if (bytes === undefined || digest(bytes) !== original.sha256)
    throw new AuditError(
      'Original Node graph source is absent or changed in its physical artifact',
    );
  assertRawNodeSource(name, bytes);
}

/** Compare original bytes before the explicit shared-cache/instrumentation artifact rewrites. */
export function assertNodeProofFiles(
  proof: Pick<NodeFunctionProof, 'files' | 'native'>,
  physical: {
    readonly files: readonly NodeArchiveFile[];
    readonly nameOf: (file: string) => string;
    readonly sourcePaths: ReadonlyMap<string, string>;
  },
  bundledInstrumentation: ReadonlyMap<string, string>,
): void {
  const files = new Map(physical.files.map((file) => [file.name, file.bytes]));
  const sourceNames = new Map([...physical.sourcePaths].map(([name, file]) => [file, name]));
  const copied: CopiedNodeSources = { files, nameOf: physical.nameOf, sourceNames };
  const loaderFiles = new Set(
    proof.native.flatMap((load) => (load.loaderSources ?? []).map((source) => source.file)),
  );
  for (const original of proof.files) {
    // A loader executes from the physical Node graph, even if a host hook bundled it too.
    const bundledHash = loaderFiles.has(original.file)
      ? undefined
      : bundledInstrumentation.get(original.file);
    assertCopiedSource(original, copied, bundledHash);
  }
}

interface ArchiveView {
  readonly files: ReadonlyMap<string, NodeArchiveFile>;
  readonly links: readonly { readonly path: string; readonly target: string }[];
  readonly nameOf: (file: string) => string;
  readonly sourcePaths: ReadonlyMap<string, string>;
}
function fail(reason: string): never {
  throw new AuditError(`Unproved archived CommonJS goal: ${reason}`);
}
function assertWitnessCoordinates(
  scope: OriginalNodeModeScope,
  input: ArchiveView,
  witness: OriginalNodeModeWitness,
): void {
  const originals = [witness.source.file, ...witness.missing];
  if (witness.metadata !== undefined) originals.push(witness.metadata.file);
  for (const original of originals) {
    const name = originalNodeModeArchiveName(scope, original);
    if (input.nameOf(original) !== name) fail('relocation differs from canonical owned roots');
    if (input.links.some((link) => name === link.path || name.startsWith(`${link.path}/`)))
      fail('alias shadows canonical source or scope');
  }
}
function assertWitnessFiles(
  scope: OriginalNodeModeScope,
  input: ArchiveView,
  witness: OriginalNodeModeWitness,
): void {
  const source = originalNodeModeArchiveName(scope, witness.source.file);
  if (!input.files.has(source)) fail('source omitted');
  if (input.sourcePaths.get(source) !== witness.source.file)
    fail('used mode source is not a raw physical-execution source');
  for (const absent of witness.missing)
    if (input.files.has(originalNodeModeArchiveName(scope, absent)))
      fail('nearer package metadata added');
  if (witness.metadata !== undefined) {
    const value = input.files.get(originalNodeModeArchiveName(scope, witness.metadata.file));
    if (value === undefined || originalNodeModeHash(value.bytes) !== witness.metadata.sha256)
      fail('scope metadata absent or changed');
  }
}
/** Goal/scope agreement only. Existing source and certified-rewrite checks remain independent. */
export async function assertFinalOriginalNodeModes(
  scope: OriginalNodeModeScope,
  input: ArchiveView,
): Promise<void> {
  closeOriginalNodeModes(scope);
  const view = {
    files: input.files,
    links: input.links,
    nameOf: input.nameOf,
    sourcePaths: input.sourcePaths,
  };
  const witnesses = await currentOriginalNodeModes(scope);
  for (const [name, file] of view.files)
    if (name !== file.name) fail('final file map coordinates differ');
  for (const witness of witnesses) {
    assertWitnessCoordinates(scope, view, witness);
    assertWitnessFiles(scope, view, witness);
  }
}

function mergeSources(
  sources: readonly OriginalNodeModeSource[],
): readonly OriginalNodeModeSource[] {
  const files = new Map<string, OriginalNodeModeSource>();
  for (const source of sources) {
    const previous = files.get(source.file);
    if (previous !== undefined && previous.sha256 !== source.sha256)
      throw new AuditError('Original Node mode metadata conflicts with an existing source proof');
    files.set(source.file, source);
  }
  return [...files.values()];
}

/** Include only metadata from USED physical modes, with existing source digests unchanged. */
export function nodeOriginalModeMetadata(
  scope: OriginalNodeModeScope,
  sources: readonly OriginalNodeModeSource[] = [],
): readonly OriginalNodeModeSource[] {
  return mergeSources([...sources, ...originalNodeModeMetadata(scope)]);
}

export function nodeOriginalModeProofFiles(
  scope: OriginalNodeModeScope,
  sources: readonly OriginalNodeModeSource[],
): readonly OriginalNodeModeSource[] {
  return mergeSources([...sources, ...originalNodeModeProofFiles(scope)]);
}
