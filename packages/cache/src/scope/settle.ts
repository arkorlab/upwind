import { kvDataKey, kvGenerationKey, kvScopeKey } from '@stayingupwind/core/cache';

import { detailOf, type Logger } from '../logger.ts';
import {
  anyRecordBehind,
  type BacklogCursor,
  backlogRecords,
  markRecordWritten,
  recordIdsBehindAt,
  recordsBehindAmong,
  recordsBehindAt,
} from './entries.ts';
import { findGeneration } from './generations.ts';
import type { ScopeHistory } from './history.ts';
import { type BlobStore, type KvSink, writeKey } from './io.ts';
import { dataRecordJson, generationRecordBytes } from './records.ts';
import type { EntryRow } from './rows.ts';
import {
  commitRevision,
  deleteMeta,
  readMeta,
  readRevision,
  readScope,
  writeMeta,
} from './state.ts';
import {
  ControlTagProjectionError,
  type ControlTagWork,
  projectTags,
  tagProjectionPending,
} from './tag-projection.ts';

/**
 * What happens after a commit, until it has happened. Two things are owed once a transaction
 * commits: the delivery record of every entry whose current generation changed, and whatever the
 * host's history owes for the change (`ScopeHistory.publish`). Each is done from what the tables
 * say is pending, so a run that fails halfway is picked up where it stopped, by the next commit's
 * settle or by the alarm.
 *
 * Of these, only the delivery records — and the tag records beside them — are what anything is
 * served or judged from, so they are all a change waits for; what the history owes follows its
 * answer (`settlePending`).
 */

const PROJECTION_BATCH = 50;
const PROJECTION_CONCURRENCY = 8;
const META_SCOPE_MARKER = 'scope_marker_written';
const DATA_KIND_PREFIX = 'data:';

export interface SettleDeps {
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly kv: KvSink;
  readonly blobs: BlobStore;
  /** What the host keeps of the scope's history, told each change and published after it. */
  readonly history: ScopeHistory;
  readonly log: Logger;
  readonly now: () => number;
  readonly transaction: <T>(body: () => T) => T;
  /** How long a run keeps rewriting delivery records, from when it began (`projectRecords`). */
  readonly sliceMs: number;
  /** Whether another run is waiting for this one: a slice gives way to it after the chunk in hand. */
  readonly othersWaiting: () => boolean;
  /**
   * Have the alarm come back at once. A run cut at its slice asks it before its change is
   * answered, so that the rest is owed to that alarm even if the object is reset — a deploy, say —
   * before the run is over; the object keeps running the rest otherwise.
   */
  readonly continueSoon: () => Promise<void>;
}

export interface SettleOutcome {
  /** Work is still owed: the alarm must come back for it. */
  readonly pending: boolean;
  readonly failed: boolean;
  /**
   * The run wrote delivery records and stopped at its slice with records still behind: no outage,
   * and the alarm comes back at once (`settleRetryMs`).
   */
  readonly continued: boolean;
  /** Only an owned private mark failure rejects that caller after its retry alarm is armed. */
  readonly controlTagsFailed?: boolean;
}

/** Retry scheduling precedes the private caller's projection error, including unexpected failure. */
export async function finishSettle(
  outcome: SettleOutcome,
  own: ControlTagWork | undefined,
  after: (outcome: SettleOutcome) => Promise<void>,
): Promise<SettleOutcome> {
  await after(outcome);
  if (outcome.controlTagsFailed === true || own?.projected === false) {
    throw new ControlTagProjectionError();
  }
  return outcome;
}

const MILLISECONDS_PER_SECOND = 1000;
const MAX_RETRY_SECONDS = 300;

/** A second, doubling with each failure in a row, up to five minutes. */
export function retryDelayMs(failures: number): number {
  return Math.min(2 ** failures, MAX_RETRY_SECONDS) * MILLISECONDS_PER_SECOND;
}

/**
 * When the alarm comes back for what a run left: at once for a rewrite the run cut at its slice
 * while making progress — a record that keeps failing does not hold the rest back — and otherwise
 * after `retryDelayMs` of the runs in a row that failed.
 */
