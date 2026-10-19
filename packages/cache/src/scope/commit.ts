import {
  attemptGenerationIdFor,
  type InvalidationState,
  type OutputSnapshot,
  tagIdFor,
  tagKindOf,
} from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import {
  type CommitArtifact,
  type CommitDependency,
  type CommitOutput,
  type CommitRequest,
  type CommitResponse,
} from '@stayingupwind/host/cache';

import { addedBytesOf, artifactIdsFor, findArtifactBySha, referenceArtifact } from './artifacts.ts';
import { endAttempt, entryStateEvent, findAttempt, isLive } from './attempts.ts';
import { controlFenceFloorInvalidations } from './control-fences.ts';
import { publishEntry, requireEntry, setRegeneration } from './entries.ts';
import { findGeneration, insertGeneration, supersedeGeneration } from './generations.ts';
import type { EventInput } from './history.ts';
import type { BlobStore } from './io.ts';
import { type IsrWrite, isrWriteOf, sameOutputs } from './metering.ts';
import { type PackHeaderFields, unwritableRecord } from './records.ts';
import {
  type AttemptArtifactRow,
  type AttemptRow,
  type EntryRow,
  generationOutputs,
  type InvalidationRow,
  toAttempt,
  toEntryState,
  toPublicGeneration,
} from './rows.ts';
import { isRefusal, type Refusal, refuse, requireActiveScope } from './state.ts';
import {
  condemnationOf,
  replaceEntryTags,
  type TagRef,
  tagRefsFor,
  viewHeld,
  weighInvalidations,
} from './tags.ts';
import { type Apply, inChunks, record, type TxInput } from './tx.ts';

/**
 * Publishing a regeneration. The commit is refused if the lease was lost (a newer fencing token,
 * or the lease's time is up); it publishes stale — condemned on arrival — if a `stale-while-
 * revalidate` invalidation touched its tags after the render read its inputs, and it publishes
 * nothing if an immediate one did. Every output of the render becomes current together.
 */

const OUTPUT_ID_PREFIX = 'out';
/**
 * How many of a commit's uploads its plan asks storage about at once. A commit may name thousands
 * of artifacts, and a Worker has six calls waiting for an answer at the most: one past them waits
 * in the runtime's own queue, held all the same.
 */
const UPLOAD_CHECKS_AT_ONCE = 6;
/**
 * How many ids of the tags a commit depends on its plan derives at once. Nothing bounds how many a
 * commit names but the body it is read from, a mebibyte (`COMMIT_BODY_BYTES`): some ten thousand,
 * and each id a digest.
 */
const DEPENDENCY_TAG_IDS_AT_ONCE = 128;

interface CommitPlan {
  readonly attemptId: string;
  readonly request: CommitRequest;
  readonly generationId: string;
  readonly tagRefs: readonly TagRef[];
  readonly dependencyTagIds: ReadonlyMap<string, string>;
  readonly artifactIds: ReadonlyMap<string, string>;
  /** The storage keys of uploads the commit would publish from that hold nothing any more. */
  readonly missingUploads: ReadonlySet<string>;
}

/**
 * A commit's answer as the authority gives it to the gateway: the one its caller is told, and —
 * from the call that published, when what it published is not what was current — the write it
 * made, for the gateway to meter and keep to itself (`metering.ts`).
 */
export type CommitOutcome = CommitResponse & {
  readonly metered?: IsrWrite | undefined;
  /** The delivery record the commit's settle wrote for the entry, where it is handed back. */
  readonly recordBytes?: Uint8Array | undefined;
};

export async function planCommit(
  input: TxInput,
  attemptId: string,
  request: CommitRequest,
  blobs: BlobStore,
): Promise<Apply<CommitOutcome | Refusal>> {
  const { generation } = request;
  const [generationId, tagRefs, artifactIds, dependencyTagIds, missing] = await Promise.all([
    attemptGenerationIdFor(input.scopeId, attemptId),
    tagRefsFor(input.scopeId, generation.tags),
    artifactIdsFor(
      input.scopeId,
      generation.outputs.flatMap((output) => output.artifacts.map((artifact) => artifact.sha256)),
    ),
    dependencyTagIdsFor(input.scopeId, generation.dependencies),
    missingUploads(input.sql, attemptId, generation.outputs, blobs),
  ]);
  return () => {
    return applyCommit(input, {
      attemptId,
      request,
      generationId,
      tagRefs,
      artifactIds,
      dependencyTagIds,
      missingUploads: missing,
    });
  };
}

