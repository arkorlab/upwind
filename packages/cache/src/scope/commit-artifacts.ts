import type { CommitArtifact, CommitOutput } from '@stayingupwind/host/cache';

import { artifactFailed, findArtifactBySha } from './artifacts.ts';
import type { BlobStore } from './io.ts';
import type { AttemptArtifactRow } from './rows.ts';
import { inChunks } from './tx.ts';

/**
 * How many of a commit's uploads its plan asks storage about at once. A commit may name thousands
 * of artifacts, and a Worker has six calls waiting for an answer at the most: one past them waits
 * in the runtime's own queue, held all the same.
 */
const UPLOAD_CHECKS_AT_ONCE = 6;

export function findUpload(
  sql: SqlStorage,
  attemptId: string,
  artifact: CommitArtifact,
): AttemptArtifactRow | undefined {
  return sql
    .exec<AttemptArtifactRow>(
      `SELECT * FROM attempt_artifacts WHERE attempt_id = ? AND sha256 = ? AND role = ?`,
      attemptId,
      artifact.sha256,
      artifact.role,
    )
    .toArray()[0];
}

/**
 * The uploads a commit would publish from whose bytes are not in storage.
 *
 * An upload is recorded before its bytes are stored, and the gateway stores nothing when the key
 * already holds the same bytes — bytes a former generation may be the last to name, which
 * retention prunes and deletes if its hour comes round before the commit does: what it keeps is
 * what a generation refers to, not what an attempt has uploaded and not yet published. A store
 * that failed after its upload was recorded leaves the same gap. Asked here, under the lock
 * retention deletes under, the answer holds for the transaction that follows. Only uploads are
 * asked about: the bytes the scope already holds are kept by the generations that refer to them.
 */
export async function missingUploads(
  sql: SqlStorage,
  attemptId: string,
  outputs: readonly CommitOutput[],
  blobs: BlobStore,
): Promise<{ readonly missing: ReadonlySet<string>; readonly checked: ReadonlySet<string> }> {
  const keys = new Set<string>();
  for (const output of outputs) {
    for (const artifact of output.artifacts) {
      const upload = findUpload(sql, attemptId, artifact);
      const stored = findArtifactBySha(sql, artifact.sha256);
      if (upload !== undefined && (stored === undefined || artifactFailed(sql, stored))) {
        keys.add(upload.storage_ref);
      }
    }
  }
  const missing = new Set<string>();
  await inChunks([...keys], UPLOAD_CHECKS_AT_ONCE, async (key) => {
    if (!(await blobs.exists(key))) {
      missing.add(key);
    }
  });
  return { missing, checked: keys };
}

/**
 * What the commit claims of an artifact that the bytes behind it do not say.
 *
 * The request describes the artifacts, but the gateway is what measured them on the way in. A
 * length the commit is free to invent is a length the scope's quota is charged and a later read
 * trusts, so a commit that disagrees with what was stored is refused rather than believed.
 */
export function mismatchOf(
  upload: AttemptArtifactRow,
  artifact: CommitArtifact,
): string | undefined {
  const named = `${artifact.role} ${artifact.sha256}`;
  if (upload.byte_length !== artifact.byteLength) {
    return `${named} holds ${upload.byte_length} bytes, not ${artifact.byteLength}`;
  }
  if (upload.content_type !== artifact.contentType) {
    return `${named} was uploaded as ${upload.content_type}, not ${artifact.contentType}`;
  }
  if (upload.encoding !== artifact.encoding) {
    return `${named} was uploaded ${upload.encoding}, not ${artifact.encoding}`;
  }
  return undefined;
}
