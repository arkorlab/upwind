import { canonicalJson } from '@stayingupwind/core/artifact';
import type { OutputSnapshot } from '@stayingupwind/core/cache';
import { withDeadline } from '@stayingupwind/core/util';
import type { SeedEntriesResult, SeedEntryInput } from '@stayingupwind/host/cache';

import { type ArtifactRepair, relocateBorrowedArtifact } from './artifact-repair.ts';
import {
  artifactFailed,
  artifactRepairMarker,
  findArtifactBySha,
  rememberArtifactFailure,
} from './artifacts.ts';
import { entryStateEvent } from './attempts.ts';
import { type EntryIdentity, findEntry, requireEntry } from './entries.ts';
import { findGeneration } from './generations.ts';
import type { EventInput } from './history.ts';
import { checkFault, type TestFaults, verifyBlob } from './io.ts';
import { headerFieldsOf, InvalidArtifactError, unwritableRecord } from './records.ts';
import type { RepairGroup, RepairPending } from './repair-jobs.ts';
import {
  type EntryRow,
  generationOutputs,
  type GenerationRow,
  toEntryState,
  toPublicGeneration,
} from './rows.ts';
import { deleteMeta, readMeta, type Refusal, refuse, writeMeta } from './state.ts';
import { encodeStoredOutputs } from './stored-outputs.ts';
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

export interface SeedLocations {
  readonly entry: { readonly generation: Pick<SeedEntryInput['generation'], 'generationId'> };
  readonly identity: Pick<EntryIdentity, 'entryId'>;
  readonly outputs: readonly OutputSnapshot[];
}

export interface SeedLocationCheck {
  readonly sha256: string;
  readonly byteLength: number;
  readonly storageRef: string;
  readonly contentType?: string;
}

/** Internal preparation only: no entry, generation, revision or event has changed. */
export interface SeedRepairVerification {
  readonly kind: 'verify-seed-locations';
  readonly locations: readonly SeedLocationCheck[];
  /** V2 stores verified copies at fixed-width scope-owned physical keys, retaining borrowed quota. */
  readonly copy?: true;
}