/** Ids for the tags a commit depends on, each tag's once, derived ahead of its transaction. */
async function dependencyTagIdsFor(
  scopeId: string,
  dependencies: readonly CommitDependency[],
): Promise<Map<string, string>> {
  const values = new Set<string>();
  for (const dependency of dependencies) {
    if (dependency.target.kind === 'tag') {
      values.add(dependency.target.value);
    }
  }
  const ids = new Map<string, string>();
  await inChunks([...values], DEPENDENCY_TAG_IDS_AT_ONCE, async (value) => {
    ids.set(value, await tagIdFor(scopeId, tagKindOf(value), value));
  });
  return ids;
}

function findUpload(
  sql: SqlStorage,
  attemptId: string,
  artifact: CommitArtifact,
): AttemptArtifactRow | undefined {
  return sql
    .exec<AttemptArtifactRow>(
      `SELECT * FROM attempt_artifacts WHERE attempt_id = ? AND sha256 = ? AND role = ?`,
      attemptId,
      artifact.sha256,
      artifact.role,
    )
    .toArray()[0];
}

/**
 * The uploads a commit would publish from whose bytes are not in storage.
 *
 * An upload is recorded before its bytes are stored, and the gateway stores nothing when the key
 * already holds the same bytes — bytes a former generation may be the last to name, which
 * retention prunes and deletes if its hour comes round before the commit does: what it keeps is
 * what a generation refers to, not what an attempt has uploaded and not yet published. A store
 * that failed after its upload was recorded leaves the same gap. Asked here, under the lock
 * retention deletes under, the answer holds for the transaction that follows. Only uploads are
 * asked about: the bytes the scope already holds are kept by the generations that refer to them.
 */
async function missingUploads(
  sql: SqlStorage,
  attemptId: string,
  outputs: readonly CommitOutput[],
  blobs: BlobStore,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const output of outputs) {
    for (const artifact of output.artifacts) {
      const upload = findUpload(sql, attemptId, artifact);
      if (upload !== undefined && findArtifactBySha(sql, artifact.sha256) === undefined) {
        keys.add(upload.storage_ref);
      }
    }
  }
  const missing = new Set<string>();
  await inChunks([...keys], UPLOAD_CHECKS_AT_ONCE, async (key) => {
    if (!(await blobs.exists(key))) {
      missing.add(key);
    }
  });
  return missing;
}

/**
 * What the commit claims of an artifact that the bytes behind it do not say.
 *
 * The request describes the artifacts, but the gateway is what measured them on the way in. A
 * length the commit is free to invent is a length the scope's quota is charged and a later read
 * trusts, so a commit that disagrees with what was stored is refused rather than believed.
 */
function mismatchOf(upload: AttemptArtifactRow, artifact: CommitArtifact): string | undefined {
  const named = `${artifact.role} ${artifact.sha256}`;
  if (upload.byte_length !== artifact.byteLength) {
    return `${named} holds ${upload.byte_length} bytes, not ${artifact.byteLength}`;
  }
  if (upload.content_type !== artifact.contentType) {
    return `${named} was uploaded as ${upload.content_type}, not ${artifact.contentType}`;
  }
  if (upload.encoding !== artifact.encoding) {
    return `${named} was uploaded ${upload.encoding}, not ${artifact.encoding}`;
  }
  return undefined;
}

/**
 * Where one named artifact's bytes are.
 *
 * Where the scope already holds them wins over the copy this attempt uploaded beside them: a row
 * referred to at one key and read at another is a blob nothing can ever free.
 */
function locateArtifact(
  sql: SqlStorage,
  plan: CommitPlan,
  artifact: CommitArtifact,
): Refusal | { readonly storageRef: string } {
  const named = `${artifact.role} ${artifact.sha256}`;
  const upload = findUpload(sql, plan.attemptId, artifact);
  const stored = findArtifactBySha(sql, artifact.sha256);
  const mismatch = upload === undefined ? undefined : mismatchOf(upload, artifact);
  if (mismatch !== undefined) {
    return refuse('artifact_mismatch', mismatch);
  }
  if (stored !== undefined) {
    return stored.byte_length === artifact.byteLength
      ? { storageRef: stored.storage_ref }
      : refuse(
          'artifact_mismatch',
          `${named} holds ${stored.byte_length} bytes, not ${artifact.byteLength}`,
        );
  }
  if (upload === undefined) {
    return refuse('artifact_missing', `no upload for ${named}`);
  }
  // Published, it would be a generation no record of could ever be written. Refused, it is an
  // attempt the runtime fails and renders again, and that upload stores the bytes anew.
  return plan.missingUploads.has(upload.storage_ref)
    ? refuse('artifact_missing', `the bytes uploaded for ${named} are not in storage`)
    : { storageRef: upload.storage_ref };
}

