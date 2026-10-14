import {
  generationTagSchema,
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

import { artifactIdsFor, referenceArtifact } from './artifacts.ts';
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
import { type PackHeaderFields, unwritableRecord } from './records.ts';
import { toEntry, toEntryState, toPublicGeneration, toScope } from './rows.ts';
import { isRefusal, readScope, type Refusal, refuse, requireActiveScope } from './state.ts';
import {
  condemnationOf,
  weighInvalidations,
  replaceEntryTags,
  type TagRef,
  tagRefsFor,
} from './tags.ts';
import { type Apply, record, type TxInput } from './tx.ts';

/**
 * What a deploy does to a scope: creates it once, seeds each entry's build generation
 * (once: a retried batch skips what it already holds), and retires it when its deployment is no
 * longer served.
 */

const OUTPUT_ID_PREFIX = 'out';

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
  sql.exec(
    `INSERT INTO scope (
       scope_id, organization_id, project_id, environment_id, deployment_id, key_schema_version,
       build_id, status, seeded_at, retired_at, revision, entry_count, body_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, 0, 0, 0)`,
    scope.scopeId,
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    scope.deploymentId,
    scope.keySchemaVersion,
    scope.buildId,
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
): Promise<Apply<SeedEntriesResult | Refusal>> {
  const plans = await Promise.all(
    batch.entries.map(async (entry) => {
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
    }),
  );
  return () => applySeedEntries(input, plans);
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
function recordFields(scopeId: string, plan: SeedPlan): PackHeaderFields {
  const { generation } = plan.entry;
  return {
    scopeId,
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
  const { outputs } = plan;
  let bodyBytes = 0;
  for (const output of outputs) {
    for (const artifact of output.artifacts) {
      bodyBytes += artifact.byteLength;
      // The build's blobs are its deploy's, under its keys: referenced, never deleted here.
      referenceArtifact(sql, { ...artifact, owned: false }, now);
    }
  }
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

function applySeedEntries(input: TxInput, plans: readonly SeedPlan[]): SeedEntriesResult | Refusal {
  const { sql, limits, revision } = input;
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  const events: EventInput[] = [];
  const planned = new Set<string>();
  const fresh = plans.filter((plan) => {
    const { entryId } = plan.identity;
    // A batch that names one entry twice seeds it once.
    if (planned.has(entryId) || findEntry(sql, entryId) !== undefined) {
      return false;
    }
    planned.add(entryId);
    return true;
  });
  // An entry no record of could ever be written is left out and said so, and the rest of the
  // batch is seeded without it. Seeded, it would be current with nothing to deliver: its record
  // retried on every settle, failing every time, and enough of them ahead in that queue to hold up
  // every other entry of the scope. Unseeded, it is served as an entry without a record is. So is
  // one whose generation may not carry its tags, which no record could carry either.
  const seedable: SeedPlan[] = [];
  const refused: SeedRefusal[] = [];
  for (const plan of fresh) {
    const reason =
      plan.tagsRefused ??
      unwritableRecord(recordFields(input.scopeId, plan), limits.maxRecordBytes);
    if (reason === undefined) {
      seedable.push(plan);
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
  const inserted = seedable.length;
  const skipped = plans.length - fresh.length;
  for (const plan of seedable) {
    seedOne(input, plan, events);
  }
  if (inserted === 0) {
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
