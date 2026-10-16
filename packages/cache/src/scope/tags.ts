import {
  type GenerationTag,
  type InvalidationState,
  tagIdFor,
  type TagKind,
  tagKindOf,
  tagKindSchema,
} from '@stayingupwind/core/cache';
import {
  type CommitRequest,
  invalidationMeaningSchema,
  type TagDeltaEntry,
  tagDeltaEntrySchema,
  type TagRevision,
  type TagsDeltaResponse,
} from '@stayingupwind/host/cache';

import { controlFenceInvalidations } from './control-fences.ts';
import type { InvalidationRow, TagRow } from './rows.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';
import { readTagHistory, recordTagHistory } from './tag-history.ts';

/**
 * Tags, exact and case-sensitive, and what the last invalidation of each did. `entry_tags` names
 * the tags of each entry's *current* generation — the set an invalidation fans out over — and is
 * replaced whole whenever the current generation changes.
 *
 * A tag has a row from its first invalidation on, and keeps it for good: the delta and regional KV
 * record pair it with bounded earlier deadlines, so a later SWR cannot reopen an expired value.
 * A tag no invalidation has named needs none —
 * an invalidation fans out over `entry_tags`, and condemns a commit by the invalidations recorded —
 * so a generation's tags add no row. Only `markTagInvalidated` adds one, under the scope's quota.
 * Private control fanout keeps absent tags out of this permanent set and the historical ledger:
 * bounded transient fences protect admission until collection, then a constant floor protects
 * older writers. Its separately capped outbox retains KV projection obligations until success.
 */

/**
 * How many rows `tags` has, kept beside them: counting the rows would read every one of them for
 * each invalidation that names a new tag, and at the quota those are exactly what it refuses.
 */
const META_TAG_COUNT = 'tag_count';
const META_CONTROL_TAG_PREFIX = 'control_tag_projection:';
const META_CONTROL_TAG_END = 'control_tag_projection;';
const META_CONTROL_TAGS_SEEN = 'control_tags_seen';
const META_RETIRED_CONTROL_TAG_CURSOR = 'retired_control_tag_cursor';
const META_RETIRED_CONTROL_TAGS_DELETED = 'retired_control_tags_deleted';
const META_CONTROL_TAG_PENDING_COUNT = 'control_tag_pending_count';
const META_RETIRED_CONTROL_TAG_REPEAT_AT = 'retired_control_tag_repeat_at';
export const CONTROL_TAG_PENDING_LIMIT = 1024;
const KV_LIST_GRACE_MS = 60_000;

export interface TagRef {
  readonly tagId: string;
  readonly kind: TagKind;
  readonly value: string;
}

/** Ids for a generation's tags, derived ahead of the transaction that stores them. */
export async function tagRefsFor(
  scopeId: string,
  tags: readonly GenerationTag[],
): Promise<TagRef[]> {
  return Promise.all(
    tags.map(async (tag) => {
      return {
        tagId: await tagIdFor(scopeId, tag.kind, tag.value),
        kind: tag.kind,
        value: tag.value,
      };
    }),
  );
}

/** The kind an invalidation names, or the one Next.js's own prefix implies. */
export function tagKindFor(value: string, kind: TagKind | undefined): TagKind {
  return kind ?? tagKindOf(value);
}

export function replaceEntryTags(sql: SqlStorage, entryId: string, refs: readonly TagRef[]): void {
  sql.exec(`DELETE FROM entry_tags WHERE entry_id = ?`, entryId);
  for (const ref of refs) {
    sql.exec(
      `INSERT OR IGNORE INTO entry_tags (tag_id, entry_id) VALUES (?, ?)`,
      ref.tagId,
      entryId,
    );
  }
}

export function findTag(sql: SqlStorage, tagId: string): TagRow | undefined {
  return sql.exec<TagRow>(`SELECT * FROM tags WHERE tag_id = ?`, tagId).toArray()[0];
}

export function hasCurrentTag(sql: SqlStorage, tagId: string): boolean {
  return sql.exec(`SELECT 1 FROM entry_tags WHERE tag_id = ? LIMIT 1`, tagId).toArray().length > 0;
}