/** Where each named artifact's bytes are: uploaded for this attempt, or already the scope's. */
function locateArtifacts(sql: SqlStorage, plan: CommitPlan): Map<string, string> | Refusal {
  const refs = new Map<string, string>();
  for (const output of plan.request.generation.outputs) {
    for (const artifact of output.artifacts) {
      const located = locateArtifact(sql, plan, artifact);
      if (isRefusal(located)) {
        return located;
      }
      refs.set(artifact.sha256, located.storageRef);
    }
  }
  return refs;
}

/** What the delivery record of the generation this commit would publish is made of. */
function recordFields(
  input: TxInput,
  plan: CommitPlan,
  entry: EntryRow,
  outputs: readonly OutputSnapshot[],
): PackHeaderFields {
  const { generation } = plan.request;
  return {
    scopeId: input.scopeId,
    entry: {
      entryId: entry.entry_id,
      kind: entry.kind,
      route: entry.route,
      pathname: entry.pathname,
    },
    generation: {
      generationId: plan.generationId,
      seq: entry.seq_max + 1,
      source: 'runtime',
      cacheTimestamp: generation.cacheTimestamp,
      producedAt: generation.producedAt,
      policy: generation.policy,
      status: generation.status,
      headers: generation.headers,
      tags: generation.tags,
    },
    outputs,
  };
}

function snapshots(plan: CommitPlan, storageRefs: ReadonlyMap<string, string>): OutputSnapshot[] {
  return plan.request.generation.outputs.map((output) => {
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
          artifactId: plan.artifactIds.get(artifact.sha256) ?? '',
          sha256: artifact.sha256,
          byteLength: artifact.byteLength,
          contentType: artifact.contentType,
          encoding: artifact.encoding,
          role: artifact.role,
          storageRef: storageRefs.get(artifact.sha256) ?? '',
        };
      }),
    };
  });
}

/** The render read its inputs before an immediate invalidation: nothing of it may be published. */
function refuseStale(
  input: TxInput,
  attempt: AttemptRow,
  entry: EntryRow,
  invalidations: readonly InvalidationRow[],
): CommitResponse {
  const { sql, scopeId, now, revision } = input;
  let invalidationRevision = -Infinity;
  for (const row of invalidations) {
    invalidationRevision = Math.max(invalidationRevision, row.revision);
  }
  sql.exec(
    `UPDATE attempts SET status = 'failed', finished_at = ?, error = ? WHERE attempt_id = ?`,
    now,
    JSON.stringify({
      code: 'stale_dependencies',
      message: `an immediate invalidation at revision ${invalidationRevision} touched what the render read`,
    }),
    attempt.attempt_id,
  );
  setRegeneration(sql, {
    entryId: entry.entry_id,
    regeneration: 'queued',
    attemptId: null,
    failedCount: entry.failed_count,
    nextRetryAt: null,
    revision,
    now,
  });
  const ended = findAttempt(sql, attempt.attempt_id) ?? attempt;
  record(input, [
    {
      entityType: 'attempt',
      entityId: attempt.attempt_id,
      kind: 'attempt.failed',
      payload: { attempt: toAttempt(scopeId, ended) },
    },
    entryStateEvent(sql, entry.entry_id),
  ]);
  return { kind: 'stale-dependencies', invalidationRevision };
}

/** A commit of an attempt that already ended: its own outcome, said again. */
function alreadyEnded(sql: SqlStorage, attempt: AttemptRow): CommitResponse {
  if (attempt.status === 'committed' && attempt.generation_id !== null) {
    const generation = findGeneration(sql, attempt.generation_id);
    if (generation !== undefined) {
      return {
        kind: 'published',
        generationId: generation.generation_id,
        seq: generation.seq,
        revision: generation.published_revision ?? 0,
        condemned:
          generation.condemned === null
            ? null
            : (JSON.parse(generation.condemned) as InvalidationState),
      };
    }
  }
  if (attempt.status === 'expired') {
    return { kind: 'lease-expired' };
  }
  return { kind: 'superseded', reason: `the attempt is ${attempt.status}` };
}

