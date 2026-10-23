import {
  generationTagSchema,
  isRepairStorageRef,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_ENTRY,
  type OutputSnapshot,
} from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import {
  type SeedEntriesInput,
  type SeedEntriesResult,
  type SeedEntryInput,
  type SeedScopeInput,
  type SeedScopeResult,
} from '@stayingupwind/host/cache';

import type { Logger } from '../logger.ts';
import {
  artifactFailed,
  artifactIdsFor,
  findArtifactBySha,
  referenceBuildArtifacts,
} from './artifacts.ts';
import {
  type EntryIdentity,
  findEntry,
  identifyEntry,
  insertEntry,
  publishEntry,
  requireEntry,
  retireEntries,
} from './entries.ts';
import { findGeneration, insertGeneration, retireGenerations } from './generations.ts';
import type { EventInput } from './history.ts';
import { prepareFirstPackSchema } from './pack-capability.ts';
import { type PackHeaderFields, unwritableRecord } from './records.ts';
import type { RepairPending } from './repair-jobs.ts';
import { toEntry, toEntryState, toPublicGeneration, toScope } from './rows.ts';
import {
  existingSeedArtifactLengths,
  reserveSeedArtifactLengths,
} from './seed-artifact-lengths.ts';
import { deferSeedRepair } from './seed-preparation.ts';
import { prepareSeedPublication } from './seed-repair-job.ts';
import {
  hasSeedRelocations,
  repairSeedEntries,
  seedRepairVerification,
  type SeedLocationProofs,
  type SeedRepairVerification,
} from './seed-repair.ts';
import { isRefusal, readScope, type Refusal, refuse, requireActiveScope } from './state.ts';
import {
  condemnationOf,
  weighInvalidations,
  replaceEntryTags,
  type TagRef,
  tagRefsFor,
} from './tags.ts';
import { type Apply, inChunks, record, type TxInput } from './tx.ts';

export { advancePreparedSeed } from './seed-repair-job.ts';
export { finishSeedRepair, needsSeedVerification } from './seed-repair.ts';

/**
 * What a deploy does to a scope: creates it once, seeds each entry's build generation
 * (once: a retried batch skips what it already holds), and retires it when its deployment is no
 * longer served.
 */

const OUTPUT_ID_PREFIX = 'out';
/**
 * How many entries of a batch are planned at once. A batch may hold two hundred, each naming up to
 * a thousand artifacts and a thousand tags, and each id a digest: planned all at once, every digest
 * of the batch would be out together, before the first entry reached the transaction.
 */
const SEED_PLANS_AT_ONCE = 8;

export function applySeedScope(input: TxInput, seed: SeedScopeInput): SeedScopeResult {
  const { sql, now, revision, history } = input;
  const { scope } = seed;
  const existing = readScope(sql);
  if (existing !== undefined) {
    // Retirement is for good: a seed that finds the scope retired, retention about to erase it
    // maybe, answers so rather than that it found the scope seeded.
    if (existing.status === 'retired') {
      return { kind: 'conflict', reason: 'the scope is retired' };
    }
    if (existing.deployment_id === scope.deploymentId && existing.build_id === scope.buildId) {
      // A deployment seeded again for the same build keeps its history as the seed now says.
      history.reseed(sql, seed, now);
      // The history's fields first: what it says beside the authority's own never replaces them.
      return {
        ...history.seeded(sql),
        kind: 'already-seeded',
        revision: existing.revision,
        token: '',
      };
    }
    return {
      kind: 'conflict',
      reason: `the scope is seeded for deployment ${existing.deployment_id} (build ${existing.build_id})`,
    };
  }
  const { packSchemaVersion, repairNamespace } = prepareFirstPackSchema(sql, seed);
  sql.exec(
    `INSERT INTO scope (
       scope_id, organization_id, project_id, environment_id, deployment_id, key_schema_version,
       build_id, pack_schema_version, repair_namespace, status, seeded_at, retired_at, revision, entry_count, body_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, 0, 0, 0)`,
    scope.scopeId,
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    scope.deploymentId,
    scope.keySchemaVersion,
    scope.buildId,
    packSchemaVersion,
    repairNamespace,
    now,
  );
  // Decided before the seed's own event, which is the scope's first when it records at all.
  history.begin(sql, seed);
  const row = readScope(sql);
  const events: EventInput[] =
    row === undefined
      ? []
      : [
          {
            entityType: 'scope',
            entityId: scope.scopeId,
            kind: 'scope.seeded',
            payload: { scope: toScope(row) },
          },
        ];
  record(input, events);
  return { ...history.seeded(sql), kind: 'seeded', revision, token: '' };
}