/** How many tags have a row. A scope that holds no count yet counts its rows, once. */
function heldTags(sql: SqlStorage): number {
  const kept = readMeta(sql, META_TAG_COUNT);
  if (kept !== undefined) {
    return Number(kept);
  }
  const counted = sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM tags`).one().count;
  writeMeta(sql, META_TAG_COUNT, String(counted));
  return counted;
}

/**
 * Whether the scope may keep a row for each of these tags as well as the rows it has: a tag with
 * one already costs nothing. Asked before anything is written, since a refusal leaves the
 * transaction committed.
 */
export function tagsFit(sql: SqlStorage, refs: readonly TagRef[], limit: number): boolean {
  const added = new Set(
    refs.filter((ref) => findTag(sql, ref.tagId) === undefined).map((ref) => ref.tagId),
  );
  return added.size === 0 || heldTags(sql) + added.size <= limit;
}

export interface InvalidationWrite {
  readonly ref: TagRef;
  readonly revision: number;
  readonly staleAt: number;
  readonly hardExpireAt: number | null;
  readonly meaning: 'immediate' | 'swr';
}

/** Only unprojected private marks occupy this outbox; another invalidation replaces the same key. */
export function queueControlTagProjection(sql: SqlStorage, write: InvalidationWrite): void {
  const tag: TagDeltaEntry = {
    ...write.ref,
    revision: write.revision,
    staleAt: write.staleAt,
    hardExpireAt: write.hardExpireAt,
    meaning: write.meaning,
  };
  const key = META_CONTROL_TAG_PREFIX + tag.tagId;
  const added = readMeta(sql, key) === undefined;
  const count = controlProjectionCount(sql);
  writeMeta(sql, key, JSON.stringify(tag));
  writeMeta(sql, META_CONTROL_TAG_PENDING_COUNT, String(count + Number(added)));
  writeMeta(sql, META_CONTROL_TAGS_SEEN, '1');
}

function controlProjectionCount(sql: SqlStorage): number {
  const count = readMeta(sql, META_CONTROL_TAG_PENDING_COUNT);
  if (count !== undefined) return Number(count);
  return sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM meta WHERE key >= ? AND key < ?`,
      META_CONTROL_TAG_PREFIX,
      META_CONTROL_TAG_END,
    )
    .one().count;
}

/** Preflight only: rejected fanout leaves no row or counter initialized. */
export function controlTagProjectionsFit(sql: SqlStorage, refs: readonly TagRef[]): boolean {
  const added = new Set(
    refs
      .filter((ref) => readMeta(sql, META_CONTROL_TAG_PREFIX + ref.tagId) === undefined)
      .map((ref) => ref.tagId),
  );
  return added.size === 0 || controlProjectionCount(sql) + added.size <= CONTROL_TAG_PENDING_LIMIT;
}

export interface ControlTagProjection {
  readonly key: string;
  readonly value: string;
  readonly tag: TagDeltaEntry;
}

/** The meta primary key bounds both this page and the pending-work check, without a ledger scan. */
export function controlTagProjections(sql: SqlStorage, limit: number): ControlTagProjection[] {
  const rows = sql
    .exec<{ key: string; value: string }>(
      `SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key LIMIT ?`,
      META_CONTROL_TAG_PREFIX,
      META_CONTROL_TAG_END,
      limit,
    )
    .toArray();
  return rows.map((row) => ({ ...row, tag: tagDeltaEntrySchema.parse(JSON.parse(row.value)) }));
}

/** Own IDs captured at commit use primary-key reads, regardless of the size of older backlog. */
export function findControlTagProjection(
  sql: SqlStorage,
  tagId: string,
): ControlTagProjection | undefined {
  const key = META_CONTROL_TAG_PREFIX + tagId;
  const value = readMeta(sql, key);

  return value === undefined
    ? undefined
    : { key, value, tag: tagDeltaEntrySchema.parse(JSON.parse(value)) };
}

export function finishControlTagProjection(
  sql: SqlStorage,
  projection: ControlTagProjection,
): void {
  // A mutation can replace this mark while its KV put is awaiting I/O. Clear only what was sent.
  const count = controlProjectionCount(sql);
  const deleted = sql.exec(
    `DELETE FROM meta WHERE key = ? AND value = ?`,
    projection.key,
    projection.value,
  ).rowsWritten;
  // What went is one mark, its key the table's: `rowsWritten` counts what SQLite wrote, an index's
  // entries beside a row's (one row inserted into `meta` reports two), and says here only whether
  // the mark went.
  if (deleted > 0) writeMeta(sql, META_CONTROL_TAG_PENDING_COUNT, String(count - 1));
}