interface Publication {
  readonly attempt: AttemptRow;
  readonly entry: EntryRow;
  readonly outputs: readonly OutputSnapshot[];
  readonly condemned: InvalidationState | null;
  /**
   * The revision the generation's inputs stand as of: the lease's, or the latest invalidation its
   * view held past it that condemns nothing (`Weighed.heldThrough`), whichever is later — every
   * invalidation of its tags up to there was weighed, and condemns it or was read against. A change
   * that asks for a render made after it (`resource-changes.ts`) takes such a generation for one,
   * and the same change delivered again does not condemn it.
   */
  readonly dependencyRevision: number;
}

function publish(input: TxInput, plan: CommitPlan, state: Publication): CommitOutcome {
  const { sql, scopeId, now, revision } = input;
  const { attempt, entry, outputs } = state;
  const { generation } = plan.request;
  const current =
    entry.current_generation_id === null
      ? undefined
      : findGeneration(sql, entry.current_generation_id);
  // What was current rendered again, byte for byte: published — its freshness is new — but no
  // new content was written, and none is metered.
  const changed = current === undefined || !sameOutputs(outputs, generationOutputs(current));
  let addedBytes = 0;
  let bodyBytes = 0;
  for (const output of outputs) {
    for (const artifact of output.artifacts) {
      bodyBytes += artifact.byteLength;
      addedBytes += referenceArtifact(sql, { ...artifact, owned: true }, now).addedBytes;
    }
  }
  const seq = entry.seq_max + 1;
  insertGeneration(sql, {
    generationId: plan.generationId,
    entryId: entry.entry_id,
    seq,
    source: 'runtime',
    attemptId: attempt.attempt_id,
    cacheTimestamp: generation.cacheTimestamp,
    producedAt: generation.producedAt,
    policy: generation.policy,
    status: generation.status,
    headers: generation.headers,
    tags: generation.tags,
    dependencyCoverage: generation.dependencyCoverage,
    dependencyRevision: state.dependencyRevision,
    publishedRevision: revision,
    condemned: state.condemned,
    bodyBytes,
    producer: generation.producer ?? { kind: 'attempt', reason: attempt.reason },
    outputs,
    committedAt: now,
  });
  if (entry.current_generation_id !== null) {
    supersedeGeneration(sql, entry.current_generation_id, revision);
  }
  replaceEntryTags(sql, entry.entry_id, plan.tagRefs);
  for (const dependency of generation.dependencies) {
    const targetId =
      dependency.target.kind === 'tag'
        ? plan.dependencyTagIds.get(dependency.target.value)
        : dependency.target.entryId;
    sql.exec(
      `INSERT OR REPLACE INTO dependencies (owner_generation_id, target_kind, target_id, observed_revision, evidence, usage)
       VALUES (?, ?, ?, ?, ?, ?)`,
      plan.generationId,
      dependency.target.kind,
      targetId ?? '',
      dependency.observedRevision,
      dependency.evidence,
      dependency.usage,
    );
  }
  publishEntry(sql, {
    entryId: entry.entry_id,
    generationId: plan.generationId,
    seq,
    revision,
    now,
  });
  sql.exec(
    `UPDATE attempts SET status = 'committed', finished_at = ?, generation_id = ? WHERE attempt_id = ?`,
    now,
    plan.generationId,
    attempt.attempt_id,
  );
  sql.exec(`UPDATE scope SET body_bytes = body_bytes + ?`, addedBytes);
  const published = findGeneration(sql, plan.generationId);
  const events: EventInput[] = [];
  if (published !== undefined) {
    events.push({
      entityType: 'generation',
      entityId: plan.generationId,
      kind: 'generation.committed',
      payload: {
        generation: toPublicGeneration(scopeId, published),
        entryState: toEntryState(requireEntry(sql, entry.entry_id)),
        supersededGenerationId: entry.current_generation_id,
        // The attempt as this transaction left it. Nothing else will say: an attempt that
        // published is not one that failed, expired or was superseded, and those are the only
        // ends an event of its own is made for.
        attempt: toAttempt(scopeId, findAttempt(sql, attempt.attempt_id) ?? attempt),
      },
    });
  }
  record(input, events);
  return {
    kind: 'published',
    generationId: plan.generationId,
    seq,
    revision,
    condemned: state.condemned,
    ...(changed && { metered: isrWriteOf(input, bodyBytes) }),
  };
}