export type SeedLocationProofs = ReadonlyMap<string, boolean | string>;
export type SeedProofLookup = Pick<SeedLocationProofs, 'get' | 'has'>;
type SeedOutcome = SeedEntriesResult | Refusal | SeedRepairVerification | RepairPending;

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
    readonly copyRepair?: (
      location: SeedLocationCheck,
      signal: AbortSignal,
    ) => Promise<string | undefined>;
  },
): Promise<SeedEntriesResult | Refusal | RepairPending> {
  const proofs = new Map<string, boolean | string>();
  let result: SeedOutcome = prepared;
  while (needsSeedVerification(result)) {
    try {
      checkFault(deps.faults, 'r2');
      if (result.copy === true) {
        if (deps.copyRepair === undefined) throw new Error('seed repair copying is unavailable');
        await copySeedLocations(deps.copyRepair, result.locations, proofs);
      } else {
        await verifySeedLocations((key) => deps.bucket.get(key), result.locations, proofs);
      }
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
  proofs: { set(key: string, value: boolean): void },
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

/** The same phase deadline applies while the provider verifies a fresh streamed copy. */
async function copySeedLocations(
  copy: (location: SeedLocationCheck, signal: AbortSignal) => Promise<string | undefined>,
  locations: readonly SeedLocationCheck[],
  proofs: Map<string, boolean | string>,
): Promise<void> {
  const controller = new AbortController();
  const checking = async (): Promise<void> => {
    for (const location of locations) {
      controller.signal.throwIfAborted();
      const copied = await copy(location, controller.signal);
      proofs.set(seedLocationKey(location), copied ?? false);
      if (copied !== undefined) {
        proofs.set(seedLocationKey({ ...location, storageRef: copied }), true);
      }
    }
  };
  try {
    await withDeadline(checking(), REPAIR_VERIFICATION_MS, 'seed artifact copy');
  } finally {
    controller.abort();
  }
}

/** Ask only for changed, shared borrowed rows a failed seed could actually relocate. */
export function seedRepairVerification(
  sql: SqlStorage,
  plans: readonly SeedLocations[],
  proofs: SeedLocationProofs,
  options: { readonly addedRefs: ReadonlyMap<string, number>; readonly copy?: boolean },
): SeedRepairVerification | undefined {
  const { addedRefs, copy = false } = options;
  const locations = new Map<string, SeedLocationCheck>();
  for (const plan of plans) {
    const generation = repairableGeneration(sql, plan);
    if (generation === undefined) continue;
    const previous = generationOutputs(generation);
    const outputs = relocatedOutputs(previous, plan.outputs);
    if (outputs === undefined) continue;
    addSharedChecks(sql, previous, outputs, { proofs, addedRefs, locations, copy });
  }
  return locations.size === 0
    ? undefined
    : {
        kind: 'verify-seed-locations',
        locations: [...locations.values()],
        ...(copy && { copy: true }),
      };
}

function addSharedChecks(
  sql: SqlStorage,
  previous: readonly OutputSnapshot[],
  outputs: readonly OutputSnapshot[],
  checks: {
    readonly proofs: SeedLocationProofs;
    readonly addedRefs: ReadonlyMap<string, number>;
    readonly locations: Map<string, SeedLocationCheck>;
    readonly copy: boolean;
  },
): void {
  const { proofs, addedRefs, locations, copy } = checks;
  for (const [index, output] of outputs.entries()) {
    for (const [offset, artifact] of output.artifacts.entries()) {
      const before = previous[index]?.artifacts[offset]?.storageRef;
      if (artifact.storageRef === before) continue;
      const row = findArtifactBySha(sql, artifact.sha256);
      if (
        row?.owned !== 0 ||
        (!copy && row.refs + (addedRefs.get(artifact.sha256) ?? 0) <= 1) ||
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
  options: { readonly proofs: SeedProofLookup; readonly copy: boolean },
): OutputSnapshot[] {
  const { proofs, copy } = options;
  const locations = new Map<string, string>();
  const selected = new Set<string>();
  for (const [index, output] of proposed.entries()) {
    for (const [offset, artifact] of output.artifacts.entries()) {
      selectLocation(sql, artifact, previous[index]?.artifacts[offset]?.storageRef, {
        proofs,
        locations,
        selected,
        copy,
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

function acceptedProof(value: boolean | string | undefined): boolean {
  return value === true || typeof value === 'string';
}

function selectLocation(
  sql: SqlStorage,
  artifact: SeedLocationCheck,
  before: string | undefined,
  chosen: {
    readonly proofs: SeedProofLookup;
    readonly locations: Map<string, string>;
    readonly selected: Set<string>;
    readonly copy: boolean;
  },
): void {
  const { locations, proofs, selected, copy } = chosen;
  if (selected.has(artifact.sha256)) return;
  const row = findArtifactBySha(sql, artifact.sha256);
  if (row === undefined) return;
  locations.set(artifact.sha256, row.storage_ref);
  // An earlier repair in this batch may have advanced every live snapshot to this key.
  // Keep that already verified canonical location rather than moving it again for a later plan.
  if (
    acceptedProof(
      proofs.get(
        seedLocationKey({
          sha256: row.sha256,
          byteLength: row.byte_length,
          storageRef: row.storage_ref,
        }),
      ),
    )
  )
    return;
  if (
    row.owned === 0 &&
    row.byte_length === artifact.byteLength &&
    row.storage_ref === before &&
    artifact.storageRef !== before &&
    (copy
      ? typeof proofs.get(seedLocationKey(artifact)) === 'string'
      : row.refs <= 1 || acceptedProof(proofs.get(seedLocationKey(artifact))))
  ) {
    const proof = proofs.get(seedLocationKey(artifact));
    locations.set(artifact.sha256, typeof proof === 'string' ? proof : artifact.storageRef);
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

export interface PreparedSeedRepair extends RepairGroup {
  readonly generationId: string;
  readonly outputs: readonly OutputSnapshot[];
  readonly verifiedLocations: readonly SeedLocationCheck[];
}

/** One retry's unchanged admission decision, before any current snapshot is changed. */
export function prepareSeedRepair(
  input: TxInput,
  plan: SeedLocations,
  proofs: SeedProofLookup,
): PreparedSeedRepair | undefined {
  const { sql } = input;
  const generation = repairableGeneration(sql, plan);
  if (generation === undefined) return undefined;
  const previous = generationOutputs(generation);
  const proposed = relocatedOutputs(previous, plan.outputs);
  const outputs =
    proposed === undefined
      ? undefined
      : protectedOutputs(sql, previous, proposed, { proofs, copy: input.packSchemaVersion === 2 });
  const entry = findEntry(sql, generation.entry_id);
  if (
    outputs === undefined ||
    entry === undefined ||
    unwritableRecord(
      headerFieldsOf(input, entry, generation, outputs),
      input.limits.maxRecordBytes,
    ) !== undefined
  )
    return undefined;
  const repairs = seedRelocations(sql, previous, outputs);
  return {
    entryId: generation.entry_id,
    generationId: generation.generation_id,
    outputs,
    repairs,
    verifiedLocations: repairs.filter((repair) =>
      acceptedProof(proofs.get(seedLocationKey(repair))),
    ),
    failureMarkers: repairs.flatMap((repair) => {
      const row = findArtifactBySha(sql, repair.sha256);
      const marker = artifactRepairMarker(sql, repair.sha256);
      return row !== undefined && artifactFailed(sql, row) && marker !== undefined
        ? [[repair.sha256, marker] as [string, string]]
        : [];
    }),
  };
}

/** Bounded by the submitted plans, with no scope-wide query before the rare alarm is armed. */
export function hasSeedRelocations(
  input: TxInput,
  plans: readonly SeedLocations[],
  proofs: SeedLocationProofs,
): boolean {
  return plans.some((plan) => (prepareSeedRepair(input, plan, proofs)?.repairs.length ?? 0) > 0);
}

export function publishSeedRepair(
  input: TxInput,
  prepared: PreparedSeedRepair,
  events: EventInput[],
): void {
  const { sql, revision, now, scopeId } = input;
  const generation = findGeneration(sql, prepared.generationId);
  const entry = findEntry(sql, prepared.entryId);
  if (generation === undefined || entry?.current_generation_id !== prepared.generationId) {
    throw new Error('the prepared seed generation changed');
  }
  for (const repair of prepared.repairs) {
    if (!relocateBorrowedArtifact(input, repair)) {
      throw new Error('the prepared borrowed artifact location changed');
    }
  }
  const outputs = encodeStoredOutputs(prepared.outputs, input.packSchemaVersion === 2);
  sql.exec(
    `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
    outputs,
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
  if (entry.revision !== revision) events.push(entryStateEvent(sql, generation.entry_id));
  events.push({
    entityType: 'generation',
    entityId: generation.generation_id,
    kind: 'generation.committed',
    payload: {
      generation: toPublicGeneration(scopeId, { ...generation, outputs }),
      entryState: toEntryState(requireEntry(sql, generation.entry_id)),
      supersededGenerationId: null,
      attempt: null,
    },
  });
}

/** Ordinary retries need no scope scan. Actual canonical moves use the durable path below. */
export function repairSeedEntries(
  input: TxInput,
  plans: readonly SeedLocations[],
  events: EventInput[],
  proofs: SeedLocationProofs,
): number {
  let repaired = 0;
  for (const plan of plans) {
    const prepared = prepareSeedRepair(input, plan, proofs);
    if (prepared === undefined) continue;
    if (prepared.repairs.length > 0) throw new Error('a seed relocation needs a durable job');
    publishSeedRepair(input, prepared, events);
    repaired += 1;
  }
  return repaired;
}

/** A lease ending during another group's continuation cannot admit a previously skipped retry. */
export function eligibleSeedRepairs(
  input: TxInput,
  plans: readonly SeedLocations[],
): readonly SeedLocations[] {
  return plans.filter((plan) => repairableGeneration(input.sql, plan) !== undefined);
}

/** Pin possible future moves before an older in-flight projection can acknowledge them. */
export function potentialSeedRepairGroup(input: TxInput, plan: SeedLocations): RepairGroup {
  const generation = repairableGeneration(input.sql, plan);
  const previous = generation === undefined ? undefined : generationOutputs(generation);
  const outputs = previous === undefined ? undefined : relocatedOutputs(previous, plan.outputs);
  return {
    entryId: plan.identity.entryId,
    repairs:
      previous === undefined || outputs === undefined
        ? []
        : seedRelocations(input.sql, previous, outputs),
    failureMarkers: [],
  };
}