interface SeedPlan {
  readonly entry: SeedEntryInput;
  readonly identity: EntryIdentity;
  readonly tagRefs: readonly TagRef[];
  readonly outputs: readonly OutputSnapshot[];
  /** Why the entry's generation may not carry its tags (`tagsRefusal`): it is then not seeded. */
  readonly tagsRefused: string | undefined;
}

type SeedRefusal = SeedEntriesResult['refused'][number];

export function logSeedRefusals(log: Logger, result: SeedEntriesResult | Refusal): void {
  if (isRefusal(result)) return;
  for (const refused of result.refused) {
    log.warn('build entry not seeded', {
      pathname: refused.descriptor.pathname,
      detail: refused.reason,
    });
  }
}

function addedSeedReferences(plans: readonly SeedPlan[]): Map<string, number> {
  const added = new Map<string, number>();
  for (const plan of plans) {
    for (const output of plan.outputs) {
      for (const artifact of output.artifacts) {
        added.set(artifact.sha256, (added.get(artifact.sha256) ?? 0) + 1);
      }
    }
  }
  return added;
}

/** A tag's value as a generation may carry one: what a commit's tags are held to. */
const TAG_VALUE = generationTagSchema.shape.value;

/**
 * Why the build's generation of an entry may not carry its tags, as a generation's are bounded
 * (`MAX_TAGS_PER_ENTRY`, `MAX_TAG_LENGTH`), or nothing where it may. The batch's shape leaves these
 * to be judged here, entry by entry: a route's tags are its build's, and one route past them is no
 * reason to leave the rest of its batch unseeded. A regeneration of such an entry is refused for
 * them as well, by the runtime that renders it.
 */
function tagsRefusal(tags: SeedEntryInput['generation']['tags']): string | undefined {
  if (tags.length > MAX_TAGS_PER_ENTRY) {
    return `the build left ${tags.length} cache tags on the entry; a generation may carry ${MAX_TAGS_PER_ENTRY}`;
  }
  return tags.every(({ value }) => TAG_VALUE.validate(value))
    ? undefined
    : `the build left a cache tag longer than a tag may be on the entry; a tag may have ${MAX_TAG_LENGTH} characters`;
}

export async function planSeedEntries(
  input: TxInput,
  batch: SeedEntriesInput,
  proofs: SeedLocationProofs = new Map(),
  prepareRepair?: () => Promise<void>,
): Promise<Apply<SeedEntriesResult | Refusal | SeedRepairVerification | RepairPending>> {
  const plans = await inChunks(batch.entries, SEED_PLANS_AT_ONCE, async (entry) => {
    // Judged before a tag of it is named: an entry that may not carry its tags keeps none.
    const tagsRefused = tagsRefusal(entry.generation.tags);
    const [identity, tagRefs, artifactIds] = await Promise.all([
      identifyEntry(input.scopeId, entry.descriptor, entry.allowQuery),
      tagsRefused === undefined ? tagRefsFor(input.scopeId, entry.generation.tags) : [],
      artifactIdsFor(
        input.scopeId,
        entry.generation.outputs.flatMap((output) =>
          output.artifacts.map((artifact) => artifact.sha256),
        ),
      ),
    ]);
    return { entry, identity, tagRefs, outputs: seedOutputs(entry, artifactIds), tagsRefused };
  });
  // Existing failed build retries alone pay for draining projection and arming continuation.
  // The transaction below rechecks repairability after that drain, before publishing fresh rows.
  const repairing = hasSeedRelocations(input, plans, proofs);
  if (repairing) await prepareRepair?.();
  const apply: Apply<SeedEntriesResult | Refusal | SeedRepairVerification | RepairPending> = () =>
    applySeedEntries(input, plans, proofs, { repairPrepared: repairing });
  // The caller rolls this complete SQL-only preparation back before accepting its durable job.
  // A host's initial fresh-event row limit must fail before any fresh row or repair is accepted.
  return repairing
    ? Object.assign(apply, {
        preflight: () => {
          applySeedEntries(input, plans, proofs, {
            probeInitialHistory: true,
            repairPrepared: true,
          });
        },
      })
    : apply;
}