function applyCommit(input: TxInput, plan: CommitPlan): CommitOutcome | Refusal {
  const { sql, now } = input;
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  const attempt = findAttempt(sql, plan.attemptId);
  if (attempt === undefined) {
    return refuse('not_found', 'no such attempt');
  }
  if (!isLive(attempt)) {
    return alreadyEnded(sql, attempt);
  }
  const events: EventInput[] = [];
  if (attempt.lease_expires_at <= now) {
    endAttempt(input, attempt, { status: 'expired', regeneration: 'idle' }, events);
    record(input, events);
    return { kind: 'lease-expired' };
  }
  const entry = requireEntry(sql, attempt.entry_id);
  if (
    plan.request.fencingToken !== attempt.fencing_token ||
    attempt.fencing_token !== entry.fencing_max
  ) {
    endAttempt(input, attempt, { status: 'superseded', regeneration: 'idle' }, events);
    record(input, events);
    return { kind: 'superseded', reason: 'a newer lease of the entry was taken' };
  }
  const storageRefs = locateArtifacts(sql, plan);
  if (isRefusal(storageRefs)) {
    return storageRefs;
  }
  const outputs = snapshots(plan, storageRefs);
  const unwritable = unwritableRecord(
    recordFields(input, plan, entry, outputs),
    input.limits.maxRecordBytes,
  );
  if (unwritable !== undefined) {
    return refuse('too_large', unwritable);
  }
  const uniqueArtifacts = new Map(
    outputs.flatMap((output) => output.artifacts).map((artifact) => [artifact.sha256, artifact]),
  );
  let addedBytes = 0;
  for (const artifact of uniqueArtifacts.values()) {
    addedBytes += addedBytesOf(sql, { ...artifact, owned: true });
  }
  if (scope.body_bytes + addedBytes > input.limits.bodyBytesPerScope) {
    return refuse('quota_exceeded', 'the scope holds as many bytes as it may');
  }
  const tagIds = plan.tagRefs.map((ref) => ref.tagId);
  const held = viewHeld(plan.request, plan.tagRefs);
  const behind = Math.min(attempt.dependency_revision, plan.request.observedTagRevision);
  const floor = controlFenceFloorInvalidations(sql, { tagIds, afterRevision: behind });
  if (floor.length > 0) return refuseStale(input, attempt, entry, floor);
  // A tag's invalidation at or before what the renderer's view held of the tag (`viewHeld`) is one
  // the render read against, whatever revision the lease was taken at: a runtime pulls the delta
  // after it asks for the lease and before it renders, and one recorded between the two — the
  // `revalidatePath` that sent the request here, which Next.js records behind its response — was in
  // that pull. An immediate one neither refuses nor condemns what the render made (`held`): its
  // reads were made afresh against it, and so against nothing recorded of its tag before it. One
  // with a window the view held last of its tag still condemns it, as any after the lease does: its
  // reads may have been answered stale under it. What the view held of each tag is the runtime's to
  // say, and a commit that says nothing of it is judged as one whose view held none: the revision
  // the view was brought up to does not say it of a tag the view let go of, a read under which was
  // judged by a copy of the tags that may be behind.
  //
  // The lease's revision says when the render was allowed to start; the request's says what the
  // renderer's view of the tags was synced to, which a hold window leaves behind by up to its
  // length. An invalidation between the two is one a data-cache read may have been judged against
  // without knowing of it, as one after the lease is, and is weighed as that one is. One with a
  // window has the generation published condemned rather than refused: the render may well be
  // sound, and only the next one of it can say. An immediate one refuses it: published, it would be
  // expired on arrival, its hard deadline the invalidation's, in the place of the generation before
  // it, which the invalidation may not have reached.
  const { condemning: invalidations, heldThrough } = weighInvalidations(sql, {
    entryId: entry.entry_id,
    tagIds,
    held,
    afterRevision: behind,
  });
  if (invalidations.some((row) => row.meaning === 'immediate')) {
    return refuseStale(input, attempt, entry, invalidations);
  }
  return publish(input, plan, {
    attempt,
    entry,
    outputs,
    condemned: condemnationOf(invalidations),
    dependencyRevision: Math.max(attempt.dependency_revision, heldThrough),
  });
}
