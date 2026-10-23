import type { SeedEntriesResult } from '@stayingupwind/host/cache';

import { repairSnapshotStep } from './artifact-repair.ts';
import { findArtifactBySha } from './artifacts.ts';
import type { EventInput } from './history.ts';
import {
  advanceRepairJob,
  beginRepairJob,
  hasRepairValue,
  readRepairValue,
  releaseRepairGroup,
  type RepairGroup,
  type RepairJob,
  type RepairPending,
  type RepairStep,
  writeRepairValue,
} from './repair-jobs.ts';
import {
  eligibleSeedRepairs,
  potentialSeedRepairGroup,
  prepareSeedRepair,
  publishSeedRepair,
  seedLocationKey,
  type PreparedSeedRepair,
  type SeedLocationCheck,
  type SeedLocationProofs,
  type SeedLocations,
  type SeedProofLookup,
} from './seed-repair.ts';
import type { Refusal } from './state.ts';
import { record, type TxInput } from './tx.ts';

/** Initial fresh admissions are durable before ordered retries begin; success still waits for all. */
export function prepareSeedPublication(
  input: TxInput,
  plans: readonly SeedLocations[],
  proofs: SeedLocationProofs,
  result: SeedEntriesResult,
): RepairPending {
  // Pin every possible later retry before an older projection can acknowledge its failed key.
  // These conservative pins do not imply that an unverified or oversized retry will be accepted.
  const eligible = eligibleSeedRepairs(input, plans);
  const groups = eligible.map((plan) => potentialSeedRepairGroup(input, plan));
  const pending = beginRepairJob(input.sql, {
    operation: 'seed',
    limits: input.limits,
    preparedAt: input.now,
    fromRevision: input.revision,
    attemptId: null,
    publication: result,
    groups,
  });
  for (const [index, plan] of eligible.entries()) {
    writeRepairValue(
      input.sql,
      pending.jobId,
      `seed-proofs-${index}`,
      proofEntriesFor(input.sql, plan, proofs),
    );
    writeRepairValue(input.sql, pending.jobId, `seed-plan-${index}`, {
      entry: { generation: { generationId: plan.entry.generation.generationId } },
      identity: { entryId: plan.identity.entryId },
      outputs: plan.outputs,
    } satisfies SeedLocations);
  }
  return pending;
}

/** Only this retry's proposed/current locations are materialized, never the whole batch map. */
function proofEntriesFor(
  sql: SqlStorage,
  plan: SeedLocations,
  proofs: SeedLocationProofs,
): readonly (readonly [string, boolean | string])[] {
  const keys = new Set<string>();
  for (const output of plan.outputs) {
    for (const artifact of output.artifacts) {
      keys.add(seedLocationKey(artifact));
      const canonical = findArtifactBySha(sql, artifact.sha256);
      if (canonical !== undefined)
        keys.add(
          seedLocationKey({
            sha256: canonical.sha256,
            byteLength: canonical.byte_length,
            storageRef: canonical.storage_ref,
          }),
        );
      const copied = proofs.get(seedLocationKey(artifact));
      if (typeof copied === 'string')
        keys.add(seedLocationKey({ ...artifact, storageRef: copied }));
    }
  }
  return [...keys].flatMap((key) => {
    const proof = proofs.get(key);
    return proof === undefined ? [] : [[key, proof] as const];
  });
}

function preparedProofs(sql: SqlStorage, job: RepairJob, plan: SeedLocations): SeedProofLookup {
  const proofs = new Map(
    readRepairValue<readonly (readonly [string, boolean | string])[]>(
      sql,
      job.id,
      `seed-proofs-${job.group}`,
    ),
  );
  for (const output of plan.outputs) {
    for (const artifact of output.artifacts) {
      const name = `seed-canonical-${artifact.sha256}`;
      if (hasRepairValue(sql, job.id, name)) {
        const location = readRepairValue<SeedLocationCheck>(sql, job.id, name);
        proofs.set(seedLocationKey(location), true);
      }
    }
  }
  return proofs;
}

