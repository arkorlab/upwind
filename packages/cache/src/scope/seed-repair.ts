import { canonicalJson } from '@stayingupwind/core/artifact';
import type { OutputSnapshot } from '@stayingupwind/core/cache';
import { withDeadline } from '@stayingupwind/core/util';
import type { SeedEntriesResult, SeedEntryInput } from '@stayingupwind/host/cache';

import {
  type ArtifactRepair,
  finishArtifactRepairs,
  relocateBorrowedArtifact,
  retargetedRecordsFailure,
} from './artifact-repair.ts';
import { findArtifactBySha, rememberArtifactFailure } from './artifacts.ts';
import { entryStateEvent } from './attempts.ts';
import { type EntryIdentity, findEntry, requireEntry } from './entries.ts';
import { findGeneration } from './generations.ts';
import type { EventInput } from './history.ts';
import { checkFault, type TestFaults, verifyBlob } from './io.ts';
import { headerFieldsOf, InvalidArtifactError, unwritableRecord } from './records.ts';
import {
  type EntryRow,
  generationOutputs,
  type GenerationRow,
  toEntryState,
  toPublicGeneration,
} from './rows.ts';
import { deleteMeta, readMeta, type Refusal, refuse, writeMeta } from './state.ts';
import type { TxInput } from './tx.ts';

const FAILURE_PREFIX = 'seed_artifact_failure:';

/** A seed whose bytes projection could not read, not a record delayed by an outage. */
export function rememberSeedFailure(
  deps: { readonly sql: SqlStorage; readonly transaction: <T>(body: () => T) => T },
  snapshot: { readonly entry: EntryRow; readonly current: GenerationRow | undefined } | undefined,
  error: unknown,
): void {
  if (snapshot === undefined || !(error instanceof InvalidArtifactError)) return;
  const { sql } = deps;
  const { entry, current } = snapshot;
  deps.transaction(() => {
    const latest = findEntry(sql, entry.entry_id);
    if (
      current === undefined ||
      latest?.current_generation_id !== current.generation_id ||
      latest.record_revision !== entry.record_revision ||
      latest.publication !== 'published'
    )
      return;
    rememberArtifactFailure(sql, error.artifact);
    if (current.source === 'build' && latest.kv_revision === 0) {
      writeMeta(sql, FAILURE_PREFIX + entry.entry_id, current.generation_id);
    }
  });
}

/** Once its record is acknowledged in KV, the build's locations are closed to a seed's retry. */
export function forgetSeedFailure(sql: SqlStorage, entryId: string): void {
  deleteMeta(sql, FAILURE_PREFIX + entryId);
}

interface SeedLocations {
  readonly entry: SeedEntryInput;
  readonly identity: Pick<EntryIdentity, 'entryId'>;
  readonly outputs: readonly OutputSnapshot[];
}

export interface SeedLocationCheck {
  readonly sha256: string;
  readonly byteLength: number;
  readonly storageRef: string;
}

/** Internal preparation only: no entry, generation, revision or event has changed. */
export interface SeedRepairVerification {
  readonly kind: 'verify-seed-locations';
  readonly locations: readonly SeedLocationCheck[];
}

export type SeedLocationProofs = ReadonlyMap<string, boolean>;
type SeedOutcome = SeedEntriesResult | Refusal | SeedRepairVerification;

export function needsSeedVerification(value: SeedOutcome): value is SeedRepairVerification {
  return 'kind' in value && value.kind === 'verify-seed-locations';
}

/** Each preparation committed nothing; verification waits outside the writer's queue. */
export async function finishSeedRepair(
  prepared: SeedRepairVerification,
  deps: {
    readonly bucket: Pick<R2Bucket, 'get'>;
    readonly retry: (proofs: SeedLocationProofs) => Promise<SeedOutcome>;
    readonly faults: () => TestFaults;
  },
): Promise<SeedEntriesResult | Refusal> {
  const proofs = new Map<string, boolean>();
  let result: SeedOutcome = prepared;
  while (needsSeedVerification(result)) {
    try {
      checkFault(deps.faults, 'r2');
      await verifySeedLocations((key) => deps.bucket.get(key), result.locations, proofs);
    } catch {
      return refuse('internal', 'the proposed shared artifact locations could not be verified');
    }
    result = await deps.retry(proofs);
  }
  return result;
}

export function seedLocationKey(location: SeedLocationCheck): string {
  return JSON.stringify([location.sha256, location.byteLength, location.storageRef]);
}

/** The artifact gateway's ten-second read budget, applied to each verification phase. */
const REPAIR_VERIFICATION_MS = 10_000;

