import { type ArtifactRepair, repairSnapshotStep } from './artifact-repair.ts';
import { artifactRepairMarker } from './artifacts.ts';
import type { CommitOutcome, CommitPlan, Publication } from './commit.ts';
import {
  advanceRepairJob,
  beginRepairJob,
  readRepairValue,
  releaseRepairGroup,
  type RepairGroup,
  type RepairJob,
  type RepairPending,
  type RepairStep,
} from './repair-jobs.ts';
import {
  probeRepairPublication,
  probeRepairSnapshot,
  repairPreflightInput,
  stageRepairPublication,
} from './repair-probes.ts';
import { type Refusal, refuse } from './state.ts';
import { record, type TxInput } from './tx.ts';

type CommitRepairPublish = (input: TxInput, plan: CommitPlan, state: Publication) => CommitOutcome;

/** Maps and sets are serialized explicitly; a resumed alarm never derives new output IDs. */
interface PreparedCommit {
  readonly plan: Omit<
    CommitPlan,
    'dependencyTagIds' | 'artifactIds' | 'missingUploads' | 'checkedUploads'
  > & {
    readonly dependencyTagIds: readonly [string, string][];
    readonly artifactIds: readonly [string, string][];
    readonly missingUploads: readonly string[];
    readonly checkedUploads: readonly string[];
  };
  readonly publication: Omit<Publication, 'repairs'> & {
    readonly repairs: readonly ArtifactRepair[];
  };
}

/** Final publication uses a fresh revision, but the lease/admission decision was made at acceptance. */
function publishPreparedCommit(
  input: TxInput,
  job: RepairJob,
  publish: CommitRepairPublish,
): CommitOutcome {
  const prepared = readRepairValue<PreparedCommit>(input.sql, job.id, 'publication');
  return publish(
    input,
    {
      ...prepared.plan,
      dependencyTagIds: new Map(prepared.plan.dependencyTagIds),
      artifactIds: new Map(prepared.plan.artifactIds),
      missingUploads: new Set(prepared.plan.missingUploads),
      checkedUploads: new Set(prepared.plan.checkedUploads),
    },
    {
      ...prepared.publication,
      repairs: new Map(prepared.publication.repairs.map((repair) => [repair.sha256, repair])),
    },
  );
}

/** One primary-key snapshot per step; the alarm supplies the invocation's fixed step budget. */
export function advanceCommitRepair(
  input: TxInput,
  job: RepairJob,
  publish: CommitRepairPublish,
): RepairStep<CommitOutcome | Refusal> {
  const group = readRepairValue<RepairGroup>(input.sql, job.id, 'group-0');
  if (job.phase === 'publish') {
    const value = stageRepairPublication(input, group.entryId, () =>
      publishPreparedCommit(input, job, publish),
    );
    return { kind: 'completed', value };
  }
  const candidate = repairPreflightInput(input, job);
  const repairs = new Map(group.repairs.map((repair) => [repair.sha256, repair]));
  const cursor = {
    after: job.after,
    excluding: new Set([group.entryId]),
    apply: job.phase === 'apply',
  };
  const step = repairSnapshotStep(candidate, repairs, cursor);
  if (step.failure !== undefined) {
    if (job.phase === 'apply') throw new Error('a preflighted repair snapshot changed');
    releaseRepairGroup(input.sql, job.id, group);
    return { kind: 'completed', value: refuse('too_large', step.failure) };
  }
  if (job.phase === 'apply' && step.changed) record(input, []);
  const next = {
    ...job,
    after: step.after,
  };
  if (job.phase === 'preflight' && step.changed)
    probeRepairSnapshot(candidate, next, repairs, cursor);
  if (step.done) {
    next.after = '';
    next.phase = job.phase === 'preflight' ? 'apply' : 'publish';
    if (job.phase === 'preflight')
      probeRepairPublication(candidate, next, () => publishPreparedCommit(candidate, job, publish));
  }
  advanceRepairJob(input.sql, next);
  return { kind: 'pending' };
}

export function prepareCommitRepair(
  input: TxInput,
  plan: CommitPlan,
  state: Publication,
): RepairPending {
  const publication: PreparedCommit = {
    plan: {
      ...plan,
      dependencyTagIds: [...plan.dependencyTagIds],
      artifactIds: [...plan.artifactIds],
      missingUploads: [...plan.missingUploads],
      checkedUploads: [...plan.checkedUploads],
    },
    publication: { ...state, repairs: [...state.repairs.values()] },
  };
  const group: RepairGroup = {
    entryId: state.entry.entry_id,
    repairs: [...state.repairs.values()],
    failureMarkers: [...state.repairs.keys()].flatMap((sha256) => {
      const marker = artifactRepairMarker(input.sql, sha256);
      return marker === undefined ? [] : [[sha256, marker] as [string, string]];
    }),
  };
  return beginRepairJob(input.sql, {
    operation: 'commit',
    preparedAt: input.now,
    fromRevision: input.revision,
    limits: input.limits,
    attemptId: plan.attemptId,
    publication,
    groups: [group],
  });
}
