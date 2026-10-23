import { createRepairStorageRef, isRepairStorageRef } from '@stayingupwind/core/cache';

import type { UploadedArtifact } from './attempts.ts';

/** Reuse one fresh reservation per attempt and SHA, across roles and idempotent retries. */
export function freshUploadStorageRef(
  sql: SqlStorage,
  attemptId: string,
  upload: UploadedArtifact,
  namespace: string,
): string {
  const previous = sql
    .exec<{ storage_ref: string }>(
      `SELECT aa.storage_ref FROM attempt_artifacts aa
     WHERE aa.attempt_id = ? AND aa.sha256 = ?
       AND NOT EXISTS (SELECT 1 FROM artifacts a
         WHERE a.sha256 = aa.sha256 AND a.storage_ref = aa.storage_ref)
     ORDER BY aa.role LIMIT 1`,
      attemptId,
      upload.sha256,
    )
    .toArray()[0]?.storage_ref;
  if (
    previous !== undefined &&
    previous !== upload.avoidStorageRef &&
    isRepairStorageRef(previous) &&
    previous.startsWith(`r/${namespace}/`)
  )
    return previous;
  const storageRef = createRepairStorageRef(namespace);
  // A collision retry rotates every role together; an older concurrent retry reuses the new key.
  sql.exec(
    `UPDATE attempt_artifacts SET storage_ref = ? WHERE attempt_id = ? AND sha256 = ?`,
    storageRef,
    attemptId,
    upload.sha256,
  );
  return storageRef;
}
