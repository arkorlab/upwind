import type {
  CurrentDataRequest,
  ReadArtifactLocationResult,
  ReadEntryResult,
  ReadGenerationResult,
  ReadHeadResult,
  ResolveResponse,
} from '@stayingupwind/host/cache';

import { findArtifact } from './artifacts.ts';
import { findEntry, identifyEntry } from './entries.ts';
import { findGeneration } from './generations.ts';
import type { ScopeHistory } from './history.ts';
import {
  type DataRecord,
  dataRecordByReference,
  dataRecordFor,
  projectionMemoryOf,
  type RecordDeps,
} from './records.ts';
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

/** What the reads of an isolate hold in memory at once, as `projectionMemoryOf` reckons a record's. */
export interface MemoryBudget {
  readonly limit: number;
  reserved: number;
}

const KIB = 1024;
const CURRENT_DATA_MEMORY_MIB = 16;
/**
 * What the current-data reads of this isolate may hold at once. A Durable Object's isolate has
 * 128 MiB for every object it holds, the projection's runs among them (48 MiB at once,
 * `projection-memory.ts`), and a burst of these reads after an invalidation would otherwise hold
 * each value it reads inline several times over, all at the same time.
 */
const isolateReads: MemoryBudget = { limit: CURRENT_DATA_MEMORY_MIB * KIB * KIB, reserved: 0 };

/**
 * The data-cache value a key holds now, as the record the projection writes to KV would hold it
 * (`dataRecordFor`): read from the scope itself, where a read of KV can answer for half a minute with
 * what a data center read there before a later write (`RECORD_CACHE_TTL_SECONDS`). `undefined` for
 * no value — none written, or one withdrawn, whose record the projection deletes — and for none
 * later than the one the asker holds (`than`), whose value is then not read. Past what the isolate's
 * reads may hold at once (`budget`), the value is answered by reference instead, read from storage
 * by the Function as a large value's is, and not here.
 */
export async function readCurrentData(
  deps: RecordDeps & { readonly sql: SqlStorage },
  request: CurrentDataRequest,
  budget: MemoryBudget = isolateReads,
): Promise<DataRecord | undefined> {
  const { sql, scopeId } = deps;
  const { entryId } = await identifyEntry(scopeId, {
    kind: request.kind,
    key: request.key,
    ...(request.handler !== undefined && { handler: request.handler }),
  });
  const entry = findEntry(sql, entryId);
  if (
    entry?.kind !== request.kind ||
    entry.publication === 'retired' ||
    entry.current_generation_id === null
  ) {
    return undefined;
  }
  const current = findGeneration(sql, entry.current_generation_id);
  if (
    current === undefined ||
    (request.than !== undefined && current.dependency_revision <= request.than)
  ) {
    return undefined;
  }
  const memory = projectionMemoryOf(scopeId, entry, current);
  if (budget.reserved + memory > budget.limit) {
    return dataRecordByReference(scopeId, entry, current);
  }
  budget.reserved += memory;
  try {
    const record = await dataRecordFor(deps, entry, current);
    // Blob I/O can yield to a write or invalidation. This authority fallback must still be current.
    const latest = findEntry(sql, entryId);
    return latest !== undefined &&
      latest.publication !== 'retired' &&
      latest.current_generation_id === current.generation_id &&
      latest.record_revision === entry.record_revision
      ? record
      : undefined;
  } finally {
    budget.reserved -= memory;
  }
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
