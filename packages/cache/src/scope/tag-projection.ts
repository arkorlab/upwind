import { kvTagKey, MAX_TAGS_PER_CALL } from '@stayingupwind/core/cache';

import {
  controlFenceSweepPending,
  controlFenceTag,
  expireControlFences,
} from './control-fences.ts';
import type { KvSink } from './io.ts';
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
  retiredControlTagScan,
  tagsDelta,
  tagsOfRevision,
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

/** The change a run answers: the revision it committed at, and the control tags it wrote first. */
interface OwnChange {
  readonly revision: number;
  readonly controlTags: ReadonlySet<string>;
}

/**
 * The records of the tags the change this run answers invalidated, ahead of the page the cursor
 * names. A change is answered once its run has written what it owes, and a reader judges a tag by
 * its record: behind older records still to be written — a page that failed, say — the page would
 * leave this change's own to a later run, after the answer. The page skips them once written
 * (`published`). A control tag is left to the control path, which wrote it first
 * (`projectOwnTags`).
 */
async function projectRevisionTags(
  deps: TagProjectionDeps,
  retired: boolean,
  change: OwnChange,
  published: Map<string, number>,
): Promise<void> {
  const tags = tagsOfRevision(deps.sql, change.revision)
    .filter((row) => !change.controlTags.has(row.tag_id))
    .map((row) => toDeltaEntry(row));

  for (const batch of chunks(tags)) {
    const outcomes = await Promise.allSettled(
      batch.map((tag) => {
        return retired
          ? deps.kv.delete(kvTagKey(deps.scopeId, tag.tagId))
          : deps.kv.put(kvTagKey(deps.scopeId, tag.tagId), JSON.stringify(tag));
      }),
    );

    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new Error('one or more tag records were not written');
    }

    for (const tag of batch) published.set(tag.tagId, tag.revision);
  }
}

async function projectPermanentTags(
  deps: TagProjectionDeps,
  retired: boolean,
  published: ReadonlyMap<string, number>,
): Promise<void> {
  const cursor = retired ? META_RETIRED_TAG_REVISION : META_TAG_REVISION;
  const since = Number(readMeta(deps.sql, cursor) ?? '0');
  const revision = latestTagRevision(deps.sql);

  if (since >= revision) return;

  const page = tagsDelta(deps.sql, { since, revision, limit: PROJECTION_BATCH });

  for (const batch of chunks(page.tags)) {
    const outcomes = await Promise.allSettled(
      batch
        .filter((tag) => published.get(tag.tagId) !== tag.revision)
        .map((tag) => {
          return retired
            ? deps.kv.delete(kvTagKey(deps.scopeId, tag.tagId))
            : deps.kv.put(kvTagKey(deps.scopeId, tag.tagId), JSON.stringify(tag));
        }),
    );

    // Drain the whole batch before the serialized settle queue can start another write.
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new Error('one or more tag records were not written');
    }
  }

  deps.transaction(() => {
    writeMeta(deps.sql, cursor, String(page.revision));
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

  if (retired) {
    await deps.kv.delete(kvTagKey(deps.scopeId, tagId));
  } else {
    await deps.kv.put(kvTagKey(deps.scopeId, tagId), JSON.stringify(tag));
  }

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
 * `ownRevision` is the revision the change this run answers committed at, whose tags' records go
 * first (`projectRevisionTags`).
 */
export async function projectTags(
  deps: TagProjectionDeps,
  own?: ControlTagWork,
  ownRevision?: number,
): Promise<void> {
  const retired = readScope(deps.sql)?.status === 'retired';
  // Capture identity at commit and fetch current values: promotion/replacement can happen while
  // settle waits. Only failure of this bounded own phase prevents a private acknowledgment.
  const published = await projectOwnTags(deps, retired, own?.ids ?? []);
  if (own !== undefined) own.projected = true;
  const ownedIds = new Set(own?.ids);

  if (ownRevision !== undefined) {
    await projectRevisionTags(
      deps,
      retired,
      { revision: ownRevision, controlTags: ownedIds },
      published,
    );
  }
  await projectPermanentTags(deps, retired, published);
  const backlog = controlTagProjections(deps.sql, MAX_TAGS_PER_CALL)
    .filter((projection) => !ownedIds.has(projection.tag.tagId))
    .slice(0, MAX_TAGS_PER_CALL - ownedIds.size);
  await projectControlTagPage(deps, retired, backlog);
  deps.transaction(() => {
    expireControlFences(deps.sql);
  });

  if (retired) await deleteRetiredControlTags(deps);
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