function nextSeedRetry(input: TxInput, job: RepairJob): void {
  advanceRepairJob(input.sql, {
    ...job,
    group: job.group + 1,
    phase: 'preflight',
    after: '',
  });
}

/**
 * One retry or one primary-key snapshot per step. Each retry completes its own preflight before
 * any of its shared snapshots change: refusing it preserves fresh entries and earlier retries.
 * The writer barrier preserves the accepted order, while alarms can resume after any reset.
 */
export function advancePreparedSeed(
  input: TxInput,
  job: RepairJob,
): RepairStep<SeedEntriesResult | Refusal> {
  if (job.group === job.groupCount) return finishPreparedSeed(input, job);
  const name = `seed-active-${job.group}`;
  if (!hasRepairValue(input.sql, job.id, name)) {
    const plan = readRepairValue<SeedLocations>(input.sql, job.id, `seed-plan-${job.group}`);
    const prepared = prepareSeedRepair(input, plan, preparedProofs(input.sql, job, plan));
    if (prepared === undefined) {
      nextSeedRetry(input, job);
    } else {
      writeRepairValue(input.sql, job.id, name, prepared);
      if (prepared.repairs.length === 0) {
        advanceRepairJob(input.sql, { ...job, phase: 'publish' });
      }
    }
    return { kind: 'pending' };
  }
  const prepared = readRepairValue<PreparedSeedRepair>(input.sql, job.id, name);
  if (job.phase === 'publish') {
    const events: EventInput[] = [];
    publishSeedRepair(input, prepared, events);
    for (const location of prepared.verifiedLocations) {
      writeRepairValue(input.sql, job.id, `seed-canonical-${location.sha256}`, location);
    }
    record(input, events);
    const result = readRepairValue<SeedEntriesResult>(input.sql, job.id, 'publication');
    writeRepairValue(input.sql, job.id, 'publication', { ...result, revision: input.revision });
    // Only a published group's actual relocations may clear its captured failure observations.
    writeRepairValue(input.sql, job.id, `seed-moved-${job.group}`, prepared.repairs.length > 0);
    nextSeedRetry(input, job);
    return { kind: 'pending' };
  }
  const step = repairSnapshotStep(
    input,
    new Map(prepared.repairs.map((repair) => [repair.sha256, repair])),
    { after: job.after, excluding: new Set([prepared.entryId]), apply: job.phase === 'apply' },
  );
  if (step.failure !== undefined) {
    if (job.phase === 'apply') throw new Error('a preflighted seed repair snapshot changed');
    nextSeedRetry(input, job);
    return { kind: 'pending' };
  }
  if (job.phase === 'apply' && step.changed) record(input, []);
  advanceRepairJob(input.sql, {
    ...job,
    after: step.done ? '' : step.after,
    phase: step.done ? (job.phase === 'preflight' ? 'apply' : 'publish') : job.phase,
  });
  return { kind: 'pending' };
}

/** All snapshots and each retry's publication are complete before bounded final fence cleanup. */
function finishPreparedSeed(
  input: TxInput,
  job: RepairJob,
): RepairStep<SeedEntriesResult | Refusal> {
  const index = job.after === '' ? 0 : Number(job.after);
  if (index < job.groupCount) {
    const potential = readRepairValue<RepairGroup>(input.sql, job.id, `group-${index}`);
    releaseRepairGroup(input.sql, job.id, potential);
    const movedName = `seed-moved-${index}`;
    if (
      hasRepairValue(input.sql, job.id, movedName) &&
      readRepairValue<boolean>(input.sql, job.id, movedName)
    ) {
      const moved = readRepairValue<PreparedSeedRepair>(input.sql, job.id, `seed-active-${index}`);
      releaseRepairGroup(input.sql, job.id, moved, true);
    }
    advanceRepairJob(input.sql, { ...job, phase: 'publish', after: String(index + 1) });
    return { kind: 'pending' };
  }
  return {
    kind: 'completed',
    value: readRepairValue<SeedEntriesResult>(input.sql, job.id, 'publication'),
  };
}
