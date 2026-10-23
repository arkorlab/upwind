import {
  artifactVerification,
  type ArtifactVerification,
  forgetVerifiedArtifactFailures,
} from './artifacts.ts';
import { markRecordWritten } from './entries.ts';
import type { RecordDeps } from './records.ts';
import type { EntryRow, GenerationRow } from './rows.ts';
import { forgetSeedFailure } from './seed-repair.ts';
import type { SettleDeps } from './settle.ts';
import { commitRevision, readRevision } from './state.ts';

export interface ProjectingEntry {
  readonly entry: EntryRow;
  readonly current: GenerationRow | undefined;
  verifiedArtifacts?: ArtifactVerification[] | undefined;
}

/** Proof arrays and completion closures exist only when an actual body names a failure marker. */
export function verifyingRecords(deps: SettleDeps, entry: ProjectingEntry): RecordDeps {
  return {
    scopeId: deps.scopeId,
    buildId: deps.buildId,
    packSchemaVersion: deps.packSchemaVersion,
    blobs: deps.blobs,
    verifying(artifact) {
      const proof = artifactVerification(deps.sql, artifact);
      if (proof === undefined) return;
      return () => {
        entry.verifiedArtifacts ??= [];
        entry.verifiedArtifacts.push(proof);
      };
    },
  };
}

export interface ProjectedEntry {
  readonly entryId: string;
  readonly kvRevision: number;
  readonly verifiedArtifacts?: readonly ArtifactVerification[] | undefined;
}

/**
 * What went out, acknowledged in one transaction: marked written, and an event for the history.
 * The entries marked: one a later change touched while its record was on its way is left behind,
 * and its record is not the entry's to hand on.
 */
export function acknowledge(deps: SettleDeps, projected: readonly ProjectedEntry[]): Set<string> {
  const marked = new Set<string>();
  if (projected.length === 0) {
    return marked;
  }
  deps.transaction(() => {
    const acknowledged: ProjectedEntry[] = [];
    for (const entry of projected) {
      if (!markRecordWritten(deps.sql, entry.entryId, entry.kvRevision)) continue;
      forgetSeedFailure(deps.sql, entry.entryId);
      forgetVerifiedArtifactFailures(deps.sql, entry.verifiedArtifacts);
      marked.add(entry.entryId);
      acknowledged.push({ entryId: entry.entryId, kvRevision: entry.kvRevision });
    }
    if (acknowledged.length === 0) {
      return;
    }
    const revision = readRevision(deps.sql) + 1;
    commitRevision(deps.sql, revision);
    deps.history.append(
      { sql: deps.sql, revision, now: deps.now() },
      {
        entityType: 'scope',
        entityId: deps.scopeId,
        kind: 'entries.projected',
        payload: { entries: acknowledged },
      },
    );
  });
  return marked;
}
