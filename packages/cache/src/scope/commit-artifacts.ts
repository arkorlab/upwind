import type { CommitArtifact, CommitOutput } from '@stayingupwind/host/cache';

import { type ArtifactRepair, repairStorageRef } from './artifact-repair.ts';
import { artifactFailed, findArtifactBySha } from './artifacts.ts';
import type { BlobStore } from './io.ts';
import type { AttemptArtifactRow } from './rows.ts';
import { isRefusal, type Refusal, refuse } from './state.ts';
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

interface ArtifactLocationsPlan {
  readonly scopeId: string;
  readonly attemptId: string;
  readonly request: { readonly generation: { readonly outputs: readonly CommitOutput[] } };
  readonly missingUploads: ReadonlySet<string>;
  readonly checkedUploads: ReadonlySet<string>;
}

/**
 * Where one named artifact's bytes are.
 *
 * Where the scope already holds them wins, unless projection verified that exact location is
 * broken. A repair uses the verified upload and moves ownership in the same publishing transaction.
 */
function locateArtifact(
  sql: SqlStorage,
  plan: ArtifactLocationsPlan,
  artifact: CommitArtifact,
): Refusal | { readonly storageRef: string; readonly repair?: ArtifactRepair } {
  const named = `${artifact.role} ${artifact.sha256}`;
  const upload = findUpload(sql, plan.attemptId, artifact);
  const stored = findArtifactBySha(sql, artifact.sha256);
  const mismatch = upload === undefined ? undefined : mismatchOf(upload, artifact);
  if (mismatch !== undefined) {
    return refuse('artifact_mismatch', mismatch);
  }
  if (stored !== undefined) {
    if (stored.byte_length !== artifact.byteLength) {
      return refuse(
        'artifact_mismatch',
        `${named} holds ${stored.byte_length} bytes, not ${artifact.byteLength}`,
      );
    }
    if (!artifactFailed(sql, stored)) return { storageRef: stored.storage_ref };
    if (
      upload === undefined ||
      upload.storage_ref !== repairStorageRef(plan.scopeId, artifact.sha256, plan.attemptId) ||
      !plan.checkedUploads.has(upload.storage_ref) ||
      plan.missingUploads.has(upload.storage_ref)
    ) {
      return refuse('artifact_missing', `no stored replacement upload for ${named}`);
    }
    return {
      storageRef: upload.storage_ref,
      repair: {
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        previousStorageRef: stored.storage_ref,
        storageRef: upload.storage_ref,
        previouslyOwned: stored.owned === 1,
      },
    };
  }
  if (upload === undefined) {
    return refuse('artifact_missing', `no upload for ${named}`);
  }
  // Published, it would be a generation no record of could ever be written. Refused, it is an
  // attempt the runtime fails and renders again, and that upload stores the bytes anew.
  return plan.missingUploads.has(upload.storage_ref)
    ? refuse('artifact_missing', `the bytes uploaded for ${named} are not in storage`)
    : { storageRef: upload.storage_ref };
}

/** Where each named artifact's bytes are: uploaded for this attempt, or already the scope's. */
export function locateArtifacts(
  sql: SqlStorage,
  plan: ArtifactLocationsPlan,
): LocatedArtifacts | Refusal {
  const refs = new Map<string, string>();
  const repairs = new Map<string, ArtifactRepair>();
  for (const output of plan.request.generation.outputs) {
    for (const artifact of output.artifacts) {
      const located = locateArtifact(sql, plan, artifact);
      if (isRefusal(located)) {
        return located;
      }
      refs.set(artifact.sha256, located.storageRef);
      if (located.repair !== undefined) repairs.set(artifact.sha256, located.repair);
    }
  }
  return { refs, repairs };
}

interface LocatedArtifacts {
  readonly refs: ReadonlyMap<string, string>;
  readonly repairs: ReadonlyMap<string, ArtifactRepair>;
}