function seedOutputs(
  entry: SeedEntryInput,
  artifactIds: ReadonlyMap<string, string>,
): OutputSnapshot[] {
  return entry.generation.outputs.map((output) => {
    return {
      outputId: createId(OUTPUT_ID_PREFIX),
      representationKey: output.representationKey,
      pathname: output.pathname,
      status: output.status,
      headers: output.headers,
      compute: output.compute,
      response: output.response,
      ...(output.staticPagePrivacy !== undefined && {
        staticPagePrivacy: output.staticPagePrivacy,
      }),
      htmlSize: output.htmlSize,
      artifacts: output.artifacts.map((artifact) => {
        return {
          artifactId: artifactIds.get(artifact.sha256) ?? '',
          sha256: artifact.sha256,
          byteLength: artifact.byteLength,
          contentType: artifact.contentType,
          encoding: artifact.encoding,
          role: artifact.role,
          storageRef: artifact.storageRef,
        };
      }),
    };
  });
}

/** What the delivery record of an entry's build generation is made of. */
function recordFields(
  scopeId: string,
  plan: SeedPlan,
  buildId: string,
  packSchemaVersion?: 1 | 2,
): PackHeaderFields {
  const { generation } = plan.entry;
  return {
    scopeId,
    buildId,
    packSchemaVersion,
    entry: {
      entryId: plan.identity.entryId,
      kind: plan.identity.kind,
      route: plan.identity.route,
      pathname: plan.identity.pathname,
    },
    generation: {
      generationId: generation.generationId,
      seq: 1,
      source: 'build',
      cacheTimestamp: generation.cacheTimestamp,
      producedAt: generation.producedAt,
      policy: generation.policy,
      status: generation.status,
      headers: generation.headers,
      tags: generation.tags,
    },
    outputs: plan.outputs,
  };
}

/** V2 seeds reuse this scope's repaired canonical copy, preserving existing borrowed accounting. */
function canonicalSeedOutputs(
  input: TxInput,
  outputs: readonly OutputSnapshot[],
): readonly OutputSnapshot[] {
  if (input.packSchemaVersion !== 2 || input.repairNamespace === undefined) return outputs;
  const prefix = `r/${input.repairNamespace}/`;
  return outputs.map((output) => ({
    ...output,
    artifacts: output.artifacts.map((artifact) => {
      const canonical = findArtifactBySha(input.sql, artifact.sha256);
      return canonical !== undefined &&
        canonical.byte_length === artifact.byteLength &&
        isRepairStorageRef(canonical.storage_ref) &&
        canonical.storage_ref.startsWith(prefix) &&
        !artifactFailed(input.sql, canonical)
        ? { ...artifact, storageRef: canonical.storage_ref }
        : artifact;
    }),
  }));
}