/** Whether a private mark waits in the outbox to be projected. */
function controlMarksQueued(sql: SqlStorage): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM meta WHERE key >= ? AND key < ? LIMIT 1`,
        META_CONTROL_TAG_PREFIX,
        META_CONTROL_TAG_END,
      )
      .toArray().length > 0
  );
}

export function controlTagsPending(sql: SqlStorage, retired: boolean): boolean {
  return (
    controlMarksQueued(sql) ||
    (retired &&
      readMeta(sql, META_CONTROL_TAGS_SEEN) !== undefined &&
      readMeta(sql, META_RETIRED_CONTROL_TAGS_DELETED) === undefined)
  );
}

/**
 * When a retired scope's second listing of its control tags is due, where it is all those tags owe
 * and waits out KV's consistency window after the first (`finishRetiredControlTagPage`); `undefined`
 * where a mark waits to be projected, or the listing is due already.
 */
export function retiredControlTagListingAt(sql: SqlStorage, now: number): number | undefined {
  const repeatAt = readMeta(sql, META_RETIRED_CONTROL_TAG_REPEAT_AT);
  if (repeatAt === undefined || now >= Number(repeatAt) || controlMarksQueued(sql)) {
    return undefined;
  }
  return readMeta(sql, META_RETIRED_CONTROL_TAGS_DELETED) === undefined
    ? Number(repeatAt)
    : undefined;
}

/** Retirement lists KV after the transient admission history has already been reclaimed. */
export function retiredControlTagScan(
  sql: SqlStorage,
  now: number,
): { cursor?: string } | undefined {
  if (readMeta(sql, META_CONTROL_TAGS_SEEN) === undefined) return undefined;
  if (readMeta(sql, META_RETIRED_CONTROL_TAGS_DELETED) !== undefined) return undefined;
  const repeatAt = readMeta(sql, META_RETIRED_CONTROL_TAG_REPEAT_AT);
  if (repeatAt !== undefined && now < Number(repeatAt)) return undefined;
  const cursor = readMeta(sql, META_RETIRED_CONTROL_TAG_CURSOR);
  return cursor === undefined ? {} : { cursor };
}

export function finishRetiredControlTagPage(
  sql: SqlStorage,
  cursor: string | undefined,
  now: number,
): void {
  if (cursor !== undefined) {
    writeMeta(sql, META_RETIRED_CONTROL_TAG_CURSOR, cursor);
  } else if (readMeta(sql, META_RETIRED_CONTROL_TAG_REPEAT_AT) === undefined) {
    // The prior serialized run may have finished a late KV put immediately before this pass.
    // Repeat a full listing once those writes are at least one consistency window old.
    deleteMeta(sql, META_RETIRED_CONTROL_TAG_CURSOR);
    writeMeta(sql, META_RETIRED_CONTROL_TAG_REPEAT_AT, String(now + KV_LIST_GRACE_MS));
  } else {
    writeMeta(sql, META_RETIRED_CONTROL_TAGS_DELETED, '1');
  }
}

/** Record the permanent tag mark: what the delta and its regional KV projection read. */
export function markTagInvalidated(sql: SqlStorage, write: InvalidationWrite): void {
  const previous = findTag(sql, write.ref.tagId);
  if (previous === undefined) {
    // Counted before the row goes in: a scope that never kept the count would count it twice.
    writeMeta(sql, META_TAG_COUNT, String(heldTags(sql) + 1));
  }
  recordTagHistory(
    sql,
    write.ref.tagId,
    {
      revision: write.revision,
      staleAt: write.staleAt,
      hardExpireAt: write.hardExpireAt,
    },
    previous,
  );
  sql.exec(
    `INSERT INTO tags (tag_id, kind, value, revision, stale_at, hard_expire_at, meaning)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tag_id) DO UPDATE SET
       revision = excluded.revision,
       stale_at = excluded.stale_at,
       hard_expire_at = excluded.hard_expire_at,
       meaning = excluded.meaning`,
    write.ref.tagId,
    write.ref.kind,
    write.ref.value,
    write.revision,
    write.staleAt,
    write.hardExpireAt,
    write.meaning,
  );
}

export function toDeltaEntry(row: TagRow, sql?: SqlStorage): TagDeltaEntry {
  const history = sql === undefined ? undefined : readTagHistory(sql, row.tag_id);
  return {
    tagId: row.tag_id,
    kind: tagKindSchema.parse(row.kind),
    value: row.value,
    revision: row.revision,
    staleAt: row.stale_at ?? 0,
    hardExpireAt: row.hard_expire_at,
    meaning: invalidationMeaningSchema.parse(row.meaning ?? 'swr'),
    ...(history !== undefined && history.length > 1 && { history }),
  };
}

function tagsOfRevision(sql: SqlStorage, revision: number): TagRow[] {
  return sql
    .exec<TagRow>(`SELECT * FROM tags WHERE revision = ? AND stale_at IS NOT NULL`, revision)
    .toArray();
}

/** Where the scope's tags stand: its latest invalidation's revision, and when it took effect. */
function latestInvalidation(sql: SqlStorage): TagRevision {
  const row = sql
    .exec<{ revision: number; stale_at: number }>(
      `SELECT revision, stale_at FROM tags WHERE stale_at IS NOT NULL ORDER BY revision DESC LIMIT 1`,
    )
    .toArray()[0];
  return row === undefined
    ? { revision: 0, invalidatedAt: null }
    : { revision: row.revision, invalidatedAt: row.stale_at };
}

function delta(
  sql: SqlStorage,
  page: {
    readonly revision: number;
    readonly truncated: boolean;
    readonly rows: readonly TagRow[];
    readonly historical?: boolean;
  },
): TagsDeltaResponse {
  return {
    revision: page.revision,
    floor: 0,
    truncated: page.truncated,
    tags: page.rows.map((row) => toDeltaEntry(row, page.historical === true ? undefined : sql)),
    latest: latestInvalidation(sql),
  };
}

/**
 * Every tag invalidated past `since`, oldest first. Tag rows are never removed, so the floor is
 * the beginning: a reader that fell arbitrarily far behind still gets a complete delta.
 *
 * A page ends where a revision does. One invalidation writes every tag it names at one revision,
 * and the reader comes back asking for what is past the revision it was given — so a page cut
 * through the middle of one would advance it past tags it never saw, and nothing would ever send
 * them again. A revision of its own is larger than the limit is sent whole rather than in half:
 * an invalidation names at most `MAX_TAGS_PER_CALL` tags, so that page is still bounded.
 */
export function tagsDelta(
  sql: SqlStorage,
  input: { since: number; limit: number; revision: number; from?: number | undefined },
): TagsDeltaResponse {
  if (input.from !== undefined) {
    return recentDelta(sql, { ...input, from: input.from });
  }
  const rows = sql
    .exec<TagRow>(
      `SELECT * FROM tags WHERE revision > ? AND stale_at IS NOT NULL ORDER BY revision LIMIT ?`,
      input.since,
      input.limit + 1,
    )
    .toArray();
  if (rows.length <= input.limit) {
    return delta(sql, { revision: input.revision, truncated: false, rows });
  }
  const page = rows.slice(0, input.limit);
  const boundary = page.at(-1)?.revision;
  if (boundary === undefined) {
    return delta(sql, { revision: input.revision, truncated: false, rows: [] });
  }
  const whole = page.filter((row) => row.revision < boundary);
  const last = whole.at(-1);
  return delta(
    sql,
    last === undefined
      ? { revision: boundary, truncated: true, rows: tagsOfRevision(sql, boundary) }
      : { revision: last.revision, truncated: true, rows: whole },
  );
}

/** How many of the invalidations past a reader's revision a recent delta reads, newest first. */
const RECENT_NEWEST = 256;

interface RecentQuery {
  readonly since: number;
  readonly limit: number;
  readonly revision: number;
  readonly from: number;
}

/**
 * The invalidations of tags past `since` that took effect from `from` on, each as its tag stood by
 * it, oldest first and the newest `limit` at the most, `truncated` where more were: what a reader
 * that heard nothing of the scope, or nothing since `since`, may still find what it reads behind on.
 * An invalidation that took effect before `from` is in what it reads anyway — a reader asks from as
 * far back as those reads can lag.
 *
 * Each invalidation, not each tag's latest: a tag's row keeps the deadlines of the last that named
 * it, and one invalidated at once and then with a window would read as the window alone, though a
 * record from before both is past its deadline, as the authority's own condemnation keeps it.
 *
 * Read first down the revisions past `since`, a few hundred at the most (`RECENT_NEWEST`): an edge
 * asks every moment, and one that heard of the scope lately has few to read, where its window may
 * hold thousands on a busy scope. Those answer it where they are all there are past `since`, or
 * where they fill an answer. Otherwise the window is read through when each took effect
 * (`recentWindow`): a scope keeps every invalidation it ever recorded, and a walk down the
 * revisions in search of a quiet window's few would read them all.
 */
function recentDelta(sql: SqlStorage, input: RecentQuery): TagsDeltaResponse {
  const newest = sql
    .exec<TagRow>(
      `SELECT t.tag_id AS tag_id, t.kind AS kind, t.value AS value, i.revision AS revision,
              i.stale_at AS stale_at, i.hard_expire_at AS hard_expire_at, i.meaning AS meaning
       FROM invalidations AS i INDEXED BY invalidations_by_revision
       JOIN tags AS t ON t.tag_id = i.target_id
       WHERE i.target_kind = 'tag' AND i.revision > ?
       ORDER BY i.revision DESC LIMIT ?`,
      input.since,
      RECENT_NEWEST,
    )
    .toArray();
  const recent = newest.filter((row) => (row.stale_at ?? 0) >= input.from);
  const rows =
    newest.length < RECENT_NEWEST || recent.length > input.limit
      ? recent
      : recentWindow(sql, input);
  return delta(sql, {
    revision: input.revision,
    truncated: rows.length > input.limit,
    rows: rows.slice(0, input.limit).toReversed(),
    historical: true,
  });
}

/** The invalidations past `since` that took effect from `from` on, newest first (`recentDelta`). */
function recentWindow(sql: SqlStorage, input: RecentQuery): TagRow[] {
  return sql
    .exec<TagRow>(
      `SELECT t.tag_id AS tag_id, t.kind AS kind, t.value AS value, i.revision AS revision,
              i.stale_at AS stale_at, i.hard_expire_at AS hard_expire_at, i.meaning AS meaning
       FROM invalidations AS i INDEXED BY invalidations_by_stale_at
       JOIN tags AS t ON t.tag_id = i.target_id
       WHERE i.target_kind = 'tag' AND i.stale_at >= ? AND i.revision > ?
       ORDER BY i.revision DESC LIMIT ?`,
      input.from,
      input.since,
      input.limit + 1,
    )
    .toArray();
}

export function latestTagRevision(sql: SqlStorage): number {
  return sql
    .exec<{ revision: number }>('SELECT COALESCE(MAX(revision), 0) AS revision FROM tags')
    .one().revision;
}

export interface CondemnationQuery {
  readonly entryId: string;
  readonly tagIds: readonly string[];
  readonly afterRevision: number;
  /**
   * What a render's view of the tags held, where its runtime says (`viewHeld`): of each tag it held,
   * by id, the revision through which the render's reads under the tag were judged against its
   * invalidations. An immediate invalidation of one of those tags at or before it is one the render
   * read against, and made its reads afresh for; so is one with a window (`swr`) that such an
   * immediate one of its tag came after, since a tag stands at its latest invalidation and that is
   * what the view held of it. Not one with a window the view held last of its tag, under which the
   * render's reads may have been answered stale; nor one of an entry, a control fence, or a tag the
   * view held nothing of past it, which the render's reads were not judged against.
   */
  readonly held?: ReadonlyMap<string, number> | undefined;
}

/**
 * What a render's view of the tags held (`CondemnationQuery.held`), where its runtime says
 * (`heldTagRevisions`): of each of the generation's tags it says it of, what it says, though no more
 * than the revision the view was brought up to (`observedTagRevision`); and only of those of the kind
 * their value names, which the delta brings a runtime — it leaves out one of another kind
 * (`GatewayHost.tagsDelta`), a platform-delivery tag sharing a Next.js tag's value say.
 *
 * Nothing where the runtime says nothing. One from before it says only the revision its view was
 * brought up to, which does not say what the view kept of each tag: it lets a tag go past so many,
 * and judges a read under it by a copy of the tags that may be behind. Its commit is judged as one
 * whose view held no tag, as every commit was before what a view held excused anything.
 */
export function viewHeld(
  request: Pick<CommitRequest, 'observedTagRevision' | 'heldTagRevisions'>,
  refs: readonly TagRef[],
): ReadonlyMap<string, number> | undefined {
  const { heldTagRevisions, observedTagRevision } = request;
  if (heldTagRevisions === undefined) {
    return undefined;
  }
  const said = new Map(Object.entries(heldTagRevisions));
  const held = new Map<string, number>();
  for (const ref of refs) {
    const revision = said.get(ref.value);
    if (revision !== undefined && ref.kind === tagKindOf(ref.value)) {
      held.set(ref.tagId, Math.min(revision, observedTagRevision));
    }
  }
  return held;
}

/**
 * What the invalidations recorded after a render read its inputs that name what it depends on come
 * to (`weighInvalidations`): those that condemn what it made, and how far it stands past its lease
 * by those its view held, which condemn nothing.
 */
export interface Weighed {
  readonly condemning: InvalidationRow[];
  /**
   * The latest revision of an invalidation the render's view held that condemns nothing
   * (`CondemnationQuery.held`), 0 where there is none: what the render made stands as of it as it
   * stands as of its lease, each invalidation of its tags up to it judged.
   */
  readonly heldThrough: number;
}

/** The invalidations recorded after a render read its inputs that name what it depends on. */
export function weighInvalidations(sql: SqlStorage, query: CondemnationQuery): Weighed {
  const persistent = sql
    .exec<InvalidationRow>(
      `SELECT * FROM invalidations
       WHERE revision > ?
         AND ((target_kind = 'tag' AND target_id IN (SELECT value FROM json_each(?)))
           OR (target_kind = 'entry' AND target_id = ?))
       ORDER BY revision`,
      query.afterRevision,
      JSON.stringify(query.tagIds),
      query.entryId,
    )
    .toArray();
  const { held } = query;
  if (held === undefined) {
    return {
      condemning: [...persistent, ...controlFenceInvalidations(sql, query)],
      heldThrough: 0,
    };
  }
  const inView = (row: InvalidationRow): boolean =>
    row.target_kind === 'tag' && row.revision <= (held.get(row.target_id) ?? 0);
  // The latest immediate invalidation of each tag the view held: the render read that tag afresh
  // against it, and against nothing recorded of it before.
  const afresh = new Map<string, number>();
  for (const row of persistent) {
    if (inView(row) && row.meaning === 'immediate') {
      afresh.set(row.target_id, Math.max(afresh.get(row.target_id) ?? row.revision, row.revision));
    }
  }
  const condemning: InvalidationRow[] = [];
  let heldThrough = 0;
  for (const row of persistent) {
    const excused =
      inView(row) &&
      (row.meaning === 'immediate' || (afresh.get(row.target_id) ?? row.revision) > row.revision);
    if (excused) {
      heldThrough = Math.max(heldThrough, row.revision);
    } else {
      condemning.push(row);
    }
  }
  return { condemning: [...condemning, ...controlFenceInvalidations(sql, query)], heldThrough };
}

/**
 * What the invalidations a generation is published under leave it with (`weighInvalidations`):
 * stale from the earliest of them, expired at the earliest hard deadline among them, and as of the
 * latest; nothing where there are none.
 */
export function condemnationOf(
  invalidations: readonly InvalidationRow[],
): InvalidationState | null {
  if (invalidations.length === 0) {
    return null;
  }
  const staleAt = Math.min(...invalidations.map((row) => row.stale_at));
  const hardExpiries = invalidations.flatMap((row) =>
    row.hard_expire_at === null ? [] : [row.hard_expire_at],
  );
  return {
    revision: Math.max(...invalidations.map((row) => row.revision)),
    staleAt,
    ...(hardExpiries.length > 0 && { hardExpireAt: Math.min(...hardExpiries) }),
  };
}
