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
  rewriteCertifiedNodeNextFile,
  type NodeNextRewriteProof,
} from './node-next-rewrite-proof.ts';
import { nodeProofSource } from './node-proof.ts';

function refuse(reason: string): never {
  throw new AuditError(`Unproved archived Node JWT initialization: ${reason}`);
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
): Promise<readonly NodeJwtGuardRecord[]> {
  if (proof === undefined) return [];
  const metadata = await nodeJwtCompilerMetadata(proof);
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
  const record = await nodeJwtGuardRecord(proof, files.physical.nameOf);
  const bytes = files.files.get(record.archivePath)?.bytes;
  if (bytes?.byteLength !== record.bytes || digest(bytes) !== record.sha256)
    refuse('guard record does not describe the final physical source');
  return Object.freeze([record]);
}
