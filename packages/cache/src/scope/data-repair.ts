import { type ArtifactRepair, repairSnapshotStep } from './artifact-repair.ts';
import { artifactRepairMarker } from './artifacts.ts';
import type { DataPlan, DataSetOutcome } from './data.ts';
import type { BlobStore } from './io.ts';
import {
  advanceRepairJob,
  beginRepairJob,
  isRepairPending,
  isRepairStart,
  readRepairValue,
  releaseRepairGroup,
  type RepairGroup,
  type RepairJob,
  type RepairPending,
  type RepairStart,
  type RepairStep,
} from './repair-jobs.ts';
import { probeRepairPublication, repairPreflightInput } from './repair-probes.ts';
import { type Refusal, isRefusal, refuse } from './state.ts';
import { record, type TxInput } from './tx.ts';

type DataRepairApply = (
  input: TxInput,
  plan: DataPlan,
) => DataSetOutcome | Refusal | RepairPending | RepairStart<DataSetOutcome | Refusal>;

interface PreparedData {
  readonly plan: DataPlan;
  readonly acceptedAt: number;
  readonly limits: TxInput['limits'];
}

export function prepareDataRepair(
  input: TxInput,
  plan: DataPlan,
  {
    repair,
    unchanged,
    alarmPrepared,
    blobs,
    needsRepair,
    restart,
  }: {
    readonly repair: ArtifactRepair;
    readonly unchanged: boolean;
    readonly alarmPrepared: boolean;
    readonly blobs?: BlobStore | undefined;
    readonly needsRepair: () => boolean;
    readonly restart: DataRepairApply;
  },
): RepairStart<DataSetOutcome | Refusal> | RepairPending {
  const marker = artifactRepairMarker(input.sql, repair.sha256);
  const group: RepairGroup = {
    entryId: unchanged ? '' : plan.identity.entryId,
    repairs: [repair],
    failureMarkers: marker === undefined ? [] : [[repair.sha256, marker]],
  };
  // The gateway's carried bytes remain with its live call; the alarm can use existing storage
  // after a restart. They are not duplicated in the durable private publication.
  const publication: PreparedData = {
    plan: { ...plan, input: { ...plan.input, bytes: undefined } },
    acceptedAt: input.now,
    limits: input.limits,
  };
  if (alarmPrepared)
    return beginRepairJob(input.sql, {
      operation: 'data',
      preparedAt: input.now,
      fromRevision: input.revision,
      limits: input.limits,
      attemptId: null,
      publication,
      groups: [group],
    });
  let selected = plan;
  let failedCopy: Refusal | undefined;
  const namespace = input.repairNamespace;
  return {
    kind: 'repair-start',
    ...(namespace !== undefined && {
      prepare: async () => {
        // A projection may have healed the old copy while the earlier settle chain drained.
        if (!needsRepair()) return;
        const key = await blobs?.copyRepair?.(plan.input.value, {
          namespace,
          attemptId: crypto.randomUUID(),
        });
        if (key === undefined) {
          failedCopy = refuse(
            'artifact_missing',
            'the replacement data upload could not be copied',
          );
          return;
        }
        selected = {
          ...plan,
          input: { ...plan.input, value: { ...plan.input.value, storageRef: key } },
        };
      },
    }),
    start: (tx) => {
      if (failedCopy !== undefined) return failedCopy;
      // The projection drained while the alarm was armed may have verified the old location.
      // Re-evaluate under the same writer queue; a healed location needs no repair job at all.
      const result = restart({ ...tx, now: input.now, limits: input.limits }, selected);
      if (isRepairStart(result))
        throw new Error('a prepared data repair requested preparation again');
      return result;
    },
  };
}

/** The data upload stays pinned by the writer barrier until its final adoption answers. */
export function advanceDataRepair(
  input: TxInput,
  job: RepairJob,
  apply: DataRepairApply,
): RepairStep<DataSetOutcome | Refusal> {
  const group = readRepairValue<RepairGroup>(input.sql, job.id, 'group-0');
  if (job.phase === 'publish') {
    const prepared = readRepairValue<PreparedData>(input.sql, job.id, 'publication');
    const value = apply(
      { ...input, now: prepared.acceptedAt, limits: prepared.limits },
      prepared.plan,
    );
    if (isRepairStart(value) || isRepairPending(value))
      throw new Error('a prepared data repair recurred');
    if (isRefusal(value)) throw new Error('an admitted data repair was refused during publication');
    releaseRepairGroup(input.sql, job.id, group, true);
    return { kind: 'completed', value };
  }
  const candidate = repairPreflightInput(input, job);
  const step = repairSnapshotStep(
    candidate,
    new Map(group.repairs.map((repair) => [repair.sha256, repair])),
    {
      after: job.after,
      excluding: new Set([group.entryId]),
      apply: job.phase === 'apply',
    },
  );
  if (step.failure !== undefined) {
    if (job.phase === 'apply') throw new Error('a preflighted data repair snapshot changed');
    releaseRepairGroup(input.sql, job.id, group);
    return { kind: 'completed', value: refuse('too_large', step.failure) };
  }
  if (job.phase === 'apply' && step.changed) record(input, []);
  const next = {
    ...job,
    after: step.after,
    matched: (job.matched ?? 0) + (job.phase === 'preflight' && step.changed ? 1 : 0),
  };
  if (step.done) {
    next.after = '';
    next.phase = job.phase === 'preflight' ? 'apply' : 'publish';
    if (job.phase === 'preflight') {
      const prepared = readRepairValue<PreparedData>(input.sql, job.id, 'publication');
      probeRepairPublication(
        candidate,
        next,
        () => apply(candidate, prepared.plan),
        prepared.plan.identity.entryId,
      );
    }
  }
  advanceRepairJob(input.sql, next);
  return { kind: 'pending' };
}