function seedOne(input: TxInput, plan: SeedPlan, events: EventInput[]): void {
  const { sql, scopeId, now, revision } = input;
  const { generation } = plan.entry;
  const entry = insertEntry(sql, {
    identity: plan.identity,
    groupInstanceId: plan.entry.groupInstanceId,
    revision,
    now,
  });
  events.push({
    entityType: 'entry',
    entityId: entry.entry_id,
    kind: 'entry.created',
    payload: { entry: toEntry(scopeId, entry) },
  });
  const outputs = canonicalSeedOutputs(input, plan.outputs);
  let bodyBytes = 0;
  for (const output of outputs) {
    for (const artifact of output.artifacts) {
      bodyBytes += artifact.byteLength;
    }
  }
  // The build's blobs are its deploy's, under its keys: referenced, never deleted here.
  referenceBuildArtifacts(
    sql,
    outputs.flatMap((output) => output.artifacts),
    now,
  );
  // The build's output is older than anything its scope has recorded. An invalidation of one of its
  // tags, recorded while the deploy's batches were still on their way, reached that output all the
  // same, and the generation arrives condemned by it, as one seeded before it was condemned
  // (`condemnCurrent`): its record goes out at a later revision, which a reader would otherwise take
  // to be past the invalidation.
  const condemned = condemnationOf(
    weighInvalidations(sql, {
      entryId: entry.entry_id,
      tagIds: plan.tagRefs.map((ref) => ref.tagId),
      afterRevision: 0,
    }).condemning,
  );
  insertGeneration(sql, {
    generationId: generation.generationId,
    entryId: entry.entry_id,
    seq: 1,
    source: 'build',
    attemptId: null,
    cacheTimestamp: generation.cacheTimestamp,
    producedAt: generation.producedAt,
    policy: generation.policy,
    status: generation.status,
    headers: generation.headers,
    tags: generation.tags,
    dependencyCoverage: generation.dependencyCoverage,
    dependencyRevision: revision,
    publishedRevision: revision,
    condemned,
    bodyBytes,
    producer: { kind: 'build' },
    outputs,
    compactRepairLocators: input.packSchemaVersion === 2,
    committedAt: now,
  });
  replaceEntryTags(sql, entry.entry_id, plan.tagRefs);
  publishEntry(sql, {
    entryId: entry.entry_id,
    generationId: generation.generationId,
    seq: 1,
    revision,
    now,
  });
  const published = findGeneration(sql, generation.generationId);
  if (published !== undefined) {
    events.push({
      entityType: 'generation',
      entityId: generation.generationId,
      kind: 'generation.committed',
      payload: {
        generation: toPublicGeneration(scopeId, published),
        entryState: toEntryState(requireEntry(sql, entry.entry_id)),
        supersededGenerationId: null,
        // The build's own generation: nothing attempted it, so there is no attempt to report.
        attempt: null,
      },
    });
  }
}

