import { createHash } from 'node:crypto';

import { AuditError } from './dependencies.ts';
import type { NodeArtifactFiles } from './node-artifact-files.ts';
import {
  nodeJwtCompilerMetadata,
  nodeJwtGuardRecord,
  type NodeJwtCompilerProof,
  type NodeJwtGuardRecord,
} from './node-jwt-compiler-proof.ts';
import { nodeJwtRequireOnly } from './node-jwt-compiler-sites.ts';
import { nodeJwtCallerPolicyArchiveInspection } from './node-jwt-unused-cache-import.ts';
import {
  nodeNextRequireHookMetadata,
  nodeNextRequireHookGuardRecord,
  type NodeNextRequireHookProof,
  type NodeNextRequireHookGuardRecord,
} from './node-next-require-hook-proof.ts';
import {
  rewriteCertifiedNodeNextFile,
  type NodeNextRewriteProof,
} from './node-next-rewrite-proof.ts';
import { nodeProofSource } from './node-proof.ts';
import { nodeWsOptionalArchiveRefusal } from './node-ws-archive-absence.ts';
import {
  nodeWsLoaderMetadata,
  nodeWsGuardRecord,
  type NodeWsLoaderProof,
  type NodeWsGuardRecord,
} from './node-ws-loader-proof.ts';

export type NodeInitializationGuardRecord = NodeJwtGuardRecord | NodeWsGuardRecord;

export interface NodeNextRequireHookArchive {
  readonly record: NodeNextRequireHookGuardRecord;
  readonly aliases: readonly { readonly request: string; readonly target: string }[];
  readonly sharedRuntimeEdges: readonly {
    readonly caller: string;
    readonly specifier: string;
    readonly target: string;
  }[];
}

