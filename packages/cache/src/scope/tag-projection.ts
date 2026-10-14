import { kvTagKey, MAX_TAGS_PER_CALL } from '@stayingupwind/core/cache';
import type { TagDeltaEntry } from '@stayingupwind/host/cache';

import {
  controlFenceSweepPending,
  controlFenceTag,
  expireControlFences,
} from './control-fences.ts';
import { type KvSink, writeKey } from './io.ts';
import { readMeta, readScope, writeMeta } from './state.ts';
import {
  controlTagProjections,
  controlTagsPending,
  type ControlTagProjection,
  findControlTagProjection,
  findTag,
  finishControlTagProjection,
  finishRetiredControlTagPage,
  latestTagRevision,
  retiredControlTagListingAt,
  retiredControlTagScan,
  tagsDelta,
  toDeltaEntry,
} from './tags.ts';

const PROJECTION_BATCH = 50;
const PROJECTION_CONCURRENCY = 8;
const META_TAG_REVISION = 'tags_projected_revision';
const META_RETIRED_TAG_REVISION = 'tags_deleted_revision';

interface TagProjectionDeps {
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly kv: KvSink;
  readonly transaction: <T>(body: () => T) => T;
  readonly now: () => number;
}

/**
 * Write a tag's record as it stands, or take it off for a retired scope. KV refuses a second write
 * of a key within a second (429), and a tag invalidated again while its record went out, by a
 * change that committed while a run waited, is written again within one. A write refused so is
 * tried once more a second later rather than failing the run (`writeKey`), so that the change is
 * answered with its record out; any other failure, or a second refusal, fails the run as before.
 */
async function writeTagRecord(
  deps: TagProjectionDeps,
  retired: boolean,
  tag: TagDeltaEntry,
): Promise<void> {
  const key = kvTagKey(deps.scopeId, tag.tagId);
  await writeKey(() => (retired ? deps.kv.delete(key) : deps.kv.put(key, JSON.stringify(tag))));
}

/** Identities are fixed at commit; completion is evidence for the caller's serialized settle. */
export interface ControlTagWork {
  readonly ids: readonly string[];
  projected: boolean;
}

/** A private caller cannot be acknowledged when its own exact mark was not published. */
export class ControlTagProjectionError extends Error {
  constructor(options?: ErrorOptions) {
    super('control tag projection failed', options);
    this.name = 'ControlTagProjectionError';
  }
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];

  for (let index = 0; index < items.length; index += PROJECTION_CONCURRENCY) {
    out.push(items.slice(index, index + PROJECTION_CONCURRENCY));
  }

  return out;
}

/** The change a run answers: the tags it invalidated, and the control tags it wrote first. */
interface OwnChange {
  readonly tags: readonly string[];
  readonly controlTags: ReadonlySet<string>;
}

/**
 * The records of the tags the change this run answers invalidated, as they now stand, ahead of the
 * page the cursor names. A change is answered once its run has written what it owes, and a reader
 * judges a tag by its record: behind older records still to be written — a page that failed, say —
 * the page would leave this change's own to a later run, after the answer. The page skips them
 * once written (`published`). A control tag is left to the control path, which wrote it first
 * (`projectOwnTags`).
 *
 * Each record once: a tag the change names twice, and one a page has written as it stands
 * already (at or below the cursor), are not written again. KV refuses a second write of a key
 * within a second, and the run would fail on a record that is out.
 */
async function projectChangedTags(
  deps: TagProjectionDeps,
  retired: boolean,
  change: OwnChange,
  published: Map<string, number>,
): Promise<void> {
  const cursor = Number(
    readMeta(deps.sql, retired ? META_RETIRED_TAG_REVISION : META_TAG_REVISION) ?? '0',
  );
  const tags = [...new Set(change.tags)].flatMap((tagId) => {
    const row = change.controlTags.has(tagId) ? undefined : findTag(deps.sql, tagId);
    return typeof row?.stale_at === 'number' && row.revision > cursor ? [toDeltaEntry(row)] : [];
  });

  for (const batch of chunks(tags)) {
    const outcomes = await Promise.allSettled(
      batch.map((tag) => writeTagRecord(deps, retired, tag)),
    );

    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new Error('one or more tag records were not written');
    }

    for (const tag of batch) published.set(tag.tagId, tag.revision);
  }
}

/**
 * One page of the records behind the cursor, going no further than `bound`: the scope's revision
 * as the run began. A tag invalidated since is its own change's, whose run writes it first
 * (`projectChangedTags`); written here as well, it would be written twice within a second, which
 * KV refuses.
 */
async function projectPermanentTags(
  deps: TagProjectionDeps,
  retired: boolean,
  published: ReadonlyMap<string, number>,
  bound: number,
): Promise<void> {
  const cursor = retired ? META_RETIRED_TAG_REVISION : META_TAG_REVISION;
  const since = Number(readMeta(deps.sql, cursor) ?? '0');
  const revision = Math.min(latestTagRevision(deps.sql), bound);

  if (since >= revision) return;

  const page = tagsDelta(deps.sql, { since, revision, limit: PROJECTION_BATCH });
  // The delta reads on past `revision`; what it reads there is left to its own change's run.
  const rows = page.tags.filter((tag) => tag.revision <= revision);

  for (const batch of chunks(rows)) {
    const outcomes = await Promise.allSettled(
      batch
        .filter((tag) => published.get(tag.tagId) !== tag.revision)
        .map((tag) => writeTagRecord(deps, retired, tag)),
    );

    // Drain the whole batch before the serialized settle queue can start another write.
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new Error('one or more tag records were not written');
    }
  }

  deps.transaction(() => {
    writeMeta(deps.sql, cursor, String(Math.min(page.revision, revision)));
  });
}