/** The ids this batch could collide with, without loading any generation's outputs. */
function existingGenerationIds(sql: SqlStorage, plans: readonly SeedPlan[]): Set<string> {
  if (plans.length === 0) return new Set();
  const ids = plans.map((plan) => plan.entry.generation.generationId);
  const rows = sql
    .exec<{ generation_id: string }>(
      `SELECT generation_id FROM generations
       WHERE generation_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(ids),
    )
    .toArray();
  return new Set(rows.map((row) => row.generation_id));
}

/** Shared batch reservations, after the unchanged tag and delivery-record admission checks. */
function reserveSeedPlan(
  plan: SeedPlan,
  generationId: string,
  generationIds: ReadonlySet<string>,
  artifactLengths: Map<string, number>,
): string | undefined {
  if (generationIds.has(generationId)) {
    return 'the build generation id is already in use';
  }
  return reserveSeedArtifactLengths(artifactLengths, plan.outputs)
    ? undefined
    : 'the build gives different byte lengths for the same artifact SHA';
}

function applySeedEntries(
  input: TxInput,
  plans: readonly SeedPlan[],
  proofs: SeedLocationProofs,
  options: { readonly probeInitialHistory?: true; readonly repairPrepared?: boolean } = {},
): SeedEntriesResult | Refusal | SeedRepairVerification | RepairPending {
  const { sql, limits, revision } = input;
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  const events: EventInput[] = [];
  const planned = new Set<string>();
  const retries: SeedPlan[] = [];
  const fresh = plans.filter((plan) => {
    const { entryId } = plan.identity;
    // A batch that names one entry twice seeds it once.
    if (planned.has(entryId)) {
      return false;
    }
    planned.add(entryId);
    if (findEntry(sql, entryId) !== undefined) {
      retries.push(plan);
      return false;
    }
    return true;
  });
  // An entry no record of could ever be written is left out and said so, and the rest of the
  // batch is seeded without it. Seeded, it would be current with nothing to deliver: its record
  // retried on every settle, failing every time, and enough of them ahead in that queue to hold up
  // every other entry of the scope. Unseeded, it is served as an entry without a record is. So is
  // one whose generation may not carry its tags, which no record could carry either.
  const seedable: SeedPlan[] = [];
  const refused: SeedRefusal[] = [];
  // The generation primary key is scope-wide, even when each entry's identity is different.
  // One lookup by this batch's ids, inside the same transaction, avoids failing every
  // unrelated entry at a later INSERT. A refused entry does not reserve an id for the batch.
  const generationIds = existingGenerationIds(sql, fresh);
  const artifactLengths = existingSeedArtifactLengths(sql, fresh);
  for (const plan of fresh) {
    let reason =
      plan.tagsRefused ??
      unwritableRecord(
        recordFields(input.scopeId, plan, scope.build_id, input.packSchemaVersion),
        limits.maxRecordBytes,
      );
    const generationId = plan.entry.generation.generationId;
    reason ??= reserveSeedPlan(plan, generationId, generationIds, artifactLengths);
    if (reason === undefined) {
      seedable.push(plan);
      generationIds.add(generationId);
    } else {
      refused.push({ descriptor: plan.entry.descriptor, reason });
    }
  }
  // The whole batch or none of it: a refusal leaves the transaction committed, so entries seeded
  // before one would stay behind at a revision nothing records — invisible to the edge, and
  // skipped as already present by the retry that follows the quota being raised.
  if (scope.entry_count + seedable.length > limits.entriesPerScope) {
    return refuse('quota_exceeded', 'the scope holds as many entries as it may');
  }
  const addedRefs = addedSeedReferences(retries.length > 0 ? seedable : []);
  const verification = seedRepairVerification(sql, retries, proofs, {
    addedRefs,
    copy: input.packSchemaVersion === 2,
  });
  if (verification !== undefined) return verification;
  const inserted = seedable.length;
  const skipped = plans.length - fresh.length;
  for (const plan of seedable) {
    seedOne(input, plan, events);
  }
  if (hasSeedRelocations(input, retries, proofs)) {
    if (options.repairPrepared !== true)
      deferSeedRepair(input, (next, probe) =>
        applySeedEntries(next, plans, proofs, {
          repairPrepared: true,
          ...(probe && { probeInitialHistory: true as const }),
        }),
      );
    if (options.probeInitialHistory === true) {
      if (inserted > 0) record(input, events);
      return { inserted, skipped, refused, revision: inserted > 0 ? revision : revision - 1 };
    }
    // No record at the accepted revision may escape while later retry groups can still repair
    // its references. Fresh entries have no earlier record; existing readers keep their cursor.
    for (const plan of seedable) {
      sql.exec('UPDATE entries SET record_revision = 0 WHERE entry_id = ?', plan.identity.entryId);
    }
    if (inserted > 0) record(input, []);
    return prepareSeedPublication(input, retries, proofs, {
      inserted,
      skipped,
      refused,
      revision: inserted > 0 ? revision : revision - 1,
      initialEvents: events,
    });
  }
  const repaired = repairSeedEntries(input, retries, events, proofs);
  if (inserted === 0 && repaired === 0) {
    return { inserted, skipped, refused, revision: revision - 1 };
  }
  record(input, events);
  return { inserted, skipped, refused, revision };
}

export interface RetireOutcome {
  readonly kind: 'retired' | 'already-retired' | 'unknown';
}

export function applyRetire(input: TxInput, reason: string): RetireOutcome {
  const { sql, now, revision, scopeId } = input;
  const scope = readScope(sql);
  if (scope === undefined) {
    return { kind: 'unknown' };
  }
  if (scope.status === 'retired') {
    return { kind: 'already-retired' };
  }
  sql.exec(`UPDATE scope SET status = 'retired', retired_at = ?`, now);
  retireEntries(sql, revision, now);
  retireGenerations(sql);
  record(input, [
    {
      entityType: 'scope',
      entityId: scopeId,
      kind: 'scope.retired',
      payload: { scopeId, retiredAt: now, reason },
    },
  ]);
  return { kind: 'retired' };
}