function refuse(reason: string): never {
  throw new AuditError(`Unproved archived Node dependency initialization: ${reason}`);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function coordinate(files: NodeArtifactFiles, physical: string): string {
  const name = files.physical.nameOf(physical);
  if (files.physical.links.some((link) => name === link.path || name.startsWith(`${link.path}/`)))
    refuse('alias shadows canonical source or package scope');
  return name;
}

async function assertCaller(
  caller: Awaited<ReturnType<typeof nodeJwtCompilerMetadata>>['callers'][number],
  files: NodeArtifactFiles,
  rewrites: NodeNextRewriteProof | undefined,
): Promise<void> {
  const name = coordinate(files, caller.file);
  const bytes = files.files.get(name)?.bytes;
  if (bytes === undefined || files.physical.sourcePaths.get(name) !== caller.file)
    refuse('literal CommonJS caller is not a physical source');
  if (digest(bytes) !== caller.sha256) {
    const original = await nodeProofSource(caller.file);
    if (digest(original) !== caller.sha256) refuse('original caller changed');
    const expected = rewriteCertifiedNodeNextFile(rewrites, files.input, {
      file: caller.file,
      name,
      code: original.toString('utf8'),
    });
    if (expected === undefined || Buffer.from(bytes).toString('utf8') !== expected)
      refuse('caller changed without its existing exact rewrite certificate');
  }
  const code = Buffer.from(bytes).toString('utf8');
  const inspection =
    caller.policy === undefined
      ? code
      : nodeJwtCallerPolicyArchiveInspection(caller.policy, {
          rewrites,
          input: files.input,
          file: caller.file,
          name,
          code,
        });
  if (caller.specifiers.some((specifier) => !nodeJwtRequireOnly(inspection, specifier)))
    refuse('archived caller lost its literal CommonJS load role');
}

/** Rewrites and generated metadata must not change the qualified physical initialization. */
export async function archivedNodeJwtGuardRecords(
  proof: NodeJwtCompilerProof | undefined,
  files: NodeArtifactFiles,
  rewrites: NodeNextRewriteProof | undefined,
  ws?: NodeWsLoaderProof,
): Promise<readonly NodeInitializationGuardRecord[]> {
  const profiles = [
    ...(proof === undefined ? [] : [await nodeJwtCompilerMetadata(proof)]),
    ...(ws === undefined ? [] : [await nodeWsLoaderMetadata(ws)]),
  ];
  for (const metadata of profiles) await assertMetadata(metadata, files, rewrites);
  const records = [
    ...(proof === undefined ? [] : [await nodeJwtGuardRecord(proof, files.physical.nameOf)]),
    ...(ws === undefined ? [] : [await nodeWsGuardRecord(ws, files.physical.nameOf)]),
  ];
  for (const record of records) {
    const bytes = files.files.get(record.archivePath)?.bytes;
    if (bytes?.byteLength !== record.bytes || digest(bytes) !== record.sha256)
      refuse('guard record does not describe the final physical source');
    if (record.profile === 'next-16.4.3-ws-ncc-v1') {
      const refusal = nodeWsOptionalArchiveRefusal(
        record.archivePath,
        [...files.files.keys()],
        files.physical.links,
      );
      if (refusal !== undefined) refuse(refusal);
    }
  }
  return Object.freeze(records);
}

async function assertMetadata(
  metadata: Awaited<ReturnType<typeof nodeJwtCompilerMetadata>>,
  files: NodeArtifactFiles,
  rewrites: NodeNextRewriteProof | undefined,
): Promise<void> {
  for (const source of metadata.files) {
    const name = coordinate(files, source.file);
    const bytes = files.files.get(name)?.bytes;
    if (
      bytes === undefined ||
      files.physical.sourcePaths.get(name) !== source.file ||
      digest(bytes) !== source.sha256
    )
      refuse('immutable source or scope metadata absent or changed');
  }
  for (const missing of metadata.missing)
    if (files.files.has(coordinate(files, missing))) refuse('nearer package metadata added');
  for (const caller of metadata.callers) await assertCaller(caller, files, rewrites);
}

/** Keep the hook and its finite resolution targets tied to the final physical archive. */
export async function archivedNodeNextRequireHook(
  proof: NodeNextRequireHookProof | undefined,
  files: NodeArtifactFiles,
  rewrites: NodeNextRewriteProof | undefined,
): Promise<NodeNextRequireHookArchive | undefined> {
  if (proof === undefined) return undefined;
  const metadata = await nodeNextRequireHookMetadata(proof);
  const record = await nodeNextRequireHookGuardRecord(proof, files.physical.nameOf);
  await assertNextHookMetadata(metadata, files, rewrites, record);
  const bytes = files.files.get(record.archivePath)?.bytes;
  if (bytes?.byteLength !== record.bytes || digest(bytes) !== record.sha256)
    refuse('Next hook record does not describe the final physical source');
  return Object.freeze({
    record,
    aliases: Object.freeze(
      metadata.aliases.map(({ request, target }) =>
        Object.freeze({ request, target: coordinate(files, target) }),
      ),
    ),
    sharedRuntimeEdges: Object.freeze(
      metadata.sharedRuntimeEdges.map(({ caller, specifier, target }) => {
        return Object.freeze({
          caller: coordinate(files, caller),
          specifier,
          target: coordinate(files, target),
        });
      }),
    ),
  });
}

async function assertNextHookMetadata(
  metadata: Awaited<ReturnType<typeof nodeNextRequireHookMetadata>>,
  files: NodeArtifactFiles,
  rewrites: NodeNextRewriteProof | undefined,
  record: NodeNextRequireHookGuardRecord,
): Promise<void> {
  const immutable = new Set([
    record.archivePath,
    ...metadata.aliases.map(({ target }) => coordinate(files, target)),
    ...metadata.sharedRuntimeEdges.map(({ target }) => coordinate(files, target)),
  ]);
  const sharedCallers = new Map<string, string[]>();
  for (const { caller, specifier } of metadata.sharedRuntimeEdges) {
    const specifiers = sharedCallers.get(caller) ?? [];
    specifiers.push(specifier);
    sharedCallers.set(caller, specifiers);
  }
  const callers = new Map(metadata.callers.map((caller) => [caller.file, caller]));
  const strict = [];
  for (const source of metadata.files) {
    const name = coordinate(files, source.file);
    const incoming = callers.get(source.file);
    const shared = sharedCallers.get(source.file);
    if (
      immutable.has(name) ||
      source.file.endsWith('/package.json') ||
      (incoming === undefined && shared === undefined)
    ) {
      strict.push(source);
    } else {
      await assertCaller(
        {
          ...source,
          ...incoming,
          specifiers: [...(incoming?.specifiers ?? []), ...(shared ?? [])],
        },
        files,
        rewrites,
      );
    }
  }
  await assertMetadata({ ...metadata, files: strict }, files, rewrites);
}