export function settleRetryMs(outcome: SettleOutcome, failures: number): number {
  return outcome.continued ? 0 : retryDelayMs(failures);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * A generation's delivery record a run wrote, and the record revision it was written for: what a
 * commit hands back only while the entry's record still stands at that revision
 * (`commit-record.ts`).
 */
export interface WrittenRecord {
  readonly bytes: Uint8Array;
  readonly revision: number;
}

/**
 * The generations' delivery records a change's own run hands back, where the change asks for any:
 * those it `wants`, by entry and size, asked as each is written so that no other record's bytes are
 * held past its write — a run rewrites a page of records behind at a time — and kept in `records`
 * once their write is acknowledged.
 */
export interface WantedRecords {
  readonly wants: (entryId: string, bytes: number) => boolean;
  readonly records: Map<string, WrittenRecord>;
}

/**
 * How a run writes its records: whether the scope is retired, which withdraws every one, and which
 * of the generations' records it writes the change whose run it is wants back
 * (`OwnRecords.wanted`).
 */
interface Writing {
  readonly retired: boolean;
  readonly wanted?: WantedRecords | undefined;
}

/**
 * Write the entry's delivery record as it stands, or delete it (`Writing`): the bytes of a
 * generation's record written, where the change wants them, and nothing otherwise. A record a change
 * rewrites just after the one before it went out — an invalidation's of a commit's — is refused by
 * KV for its key's second, and written once more a second later (`writeKey`), so that its change is
 * answered with it out, as it is with a tag's.
 */
async function projectEntry(
  deps: SettleDeps,
  entry: EntryRow,
  writing: Writing,
): Promise<Uint8Array | undefined> {
  const { retired, wanted } = writing;
  const data = entry.kind.startsWith(DATA_KIND_PREFIX);
  const key = data
    ? kvDataKey(deps.scopeId, entry.cache_key_digest)
    : kvGenerationKey(deps.scopeId, entry.entry_id);
  const current =
    entry.current_generation_id === null
      ? undefined
      : findGeneration(deps.sql, entry.current_generation_id);
  if (retired || current === undefined || entry.publication === 'retired') {
    await writeKey(() => deps.kv.delete(key));
    return undefined;
  }
  if (data) {
    const json = await dataRecordJson(deps, entry, current);
    await writeKey(() => deps.kv.put(key, json));
    return undefined;
  }
  const bytes = await generationRecordBytes(deps, entry, current);
  await writeKey(() => deps.kv.put(key, bytes));
  return wanted?.wants(entry.entry_id, bytes.byteLength) === true ? bytes : undefined;
}

interface ProjectedEntry {
  readonly entryId: string;
  readonly kvRevision: number;
}

/**
 * The records a page wrote that the change wants, by entry: handed on (`WantedRecords.records`) only
 * once acknowledged, since a change that committed while one was on its way left it behind already.
 */
type WrittenRecords = Map<string, WrittenRecord>;

async function projectChunk(
  deps: SettleDeps,
  chunk: readonly EntryRow[],
  writing: Writing,
  out: { readonly projected: ProjectedEntry[]; readonly records: WrittenRecords },
): Promise<number> {
  const outcomes = await Promise.allSettled(
    chunk.map((entry) => projectEntry(deps, entry, writing)),
  );
  let failed = 0;
  for (const [index, outcome] of outcomes.entries()) {
    const entry = chunk[index];
    if (entry === undefined) {
      continue;
    }
    if (outcome.status === 'fulfilled') {
      out.projected.push({ entryId: entry.entry_id, kvRevision: entry.record_revision });
      if (outcome.value !== undefined) {
        out.records.set(entry.entry_id, { bytes: outcome.value, revision: entry.record_revision });
      }
    } else {
      failed += 1;
      deps.log.warn('delivery record not written', {
        entryId: entry.entry_id,
        detail: detailOf(outcome.reason),
      });
    }
  }
  return failed;
}

/** Where the alarm's rewrite of the backlog stopped, for its next run to go on from. */
const META_BACKLOG_CURSOR = 'record_backlog_cursor';

/** Before every entry, and after every one: a pass needs no bound on either side. */
const BACKLOG_START: BacklogCursor = { kvRevision: -1, entryId: '' };
const BACKLOG_END: BacklogCursor = { kvRevision: Number.MAX_SAFE_INTEGER, entryId: '' };
const NO_RECORDS: Projection = { failed: 0, written: 0, cut: false };

/**
 * What a change left behind as it committed: the revision it committed at, and the ids of the
 * first page of the delivery records behind at it. The page is taken before the next change can
 * commit. That change may touch the same entries before this change's run begins, and its own run
 * comes after this one: read off the revision alone, those records would go out after this change
 * was answered.
 */
export interface OwnRecords {
  readonly revision: number;
  readonly first: readonly string[];
  readonly controlTags: ControlTagWork;
  /**
   * The tags it invalidated, named as it committed: a later change may invalidate one again before
   * this change's run begins, and the tag's row then names that change's revision, not this one's.
   */
  readonly tags: readonly string[];
  /**
   * Which of the generations' delivery records the run writes the change wants back, and where they
   * are kept (`WantedRecords`): a commit's entry's own, which it hands back to the Function that
   * published it (`CacheScope.commit`).
   */
  readonly wanted?: WantedRecords | undefined;
}

/** What the change that has just committed at `revision` left behind (`OwnRecords`). */
export function ownRecordsOf(
  sql: SqlStorage,
  revision: number,
  controlTags: readonly string[] = [],
  tags: readonly string[] = [],
): OwnRecords {
  return {
    revision,
    first: recordIdsBehindAt(sql, revision, PROJECTION_BATCH),
    controlTags: { ids: [...controlTags], projected: controlTags.length === 0 },
    tags: [...tags],
  };
}

function readBacklogCursor(sql: SqlStorage): BacklogCursor | undefined {
  const saved = readMeta(sql, META_BACKLOG_CURSOR);
  if (saved === undefined) {
    return undefined;
  }
  const space = saved.indexOf(' ');
  return space === -1
    ? undefined
    : { kvRevision: Number(saved.slice(0, space)), entryId: saved.slice(space + 1) };
}

function saveBacklogCursor(deps: SettleDeps, cursor: BacklogCursor | undefined): void {
  deps.transaction(() => {
    if (cursor === undefined) {
      deleteMeta(deps.sql, META_BACKLOG_CURSOR);
    } else {
      writeMeta(deps.sql, META_BACKLOG_CURSOR, `${cursor.kvRevision} ${cursor.entryId}`);
    }
  });
}

interface Projection {
  readonly failed: number;
  readonly written: number;
  /** Stopped at the slice, or for a run waiting, with records still behind. */
  readonly cut: boolean;
}

interface PageOutcome {
  readonly failed: number;
  readonly written: number;
  /** How many of the page's entries were tried before `stop` said to stop. */
  readonly reached: number;
}

/**
 * What went out, acknowledged in one transaction: marked written, and an event for the history.
 * The entries marked: one a later change touched while its record was on its way is left behind,
 * and its record is not the entry's to hand on.
 */
function acknowledge(deps: SettleDeps, projected: readonly ProjectedEntry[]): Set<string> {
  const marked = new Set<string>();
  if (projected.length === 0) {
    return marked;
  }
  deps.transaction(() => {
    for (const entry of projected) {
      if (markRecordWritten(deps.sql, entry.entryId, entry.kvRevision)) {
        marked.add(entry.entryId);
      }
    }
    const revision = readRevision(deps.sql) + 1;
    commitRevision(deps.sql, revision);
    deps.history.append(
      { sql: deps.sql, revision, now: deps.now() },
      {
        entityType: 'scope',
        entityId: deps.scopeId,
        kind: 'entries.projected',
        payload: { entries: projected },
      },
    );
  });
  return marked;
}

/** Rewrite a page a chunk at a time, asking `stop` after each chunk; acknowledge what went out. */
async function projectPage(
  deps: SettleDeps,
  entries: readonly EntryRow[],
  writing: Writing,
  stop: () => boolean,
): Promise<PageOutcome> {
  const out = { projected: [] as ProjectedEntry[], records: new Map() as WrittenRecords };
  let failed = 0;
  let reached = 0;
  for (const chunk of chunks(entries, PROJECTION_CONCURRENCY)) {
    failed += await projectChunk(deps, chunk, writing, out);
    reached += chunk.length;
    if (stop()) {
      break;
    }
  }
  const marked = acknowledge(deps, out.projected);
  for (const [entryId, record] of out.records) {
    if (marked.has(entryId)) {
      writing.wanted?.records.set(entryId, record);
    }
  }
  return { failed, written: out.projected.length, reached };
}

/**
 * The records a change left behind (`OwnRecords`), for its own run: a commit's, so it is answered
 * with its record written; a large invalidation's, first slice first. The first page is the one
 * the change left, and a record of it that a later change has touched since goes out all the same,
 * as it stands now. Past it, the records are read off the revision, and one a later change has
 * touched is that change's to rewrite: this change is answered after its first slice, which gives
 * way to the later change's run, waiting behind it, after the chunk in hand. Another change's
 * records are its own run's, and older ones the alarm's; a lease leaves none, and is answered
 * without waiting for any run (`SettleRun.answerNow`).
 */
async function projectOwn(
  deps: SettleDeps,
  own: OwnRecords,
  stop: () => boolean,
): Promise<Projection> {
  const retired = readScope(deps.sql)?.status === 'retired';
  let failed = 0;
  let written = 0;
  let entries = recordsBehindAmong(deps.sql, own.first);
  // Where the next page of the revision's records begins, and whether there may be one.
  let after = own.first.at(-1) ?? '';
  let more = own.first.length === PROJECTION_BATCH;
  for (;;) {
    if (entries.length > 0) {
      const page = await projectPage(deps, entries, { retired, wanted: own.wanted }, stop);
      failed += page.failed;
      written += page.written;
      if (page.reached < entries.length) {
        return { failed, written, cut: true };
      }
      if (more && stop()) {
        const rest = recordsBehindAt(deps.sql, own.revision, after, PROJECTION_BATCH);
        return { failed, written, cut: rest.length > 0 };
      }
    }
    if (!more) {
      return { failed, written, cut: false };
    }
    entries = recordsBehindAt(deps.sql, own.revision, after, PROJECTION_BATCH);
    after = entries.at(-1)?.entry_id ?? after;
    more = entries.length === PROJECTION_BATCH;
  }
}

/**
 * The alarm's rewrite of the backlog, a pass at a time around the records behind in their order
 * (`backlogRecords`), going on from where the last run stopped: a record that keeps failing is
 * tried once a pass and holds nothing behind it back. A pass that began in the middle comes round
 * to the front before it ends.
 */
async function projectBacklog(deps: SettleDeps, stop: () => boolean): Promise<Projection> {
  const retired = readScope(deps.sql)?.status === 'retired';
  const saved = readBacklogCursor(deps.sql);
  let after = saved ?? BACKLOG_START;
  let until = BACKLOG_END;
  let wrapped = saved === undefined;
  let failed = 0;
  let written = 0;
  for (;;) {
    const entries = backlogRecords(deps.sql, after, until, PROJECTION_BATCH);
    if (entries.length === 0) {
      if (!wrapped && saved !== undefined) {
        wrapped = true;
        after = BACKLOG_START;
        until = saved;
        continue;
      }
      saveBacklogCursor(deps, undefined);
      return { failed, written, cut: false };
    }
    const page = await projectPage(deps, entries, { retired }, stop);
    failed += page.failed;
    written += page.written;
    const last = entries[page.reached - 1];
    if (last !== undefined) {
      after = { kvRevision: last.kv_revision, entryId: last.entry_id };
    }
    if (page.reached < entries.length || stop()) {
      saveBacklogCursor(deps, after);
      return { failed, written, cut: anyRecordBehind(deps.sql) };
    }
  }
}

/**
 * Rewrite the delivery records that are behind, in bounded parallel, for one slice: the first
 * chunk always, then until `sliceMs` has passed since the run began or another run is waiting. A
 * change's run writes its own records (`projectOwn`), and one that committed nothing, none; the
 * alarm's, which answer no change, the backlog (`projectBacklog`).
 */
async function projectRecords(
  deps: SettleDeps,
  from: OwnRecords | null | undefined,
): Promise<Projection> {
  if (from === null) {
    return NO_RECORDS;
  }
  const started = deps.now();
  const stop = (): boolean => deps.now() - started >= deps.sliceMs || deps.othersWaiting();
  return from === undefined ? projectBacklog(deps, stop) : projectOwn(deps, from, stop);
}

/** A retired scope is marked in KV once, so a straggling Worker is refused without the authority. */
async function writeScopeMarker(deps: SettleDeps): Promise<void> {
  const scope = readScope(deps.sql);
  if (scope?.status !== 'retired' || readMeta(deps.sql, META_SCOPE_MARKER) !== undefined) {
    return;
  }
  await deps.kv.put(
    kvScopeKey(deps.scopeId),
    JSON.stringify({ status: 'retired', retiredAt: scope.retired_at }),
  );
  deps.transaction(() => {
    writeMeta(deps.sql, META_SCOPE_MARKER, '1');
  });
}

/**
 * A retirement is acknowledged once its scope's marker is in KV. A straggling Worker is refused by
 * the marker, and a retirement answered without it would leave the retired deployment's token
 * reading the scope's records until a later run wrote it. Its caller tries again, and is answered
 * once a run — the retry's own, or the alarm's — has written it (`writeScopeMarker`).
 */
export function requireScopeMarker(sql: SqlStorage): void {
  if (readMeta(sql, META_SCOPE_MARKER) === undefined) {
    throw new Error('the scope is retired, but its marker is not written yet');
  }
}

function failure(deps: SettleDeps, what: string, outcome: PromiseSettledResult<unknown>): boolean {
  if (outcome.status === 'rejected') {
    deps.log.warn(`${what} not settled`, { detail: detailOf(outcome.reason) });
    return true;
  }
  return false;
}

function workRemains(deps: SettleDeps): boolean {
  const { sql } = deps;
  return deps.history.owes(sql) || anyRecordBehind(sql) || tagProjectionPending(sql);
}

/** How many settle runs in a row have failed (`countSettleFailures`). */
const META_SETTLE_FAILURES = 'settle_failures';

/**
 * How many settle runs in a row have failed, for the backoff of the alarm that comes back for what
 * a run left owed (`settleRetryMs`): written down as each run ends, forgotten once one owes nothing.
 * A run cut at its slice while making progress is no failure, however many of its records failed.
 * The count is bookkeeping: a failure to write it is logged and let go, and the next run counts again.
 */
export function countSettleFailures(sql: SqlStorage, log: Logger, outcome: SettleOutcome): number {
  let failures = 0;
  try {
    if (!(outcome.failed || outcome.pending)) {
      deleteMeta(sql, META_SETTLE_FAILURES);
      return 0;
    }
    failures =
      outcome.failed && !outcome.continued
        ? Number(readMeta(sql, META_SETTLE_FAILURES) ?? '0') + 1
        : 0;
    writeMeta(sql, META_SETTLE_FAILURES, String(failures));
  } catch (error) {
    log.error('settle outcome not recorded', { detail: detailOf(error) });
  }
  return failures;
}

/** A settle run: when its change may be answered, and when it is over. */
export interface SettleRun {
  readonly answered: Promise<void>;
  readonly done: Promise<void>;
  /**
   * Let its change be answered now, before the runs ahead of this one are over: for a change that
   * leaves the run nothing to write before its answer, a lease say (`CacheScope#mutate`).
   */
  readonly answerNow: () => void;
}

/**
 * Start a run once the one before it is over. Its change waits for `answered`, which comes early
 * when the run says so, or at once when the change does (`answerNow`), and otherwise with the end
 * of the run — or with its failure, so a run that fails before its change has an answer fails the
 * change as well.
 */
export function chainSettle(
  previous: Promise<void>,
  log: Logger,
  run: (answered: () => void) => Promise<void>,
): SettleRun {
  const answer = Promise.withResolvers<undefined>();
  void answer.promise.catch(() => {
    // Not every caller asks for the answer — `tick` waits for `done`, which carries the same
    // failure — and one nobody asked for must not go unhandled.
  });
  const said = { early: false };
  const answerNow = (): void => {
    said.early = true;
    answer.resolve(undefined);
  };
  const done = (async (): Promise<void> => {
    try {
      await previous;
    } catch (error) {
      // What a run waits for is that the one before it is over, not that it went well. Passed
      // on, one failure would fail every later run before it began — and with it every mutation
      // after, each committed and answered as an error — for as long as the object stayed in
      // memory. The run that follows a failure is the one that would repair it.
      log.warn('previous settle interrupted', { detail: detailOf(error) });
    }
    await run(answerNow);
  })();
  const over = async (): Promise<void> => {
    await done;
    answer.resolve(undefined);
  };
  void over().catch((error: unknown) => {
    if (said.early) {
      // The change had its answer; what is still owed, the next run or the alarm settles.
      log.error('settle failed after the answer', { detail: detailOf(error) });
    } else {
      answer.reject(error);
    }
  });
  return { answered: answer.promise, done, answerNow };
}

/**
 * Do what is owed, as far as it goes; never throws. `from` is what the change this run answers
 * left behind as it committed (`ownRecordsOf`), whose delivery records it rewrites — `null` for a
 * change that committed nothing, a heartbeat or a refusal, whose run rewrites none; the alarm's
 * runs, which answer no change, leave it out and rewrite the backlog.
 *
 * `answered` is told once what a change owes before it is answered is done — the delivery and tag
 * records it changed, and the scope's marker when it retired it — and none of it fell short. Of its
 * delivery records that is one slice (`projectRecords`): all of them for a commit or a small
 * invalidation, the first for a large one, whose rest the alarm comes back for at once. A run that
 * fell short says nothing early, and its change waits for all of it.
 *
 * What the host's history owes follows the answer, the change's own with the acknowledgment of
 * its delivery records, which its projection recorded: nothing is served or judged from it, so
 * neither a regeneration's commit nor an `updateTag` waits on it. The object goes on with it once
 * it has answered, as it does with any I/O under way; what fails is owed to the alarm (`pending`,
 * `failed`), and what a reset of the object cuts short — a deploy, say — to the next change's run
 * or to the alarm the change armed before its answer. A change that follows before the run is over
 * waits for it as for any run before its own, unless the history leaves its share to that
 * change's run (`HistoryDeps.othersWaiting`) — or unless it leaves no record of its own, a lease
 * say, and waits for no run at all (`SettleRun.answerNow`).
 */
export async function settlePending(
  deps: SettleDeps,
  answered?: () => void,
  from?: OwnRecords | null,
): Promise<SettleOutcome> {
  const [projection, marker, tags] = await Promise.allSettled([
    projectRecords(deps, from),
    writeScopeMarker(deps),
    projectTags(deps, from?.controlTags, from?.tags),
  ]);
  const projectionFailed = projection.status === 'fulfilled' && projection.value.failed > 0;
  const shortfall =
    [projection, marker, tags].some((outcome) => outcome.status === 'rejected') || projectionFailed;
  const cut = projection.status === 'fulfilled' && projection.value.cut;
  const continuation = !shortfall && cut ? await Promise.allSettled([deps.continueSoon()]) : [];
  if (!shortfall && continuation.every((outcome) => outcome.status === 'fulfilled')) {
    answered?.();
  }
  const [records, delivery] = await deps.history.publish(deps);
  // Every outcome is asked, not the first that answers: an outage fails several of these at once,
  // and the ones `||` would have skipped are the ones nothing else would ever say.
  const rejected = [
    failure(deps, 'history storage', records),
    failure(deps, 'scope marker', marker),
    failure(deps, 'tag records', tags),
    failure(deps, 'history delivery', delivery),
    failure(deps, 'delivery records', projection),
    ...continuation.map((outcome) => failure(deps, 'continuation alarm', outcome)),
  ];
  return {
    pending: workRemains(deps),
    failed: rejected.includes(true) || projectionFailed,
    continued:
      projection.status === 'fulfilled' && projection.value.cut && projection.value.written > 0,
    ...(tags.status === 'rejected' &&
      tags.reason instanceof ControlTagProjectionError && { controlTagsFailed: true }),
  };
}