/** Called only after preparation has left the mutation queue, with no transaction held. */
export async function verifySeedLocations(
  open: Parameters<typeof verifyBlob>[0],
  locations: readonly SeedLocationCheck[],
  proofs: Map<string, boolean>,
  deadlineMs = REPAIR_VERIFICATION_MS,
): Promise<void> {
  const controller = new AbortController();
  const checking = async (): Promise<void> => {
    for (const location of locations) {
      controller.signal.throwIfAborted();
      proofs.set(seedLocationKey(location), await verifyBlob(open, location, controller.signal));
    }
  };
  try {
    await withDeadline(checking(), deadlineMs, 'seed artifact verification');
  } finally {
    controller.abort();
  }
}

/** Ask only for changed, shared borrowed rows a failed seed could actually relocate. */
export function seedRepairVerification(
  sql: SqlStorage,
  plans: readonly SeedLocations[],
  proofs: SeedLocationProofs,
  addedRefs: ReadonlyMap<string, number>,
): SeedRepairVerification | undefined {
  const locations = new Map<string, SeedLocationCheck>();
  for (const plan of plans) {
    const generation = repairableGeneration(sql, plan);
    if (generation === undefined) continue;
    const previous = generationOutputs(generation);
    const outputs = relocatedOutputs(previous, plan.outputs);
    if (outputs === undefined) continue;
    addSharedChecks(sql, previous, outputs, { proofs, addedRefs, locations });
  }
  return locations.size === 0
    ? undefined
    : { kind: 'verify-seed-locations', locations: [...locations.values()] };
}

function addSharedChecks(
  sql: SqlStorage,
  previous: readonly OutputSnapshot[],
  outputs: readonly OutputSnapshot[],
  checks: {
    readonly proofs: SeedLocationProofs;
    readonly addedRefs: ReadonlyMap<string, number>;
    readonly locations: Map<string, SeedLocationCheck>;
  },
): void {
  const { proofs, addedRefs, locations } = checks;
  for (const [index, output] of outputs.entries()) {
    for (const [offset, artifact] of output.artifacts.entries()) {
      const before = previous[index]?.artifacts[offset]?.storageRef;
      if (artifact.storageRef === before) continue;
      const row = findArtifactBySha(sql, artifact.sha256);
      if (
        row?.owned !== 0 ||
        row.refs + (addedRefs.get(artifact.sha256) ?? 0) <= 1 ||
        row.storage_ref !== before
      )
        continue;
      const key = seedLocationKey(artifact);
      if (!proofs.has(key)) locations.set(key, artifact);
    }
  }
}

function protectedOutputs(
  sql: SqlStorage,
  previous: readonly OutputSnapshot[],
  proposed: readonly OutputSnapshot[],
  proofs: SeedLocationProofs,
): OutputSnapshot[] {
  const locations = new Map<string, string>();
  const selected = new Set<string>();
  for (const [index, output] of proposed.entries()) {
    for (const [offset, artifact] of output.artifacts.entries()) {
      selectLocation(sql, artifact, previous[index]?.artifacts[offset]?.storageRef, {
        proofs,
        locations,
        selected,
      });
    }
  }
  return proposed.map((output) => {
    return {
      ...output,
      artifacts: output.artifacts.map((artifact) => {
        return {
          ...artifact,
          storageRef: locations.get(artifact.sha256) ?? artifact.storageRef,
        };
      }),
    };
  });
}

function selectLocation(
  sql: SqlStorage,
  artifact: SeedLocationCheck,
  before: string | undefined,
  chosen: {
    readonly proofs: SeedLocationProofs;
    readonly locations: Map<string, string>;
    readonly selected: Set<string>;
  },
): void {
  const { locations, proofs, selected } = chosen;
  if (selected.has(artifact.sha256)) return;
  const row = findArtifactBySha(sql, artifact.sha256);
  if (row === undefined) return;
  locations.set(artifact.sha256, row.storage_ref);
  // An earlier repair in this batch may have advanced every live snapshot to this key.
  // Keep that already verified canonical location rather than moving it again for a later plan.
  if (
    proofs.get(
      seedLocationKey({
        sha256: row.sha256,
        byteLength: row.byte_length,
        storageRef: row.storage_ref,
      }),
    ) === true
  )
    return;
  if (
    row.owned === 0 &&
    row.byte_length === artifact.byteLength &&
    row.storage_ref === before &&
    artifact.storageRef !== before &&
    (row.refs <= 1 || proofs.get(seedLocationKey(artifact)) === true)
  ) {
    locations.set(artifact.sha256, artifact.storageRef);
    selected.add(artifact.sha256);
  }
}

/** Only the locations may differ: the generation's bytes and every other field stay its own. */
function relocatedOutputs(
  previous: readonly OutputSnapshot[],
  proposed: readonly OutputSnapshot[],
): OutputSnapshot[] | undefined {
  const next = proposed.map((output, index) => {
    return {
      ...output,
      outputId: previous[index]?.outputId ?? '',
    };
  });
  const unchanged = next.map((output, index) => {
    return {
      ...output,
      artifacts: output.artifacts.map((artifact, offset) => {
        return {
          ...artifact,
          storageRef: previous[index]?.artifacts[offset]?.storageRef ?? '',
        };
      }),
    };
  });
  return canonicalJson(previous) === canonicalJson(unchanged) ? next : undefined;
}

