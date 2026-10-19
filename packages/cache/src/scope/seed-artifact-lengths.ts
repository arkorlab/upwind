import type { OutputSnapshot } from '@stayingupwind/core/cache';

/** Canonical lengths are shared by every generation that names an artifact's SHA. */
const ARTIFACT_PAGE = 100;

interface ArtifactPlan {
  readonly outputs: readonly OutputSnapshot[];
}

export function existingSeedArtifactLengths(
  sql: SqlStorage,
  plans: readonly ArtifactPlan[],
): Map<string, number> {
  const shas = new Set<string>();
  for (const plan of plans) {
    for (const output of plan.outputs) {
      for (const artifact of output.artifacts) {
        shas.add(artifact.sha256);
      }
    }
  }
  const ids = [...shas];
  const lengths = new Map<string, number>();
  for (let offset = 0; offset < ids.length; offset += ARTIFACT_PAGE) {
    const rows = sql
      .exec<{ sha256: string; byte_length: number }>(
        `SELECT sha256,byte_length FROM artifacts
         WHERE sha256 IN (SELECT value FROM json_each(?))`,
        JSON.stringify(ids.slice(offset, offset + ARTIFACT_PAGE)),
      )
      .toArray();
    for (const row of rows) {
      lengths.set(row.sha256, row.byte_length);
    }
  }
  return lengths;
}

/** A refused entry reserves neither a new SHA's length nor any of its earlier occurrences. */
export function reserveSeedArtifactLengths(
  held: Map<string, number>,
  outputs: readonly OutputSnapshot[],
): boolean {
  const proposed = new Map<string, number>();
  for (const output of outputs) {
    for (const artifact of output.artifacts) {
      const length = proposed.get(artifact.sha256) ?? held.get(artifact.sha256);
      if (length !== undefined && length !== artifact.byteLength) {
        return false;
      }
      proposed.set(artifact.sha256, artifact.byteLength);
    }
  }
  for (const [sha, length] of proposed) {
    held.set(sha, length);
  }
  return true;
}
