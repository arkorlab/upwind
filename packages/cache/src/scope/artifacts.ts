import { artifactIdFor } from '@stayingupwind/core/cache';

import type { ArtifactRow } from './rows.ts';
import { inChunks } from './tx.ts';

/**
 * The bytes behind generations, by content. A row counts the outputs that refer to a blob, so
 * retention deletes a blob only when nothing does; a blob the build owns (`owned = 0`, under the
 * key its deploy gave it) is referenced but never deleted from here.
 */

export interface ArtifactReference {
  readonly artifactId: string;
  readonly sha256: string;
  readonly storageRef: string;
  readonly byteLength: number;
  readonly owned: boolean;
}

/**
 * How many ids of blobs a plan derives at once. A commit, or an entry of a build's batch, may name a
 * thousand artifacts or more, and each id is a digest.
 */
const ARTIFACT_IDS_AT_ONCE = 128;

/** Ids for the blobs a commit names, derived ahead of its transaction. */
export async function artifactIdsFor(
  scopeId: string,
  shas: Iterable<string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  await inChunks([...new Set(shas)], ARTIFACT_IDS_AT_ONCE, async (sha256) => {
    ids.set(sha256, await artifactIdFor(scopeId, sha256));
  });
  return ids;
}

export function findArtifact(sql: SqlStorage, artifactId: string): ArtifactRow | undefined {
  return sql
    .exec<ArtifactRow>(`SELECT * FROM artifacts WHERE artifact_id = ?`, artifactId)
    .toArray()[0];
}

export function findArtifactBySha(sql: SqlStorage, sha256: string): ArtifactRow | undefined {
  return sql.exec<ArtifactRow>(`SELECT * FROM artifacts WHERE sha256 = ?`, sha256).toArray()[0];
}

function addedBy(
  existing: ArtifactRow | undefined,
  ref: Pick<ArtifactReference, 'owned' | 'byteLength'>,
): number {
  if (existing === undefined) {
    return ref.owned ? ref.byteLength : 0;
  }
  return existing.refs === 0 && existing.owned === 1 ? existing.byte_length : 0;
}

/**
 * What referencing this blob would add to the scope's bytes, asked before anything is written: a
 * quota that charges for bytes the scope already holds refuses a write that would store nothing.
 */
export function addedBytesOf(sql: SqlStorage, ref: ArtifactReference): number {
  return addedBy(findArtifactBySha(sql, ref.sha256), ref);
}

/**
 * What bytes uploaded as the scope's own would add to its quota once published, counted as the
 * commit counts them (`addedBytesOf`): nothing for bytes the scope already holds, and nothing for
 * bytes the build owns, which the commit refers to where they are rather than to the upload.
 */
export function addedOwnedBytes(sql: SqlStorage, sha256: string, byteLength: number): number {
  return addedBy(findArtifactBySha(sql, sha256), { owned: true, byteLength });
}

/** Blobs a reference to adds nothing to the scope's bytes (`addedBy`), as an SQL condition. */
export const HELD_WITHOUT_CHARGE = 'refs > 0 OR owned = 0';

/** Count one more reference; the bytes the scope newly holds, for its quota. */
export function referenceArtifact(
  sql: SqlStorage,
  ref: ArtifactReference,
  now: number,
): { readonly addedBytes: number } {
  const existing = findArtifactBySha(sql, ref.sha256);
  const addedBytes = addedBy(existing, ref);
  sql.exec(
    `DELETE FROM pending_deletions WHERE storage_ref = ?`,
    existing?.storage_ref ?? ref.storageRef,
  );
  if (existing === undefined) {
    sql.exec(
      `INSERT INTO artifacts (artifact_id, sha256, storage_ref, byte_length, owned, refs, referenced_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ref.artifactId,
      ref.sha256,
      ref.storageRef,
      ref.byteLength,
      ref.owned ? 1 : 0,
      now,
    );
    return { addedBytes };
  }
  sql.exec(
    `UPDATE artifacts SET refs = refs + 1, referenced_at = ? WHERE sha256 = ?`,
    now,
    ref.sha256,
  );
  return { addedBytes };
}

export interface ReleasedArtifact {
  readonly sha256: string;
  readonly storageRef: string;
  readonly byteLength: number;
  /** Nothing refers to it any more and it is the scope's own: the blob may go. */
  readonly deletable: boolean;
}

/** Count one reference fewer; says whether the blob is now unreferenced. */
export function releaseArtifact(sql: SqlStorage, sha256: string): ReleasedArtifact | undefined {
  const existing = findArtifactBySha(sql, sha256);
  if (existing === undefined || existing.refs === 0) {
    return undefined;
  }
  const refs = existing.refs - 1;
  sql.exec(`UPDATE artifacts SET refs = ? WHERE sha256 = ?`, refs, sha256);
  return {
    sha256,
    storageRef: existing.storage_ref,
    byteLength: existing.byte_length,
    deletable: refs === 0 && existing.owned === 1,
  };
}

export function deleteArtifactRow(sql: SqlStorage, sha256: string): void {
  sql.exec(`DELETE FROM artifacts WHERE sha256 = ? AND refs = 0`, sha256);
}
