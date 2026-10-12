import type {
  ReadArtifactLocationResult,
  ReadEntryResult,
  ReadGenerationResult,
  ReadHeadResult,
  ResolveResponse,
} from '@stayingupwind/host/cache';

import { findArtifact } from './artifacts.ts';
import { findEntry } from './entries.ts';
import { findGeneration } from './generations.ts';
import type { ScopeHistory } from './history.ts';
import { type ArtifactRow, toEntry, toEntryState, toPublicGeneration, toScope } from './rows.ts';
import { readScope } from './state.ts';

/** Reads that change nothing: what the gateway resolves, and what a host reads of the scope. */

const NOT_RECORDED = 'not-recorded';

export function resolveEntry(sql: SqlStorage, scopeId: string, entryId: string): ResolveResponse {
  const revision = readScope(sql)?.revision ?? 0;
  const entry = findEntry(sql, entryId);
  if (entry === undefined) {
    return { entryId, state: null, current: null, revision };
  }
  const current =
    entry.current_generation_id === null
      ? undefined
      : findGeneration(sql, entry.current_generation_id);
  return {
    entryId,
    state: toEntryState(entry),
    current: current === undefined ? null : toPublicGeneration(scopeId, current),
    revision,
  };
}

export function readHead(sql: SqlStorage, history: ScopeHistory): ReadHeadResult {
  const scope = readScope(sql);
  if (scope === undefined) {
    return { kind: NOT_RECORDED };
  }
  return {
    kind: 'found',
    // The history's fields first: what it says beside the authority's own never replaces them.
    head: {
      ...history.head(sql),
      scopeId: scope.scope_id,
      status: toScope(scope).status,
      revision: scope.revision,
      entryCount: scope.entry_count,
      seededAt: scope.seeded_at,
    },
  };
}

export function readEntry(
  sql: SqlStorage,
  scopeId: string,
  entryId: string,
  now: number,
): ReadEntryResult {
  const scope = readScope(sql);
  const entry = findEntry(sql, entryId);
  if (scope === undefined || entry === undefined) {
    return { kind: NOT_RECORDED };
  }
  const current =
    entry.current_generation_id === null
      ? undefined
      : findGeneration(sql, entry.current_generation_id);
  return {
    kind: 'found',
    entry: toEntry(scopeId, entry),
    state: toEntryState(entry),
    current: current === undefined ? null : toPublicGeneration(scopeId, current),
    revision: scope.revision,
    evaluatedAt: now,
  };
}

export function readGeneration(
  sql: SqlStorage,
  scopeId: string,
  generationId: string,
): ReadGenerationResult {
  const generation = findGeneration(sql, generationId);
  return generation === undefined
    ? { kind: NOT_RECORDED }
    : { kind: 'found', generation: toPublicGeneration(scopeId, generation) };
}

export interface ArtifactLocation {
  readonly sha256: string;
  readonly storageRef: string;
  readonly byteLength: number;
}

/** Where an artifact's bytes are, for the gateway to serve; only within the scope that holds it. */
export function locateArtifact(sql: SqlStorage, artifactId: string): ArtifactLocation | undefined {
  const row: ArtifactRow | undefined = findArtifact(sql, artifactId);
  return row === undefined
    ? undefined
    : { sha256: row.sha256, storageRef: row.storage_ref, byteLength: row.byte_length };
}

/** Check membership, retention and location without yielding to a pruning mutation. */
export function readArtifactLocation(
  sql: SqlStorage,
  scopeId: string,
  generationId: string,
  artifactId: string,
): ReadArtifactLocationResult {
  const result = readGeneration(sql, scopeId, generationId);
  if (result.kind !== 'found') return result;
  const { generation } = result;
  const artifact = generation.outputs
    .flatMap((output) => output.artifacts)
    .find((candidate) => candidate.artifactId === artifactId && candidate.role !== 'postponed');
  if (artifact === undefined) return { kind: NOT_RECORDED };
  if (generation.storage === 'pruned') return { kind: 'pruned' };
  const location = locateArtifact(sql, artifactId);
  return location === undefined
    ? { kind: NOT_RECORDED }
    : { kind: 'found', storageRef: location.storageRef };
}