function repairableGeneration(sql: SqlStorage, plan: SeedLocations): GenerationRow | undefined {
  const entry = findEntry(sql, plan.identity.entryId);
  if (
    entry?.kv_revision !== 0 ||
    entry.publication !== 'published' ||
    entry.regeneration_attempt_id !== null ||
    entry.current_generation_id !== plan.entry.generation.generationId ||
    readMeta(sql, FAILURE_PREFIX + entry.entry_id) !== entry.current_generation_id
  ) {
    return undefined;
  }
  const generation = findGeneration(sql, entry.current_generation_id);
  return generation?.source === 'build' && generation.publication === 'published'
    ? generation
    : undefined;
}

/** The unchanged content whose current canonical storage location the seed proposes to move. */
function seedRelocations(
  sql: SqlStorage,
  previous: readonly OutputSnapshot[],
  outputs: readonly OutputSnapshot[],
): ArtifactRepair[] {
  const repairs = new Map<string, ArtifactRepair>();
  for (const [index, output] of outputs.entries()) {
    for (const [offset, artifact] of output.artifacts.entries()) {
      const before = previous[index]?.artifacts[offset]?.storageRef ?? '';
      if (artifact.storageRef === before) continue;
      const row = findArtifactBySha(sql, artifact.sha256);
      if (
        row?.owned === 0 &&
        row.storage_ref === before &&
        row.byte_length === artifact.byteLength
      ) {
        repairs.set(artifact.sha256, {
          sha256: artifact.sha256,
          byteLength: artifact.byteLength,
          previousStorageRef: before,
          storageRef: artifact.storageRef,
          previouslyOwned: false,
        });
      }
    }
  }
  return [...repairs.values()];
}

function repairOne(
  input: TxInput,
  plan: SeedLocations,
  events: EventInput[],
  proofs: SeedLocationProofs,
): boolean {
  const { sql, revision, now, scopeId } = input;
  const generation = repairableGeneration(sql, plan);
  if (generation === undefined) return false;
  const previous = generationOutputs(generation);
  const proposed = relocatedOutputs(previous, plan.outputs);
  const outputs =
    proposed === undefined ? undefined : protectedOutputs(sql, previous, proposed, proofs);
  const entry = findEntry(sql, generation.entry_id);
  if (
    outputs === undefined ||
    entry === undefined ||
    unwritableRecord(
      headerFieldsOf(scopeId, entry, generation, outputs),
      input.limits.maxRecordBytes,
    ) !== undefined
  ) {
    return false;
  }
  // Every other live snapshot follows a verified canonical move in the same transaction.
  const repairs = seedRelocations(sql, previous, outputs);
  if (retargetedRecordsFailure(input, repairs, generation.entry_id) !== undefined) return false;
  const moved = new Map<string, ArtifactRepair>();
  for (const repair of repairs) {
    if (relocateBorrowedArtifact(input, repair)) moved.set(repair.sha256, repair);
  }
  if (moved.size > 0) finishArtifactRepairs(input, moved, generation.entry_id);
  sql.exec(
    `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
    JSON.stringify(outputs),
    generation.generation_id,
  );
  sql.exec(
    `UPDATE entries SET revision = ?, record_revision = ?, updated_at = ? WHERE entry_id = ?`,
    revision,
    revision,
    now,
    generation.entry_id,
  );
  forgetSeedFailure(sql, generation.entry_id);
  events.push(entryStateEvent(sql, generation.entry_id), {
    entityType: 'generation',
    entityId: generation.generation_id,
    kind: 'generation.committed',
    payload: {
      generation: toPublicGeneration(scopeId, { ...generation, outputs: JSON.stringify(outputs) }),
      entryState: toEntryState(requireEntry(sql, generation.entry_id)),
      supersededGenerationId: null,
      attempt: null,
    },
  });
  return true;
}

/**
 * A seed whose record has never been acknowledged in KV may correct where its unchanged bytes are
 * kept after projection found them missing or corrupt. Only a changed shared location needs a
 * streaming check before repair; ordinary seeds and serving reads do not ask storage in advance.
 * A retry changes neither an acknowledged generation nor one a render holds a lease to replace.
 */
export function repairSeedEntries(
  input: TxInput,
  plans: readonly SeedLocations[],
  events: EventInput[],
  proofs: SeedLocationProofs,
): number {
  return plans.reduce((count, plan) => count + Number(repairOne(input, plan, events, proofs)), 0);
}