async function projectExactTag(
  deps: TagProjectionDeps,
  retired: boolean,
  tagId: string,
  projection: ControlTagProjection | undefined,
): Promise<number | undefined> {
  const held = findTag(deps.sql, tagId);
  const fenced = projection === undefined ? undefined : controlFenceTag(deps.sql, tagId);
  const pending =
    fenced !== undefined && projection !== undefined && fenced.revision >= projection.tag.revision
      ? fenced
      : projection?.tag;
  // Promotion and coalescing both use the newest exact mark as this write starts.
  const tag =
    held !== undefined && (pending === undefined || held.revision > pending.revision)
      ? toDeltaEntry(held)
      : pending;

  if (tag === undefined) return;

  await writeTagRecord(deps, retired, tag);

  if (projection !== undefined) {
    deps.transaction(() => {
      finishControlTagProjection(deps.sql, projection);
    });
  }

  return tag.revision;
}

async function projectOwnTags(
  deps: TagProjectionDeps,
  retired: boolean,
  ownTags: readonly string[],
): Promise<Map<string, number>> {
  const published = new Map<string, number>();
  const batches = chunks([...new Set(ownTags)]);
  for (const batch of batches) {
    const outcomes = await Promise.allSettled(
      batch.map(async (tagId) => {
        const revision = await projectExactTag(
          deps,
          retired,
          tagId,
          findControlTagProjection(deps.sql, tagId),
        );
        if (revision !== undefined) published.set(tagId, revision);
      }),
    );

    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new ControlTagProjectionError();
    }
  }

  return published;
}

/** The private outbox disappears after projection; its exact ledger fence remains. */
async function projectControlTagPage(
  deps: TagProjectionDeps,
  retired: boolean,
  projections: readonly ControlTagProjection[],
): Promise<void> {
  const batches = chunks(projections);

  for (const batch of batches) {
    const outcomes = await Promise.allSettled(
      batch.map((projection) => projectExactTag(deps, retired, projection.tag.tagId, projection)),
    );

    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new Error('one or more control tag records were not written');
    }
  }
}

async function deleteRetiredControlTags(deps: TagProjectionDeps): Promise<void> {
  if (!controlTagsPending(deps.sql, true)) return;

  const scan = retiredControlTagScan(deps.sql, deps.now());
  if (scan === undefined) return;
  const page = await deps.kv.listPage({
    prefix: kvTagKey(deps.scopeId, ''),
    cursor: scan.cursor,
    limit: PROJECTION_BATCH,
  });

  for (const batch of chunks(page.keys)) {
    const outcomes = await Promise.allSettled(batch.map((key) => deps.kv.delete(key)));

    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new Error('one or more retired control tag records were not deleted');
    }
  }

  deps.transaction(() => {
    finishRetiredControlTagPage(deps.sql, page.cursor, deps.now());
  });
}

/**
 * Tags are projected independently of entry fanout, including tags with no current entry.
 * `ownTags` are the tags the change this run answers invalidated, whose records go first
 * (`projectChangedTags`).
 */
export async function projectTags(
  deps: TagProjectionDeps,
  own?: ControlTagWork,
  ownTags: readonly string[] = [],
): Promise<void> {
  const retired = readScope(deps.sql)?.status === 'retired';
  // As the run begins: what its page goes no further than (`projectPermanentTags`).
  const bound = latestTagRevision(deps.sql);
  // Capture identity at commit and fetch current values: promotion/replacement can happen while
  // settle waits. Only failure of this bounded own phase prevents a private acknowledgment.
  const published = await projectOwnTags(deps, retired, own?.ids ?? []);
  if (own !== undefined) own.projected = true;
  const ownedIds = new Set(own?.ids);

  await projectChangedTags(deps, retired, { tags: ownTags, controlTags: ownedIds }, published);
  await projectPermanentTags(deps, retired, published, bound);
  const backlog = controlTagProjections(deps.sql, MAX_TAGS_PER_CALL)
    .filter((projection) => !ownedIds.has(projection.tag.tagId))
    .slice(0, MAX_TAGS_PER_CALL - ownedIds.size);
  await projectControlTagPage(deps, retired, backlog);
  deps.transaction(() => {
    expireControlFences(deps.sql);
  });

  if (retired) await deleteRetiredControlTags(deps);
}

/**
 * When the tag records' work comes due, where all it owes is a retired scope's second listing of its
 * control tags (`retiredControlTagListingAt`): `undefined` where anything else is owed, or that
 * listing is due already.
 */
export function tagProjectionDueAt(sql: SqlStorage, now: number): number | undefined {
  if (readScope(sql)?.status !== 'retired' || controlFenceSweepPending(sql)) return undefined;
  if (latestTagRevision(sql) > Number(readMeta(sql, META_RETIRED_TAG_REVISION) ?? '0')) {
    return undefined;
  }
  return retiredControlTagListingAt(sql, now);
}

export function tagProjectionPending(sql: SqlStorage): boolean {
  const retired = readScope(sql)?.status === 'retired';
  const cursor = retired ? META_RETIRED_TAG_REVISION : META_TAG_REVISION;

  return (
    controlTagsPending(sql, retired) ||
    controlFenceSweepPending(sql) ||
    latestTagRevision(sql) > Number(readMeta(sql, cursor) ?? '0')
  );
}
