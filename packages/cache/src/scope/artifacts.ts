import { artifactIdFor } from '@stayingupwind/core/cache';

import type { ArtifactRow } from './rows.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';
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
/** SQLite takes 100 bindings: one SHA or location per lookup, six fields per borrowed insert. */
const REFERENCES_PER_LOOKUP = 100;
const BORROWED_PER_INSERT = 16;
const FAILURE_PREFIX = 'artifact_failure:';

/** A failed projection's exact location, kept only while its artifact row exists. */
export function artifactFailed(sql: SqlStorage, row: ArtifactRow): boolean {
  return readMeta(sql, FAILURE_PREFIX + row.sha256) === `${row.byte_length}:${row.storage_ref}`;
}

/** Remember the existing verification's result; no extra body read is needed to repair it. */
export function rememberArtifactFailure(
  sql: SqlStorage,
  artifact: { readonly sha256: string; readonly storageRef: string; readonly byteLength: number },
): void {
  const row = findArtifactBySha(sql, artifact.sha256);
  if (row?.storage_ref === artifact.storageRef && row.byte_length === artifact.byteLength) {
    writeMeta(sql, FAILURE_PREFIX + row.sha256, `${row.byte_length}:${row.storage_ref}`);
  }
}

export function forgetArtifactFailure(sql: SqlStorage, sha256: string): void {
  deleteMeta(sql, FAILURE_PREFIX + sha256);
}

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
 * commit counts them (`addedBytesOf`): nothing for bytes the scope already holds or healthy bytes
 * the build owns. Replacing a failed borrowed location makes the upload the scope's own, charged
 * once when published. The same lookup also says whether storage must replace a known bad copy.
 */
export function ownedUploadOf(
  sql: SqlStorage,
  sha256: string,
  byteLength: number,
): {
  readonly addedBytes: number;
  readonly replace: boolean;
  readonly storageRef: string | undefined;
} {
  const existing = findArtifactBySha(sql, sha256);
  const replace = existing !== undefined && artifactFailed(sql, existing);
  return {
    addedBytes:
      replace && existing.owned === 0 ? byteLength : addedBy(existing, { owned: true, byteLength }),
    replace,
    storageRef: existing?.owned === 1 ? existing.storage_ref : undefined,
  };
}

/** Blobs a reference to adds nothing to the scope's bytes (`addedBy`), as an SQL condition. */
export const HELD_WITHOUT_CHARGE = `(owned = 1 AND refs > 0) OR (owned = 0 AND NOT EXISTS (
  SELECT 1 FROM meta WHERE key = '${FAILURE_PREFIX}' || artifacts.sha256
    AND value = CAST(artifacts.byte_length AS TEXT) || ':' || artifacts.storage_ref
))`;

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

type BorrowedArtifact = Omit<ArtifactReference, 'owned'>;

interface BorrowedReferences {
  readonly first: BorrowedArtifact;
  count: number;
  /** The existing location wins; only its pending deletion is taken back. */
  canonical: string;
}

/** The first proposed reference per SHA, and every occurrence that contributes to its count. */
function borrowedCounts(refs: Iterable<BorrowedArtifact>): Map<string, BorrowedReferences> {
  const bySha = new Map<string, BorrowedReferences>();
  for (const ref of refs) {
    const held = bySha.get(ref.sha256);
    if (held === undefined) {
      bySha.set(ref.sha256, { first: ref, count: 1, canonical: ref.storageRef });
    } else {
      held.count += 1;
    }
  }
  return bySha;
}

function keepBorrowedLocations(
  sql: SqlStorage,
  bySha: ReadonlyMap<string, BorrowedReferences>,
): void {
  const refs = [...bySha.values()];
  for (let offset = 0; offset < refs.length; offset += REFERENCES_PER_LOOKUP) {
    const batch = refs.slice(offset, offset + REFERENCES_PER_LOOKUP);
    const places = batch.map(() => '?').join(', ');
    const heldRows = sql.exec<{ sha256: string; storage_ref: string }>(
      `SELECT sha256, storage_ref FROM artifacts WHERE sha256 IN (${places})`,
      ...batch.map(({ first }) => first.sha256),
    );
    for (const row of heldRows) {
      const held = bySha.get(row.sha256);
      if (held !== undefined) held.canonical = row.storage_ref;
    }
  }
  const keys = [...new Set(refs.map((ref) => ref.canonical))];
  for (let offset = 0; offset < keys.length; offset += REFERENCES_PER_LOOKUP) {
    const batch = keys.slice(offset, offset + REFERENCES_PER_LOOKUP);
    const places = batch.map(() => '?').join(', ');
    sql.exec(`DELETE FROM pending_deletions WHERE storage_ref IN (${places})`, ...batch);
  }
}

/**
 * The build's references, within the seed's existing transaction. Count every output occurrence,
 * retaining the first proposed location for a new SHA and every canonical field of an existing
 * row. Only the count and reference time change on a row already held, as `referenceArtifact`
 * changes them. Borrowed blobs add nothing to the scope's byte quota.
 */
export function referenceBuildArtifacts(
  sql: SqlStorage,
  refs: Iterable<BorrowedArtifact>,
  now: number,
): void {
  const bySha = borrowedCounts(refs);
  keepBorrowedLocations(sql, bySha);
  const counted = [...bySha.values()];
  for (let offset = 0; offset < counted.length; offset += BORROWED_PER_INSERT) {
    const batch = counted.slice(offset, offset + BORROWED_PER_INSERT);
    const values = batch.map(() => '(?, ?, ?, ?, 0, ?, ?)').join(', ');
    const bindings: SqlStorageValue[] = [];
    for (const { first, count } of batch) {
      bindings.push(first.artifactId, first.sha256, first.storageRef, first.byteLength, count, now);
    }
    sql.exec(
      `INSERT INTO artifacts (artifact_id, sha256, storage_ref, byte_length, owned, refs, referenced_at)
       VALUES ${values}
       ON CONFLICT (sha256) DO UPDATE SET refs = refs + excluded.refs,
         referenced_at = excluded.referenced_at`,
      ...bindings,
    );
  }
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
  sql.exec(
    `DELETE FROM meta WHERE key = ? AND NOT EXISTS (SELECT 1 FROM artifacts WHERE sha256 = ?)`,
    FAILURE_PREFIX + sha256,
    sha256,
  );
}
