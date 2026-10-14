import {
  type ApplyResourceChangeInput,
  type ApplyResourceChangeResult,
  type CommitRequest,
  type FailRequest,
  type FailResponse,
  type FinishResourceWarmJobInput,
  type FinishResourceWarmJobResult,
  type InvalidateRequest,
  type ListResourceWarmJobsInput,
  type ListResourceWarmJobsResult,
  type PublicCacheGeneration,
  type ReadArtifactLocationResult,
  type ReadEntryResult,
  type ReadGenerationResult,
  type ReadHeadResult,
  type ResolveResponse,
  type SeedEntriesInput,
  type SeedEntriesResult,
  type SeedScopeInput,
  type SeedScopeResult,
  type StartAttemptRequest,
  type TagsDeltaResponse,
} from '@stayingupwind/host/cache';
import { DurableObject } from 'cloudflare:workers';

import type { CacheBindings } from '../bindings.ts';
import { limitsOf, parseVars, type ScopeLimits, type Vars } from '../env.ts';
import { createLogger, detailOf, type Logger } from '../logger.ts';
import {
  applyFail,
  applyHeartbeat,
  applyRecordArtifact,
  expireLeases,
  findAttempt,
  nextLeaseExpiry,
  planStartAttempt,
  type UploadedArtifact,
} from './attempts.ts';
import { wantedRecords, withCurrentRecord, withWrittenRecord } from './commit-record.ts';
import { type CommitOutcome, planCommit } from './commit.ts';
import {
  dataUploadExpired,
  type DataUploadPage,
  dataUploadStartedAt,
  listDataUploads,
} from './data-uploads.ts';
import { type DataSetInput, type DataSetOutcome, planSetData } from './data.ts';
import {
  type HistoryFactory,
  type HistoryFields,
  NO_HISTORY,
  type ScopeHistory,
} from './history.ts';
import { type InvalidateResult, planInvalidate } from './invalidations.ts';
import { type BlobStore, blobStore, checkFault, kvSink, type TestFaults } from './io.ts';
import { Alarm, commitMutation, initializeScope, scopeName, ScopeQueue } from './mutations.ts';
import {
  type ArtifactLocation,
  locateArtifact,
  readArtifactLocation,
  readEntry,
  readGeneration,
  readHead,
  resolveEntry,
} from './reads.ts';
import {
  claimResourceWarmJobs,
  finishResourceWarmJob,
  planApplyResourceChange,
} from './resource-changes.ts';
import {
  eraseScopeStorage,
  nextRetentionAt,
  retentionDue,
  runRetention,
  type TickOptions,
} from './retention-run.ts';
import { applyRetire, applySeedScope, planSeedEntries, type RetireOutcome } from './seed.ts';
import {
  chainSettle,
  finishSettle,
  type OwnRecords,
  requireScopeMarker,
  retryDelayMs,
  type SettleDeps,
  type SettleOutcome,
  settlePending,
  settleRetryMs,
  countSettleFailures,
  type SettleRun,
  type WantedRecords,
} from './settle.ts';
import {
  isRefusal,
  readRevision,
  readScope,
  type Refusal,
  refuse,
  requireActiveScope,
} from './state.ts';
import { tagsDelta } from './tags.ts';
import type { Apply, TxInput } from './tx.ts';

/**
 * One deployment's cache authority: the only writer of its entries, generations, tags,
 * invalidations and leases, addressed with `idFromName(scopeId)`, and created where its host would
 * prefer it (`AuthorityHost.locationHint`: a hint, which the runtime need not follow).
 *
 * Every mutation is one synchronous SQLite transaction at one scope revision, planned under a
 * mutex so the ids derived ahead of it are derived for the revision it commits at. What the commit
 * owes to KV, and whatever the host's history owes for it (`ScopeHistory.publish`), is settled
 * afterwards — awaited by the caller as far as the delivery and tag records, which are what is
 * served and judged, so those are written before a change is answered, while what the history owes
 * follows the answer, and a change that owes no such record is answered as it commits — and by the
 * alarm when that fails, or when a rewrite is larger than one run's slice.
 *
 * It holds no tables until it is seeded, and none once retention has erased it. Reached for a scope
 * it holds no tables of, it answers as for one never seeded, and writes nothing: a straggler's call
 * to a scope retention erased leaves no object behind.
 */

const LEASE_SWEEP_GRACE_MS = 1000;
const MILLISECONDS_PER_HOUR = 3_600_000;
const RETENTION_INTERVAL_MS = MILLISECONDS_PER_HOUR;
const NOT_SEEDED = refuse('not_found', 'the scope has not been seeded');
const NOT_RECORDED = { kind: 'not-recorded' } as const;
/** What a change to an object that holds no tables is answered with (`#mutate`). */
const REFUSED = { empty: NOT_SEEDED } as const;
/**
 * The same, for a change of an operation that never leaves a delivery or tag record of its own,
 * which is answered as it commits rather than after the settle runs (`#mutate`).
 */
const AT_ONCE = { ...REFUSED, atOnce: true } as const;
const UNKNOWN = { empty: { kind: 'unknown' } } as const;
/**
 * What a seed is answered with where retention erased a retired scope here. A seed leaves no record
 * of its own either, and is answered as it commits (`AT_ONCE`).
 */
const SEED = { seed: { kind: 'conflict', reason: 'the scope is retired' }, atOnce: true } as const;

export class CacheScope extends DurableObject<CacheBindings> {
  /** The history a host keeps of each scope, made as each object is (`ScopeHistory`): none here. */
  static readonly historyOf: HistoryFactory = () => NO_HISTORY;
  readonly #mutations = new ScopeQueue();
  readonly #alarm = new Alarm(this.ctx.storage);
  #settling: Promise<void> = Promise.resolve();
  /** Settle runs asked for and not begun: a run's slice gives way to them (`othersWaiting`). */
  #waiting = 0;
  #faults: TestFaults = {};
  #testLimits: Partial<ScopeLimits> = {};
  #logger: Logger | undefined;
  /** Whether this object holds its scope's tables (`holdsScopeTables`). */
  #tables: boolean;
  readonly #history: ScopeHistory;

  constructor(ctx: DurableObjectState, env: CacheBindings) {
    super(ctx, env);
    this.#history = new.target.historyOf(env, () => this.#faults);
    this.#tables = initializeScope(ctx.storage.sql, Date.now(), this.#history);
  }

  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  get #scopeId(): string {
    return scopeName(this.ctx);
  }

  get #vars(): Vars {
    return parseVars(this.env);
  }

  get #limits(): ScopeLimits {
    return { ...limitsOf(this.#vars), ...this.#testLimits };
  }

  get #log(): Logger {
    this.#logger ??= createLogger({ scopeId: this.#scopeId });
    return this.#logger;
  }

  #deps(): SettleDeps {
    const faults = (): TestFaults => this.#faults;
    return {
      sql: this.#sql,
      scopeId: this.#scopeId,
      kv: kvSink(this.env.CACHE_STATE, faults),
      blobs: blobStore(this.env.ARTIFACTS, faults),
      history: this.#history,
      log: this.#log,
      now: Date.now,
      transaction: (body) => this.ctx.storage.transactionSync(body),
      sliceMs: this.#limits.projectionSliceMs,
      othersWaiting: () => this.#waiting > 0,
      continueSoon: () => this.#armAlarm(Date.now()),
    };
  }

  /**
   * A change to an object that holds no tables is answered with `empty`, and nothing of it is
   * written, settled or armed. A seed makes the tables instead — unless retention erased a retired
   * scope here, whose marker in KV outlives it: a retired scope is never seeded again, and the seed
   * is answered with `seed`. Both are decided under the lock, where erasure happens.
   *
   * A change that committed is answered once the run that follows its commit has written the
   * delivery and tag records it left, and runs go one after another (`#settle`): it waits for the
   * runs asked for before its own as well, an invalidation's rewrite say. A change of an operation
   * that never leaves such a record — a lease, a heartbeat, an upload's record, a failed attempt's
   * end, a seed — is answered as it commits instead (`AT_ONCE`, `SEED`). Its answer is read from
   * its own transaction, and nothing its caller does next is held to what a run writes: KV is read
   * where the caller runs, behind by its cache and its propagation whatever has been written, and
   * a render is held to the tags by its own pull of the delta, which the authority answers from
   * its tables and the render's commit is judged against (`observedTagRevision`). Its run is asked
   * for all the same, behind the others: it publishes what the history owes for the change and
   * takes up what the runs before it left, and it fails as a run does after its answer — logged,
   * with its retry armed as it ends, or owed to the alarm armed below.
   *
   * An operation that may leave records waits for its run though a call of it left none, a refusal
   * say: a call made again for a change already made — a commit that published, a batch seeded, a
   * resource change applied, a scope retired — is answered for what that change left, which the
   * runs before its own may still be writing. A commit made again carries the record of its
   * generation only once that is written (`withWrittenRecord`).
   */
  async #mutate<T>(
    now: number,
    plan: (input: TxInput) => Apply<T> | Promise<Apply<T>>,
    answers: { readonly atOnce?: boolean } & ({ readonly empty: T } | { readonly seed: T }),
    wanted?: WantedRecords,
  ): Promise<T> {
    const result = await this.#mutations.run(async () => {
      const committed = await commitMutation(
        {
          storage: this.ctx.storage,
          scopeId: this.#scopeId,
          kv: this.env.CACHE_STATE,
          limits: this.#limits,
          history: this.#history,
          tables: this.#tables,
          createdTables: () => {
            this.#tables = true;
          },
        },
        now,
        plan,
        answers,
      );
      this.#tables = committed.tables;
      return committed;
    });
    if (result.own === undefined) return result.value;
    const run = this.#settle(result.own === null ? null : { ...result.own, wanted });
    if (answers.atOnce === true) run.answerNow();
    await run.answered;
    // Armed before the answer, not after it: what the run still does once the change is answered —
    // what the host's history owes for it — is owed to this alarm, or to an earlier one, should the
    // object be reset before the run is over. Erasure may have come between: what is gone is not
    // asked for. An answer read from its own transaction is not taken back for it (`#armOrLog`).
    if (this.#tables && readScope(this.#sql) !== undefined) {
      const at = now + RETENTION_INTERVAL_MS;
      await (answers.atOnce === true ? this.#armOrLog(at) : this.#armAlarm(at));
    }
    return result.value;
  }

  /**
   * Arm the alarm for a change answered as it commits (`AT_ONCE`), whose answer is read from its own
   * transaction: a failure to is logged, not thrown. Its caller, told nothing, would make the change
   * again or give it up — a lease's would never have its fencing token, and the lease would stand
   * until its time ran out. What the alarm would come back for waits for the next change's run, or
   * for the host's check on the scope's retention (`ensureRetention`).
   */
  async #armOrLog(at: number): Promise<void> {
    try {
      await this.#armAlarm(at);
    } catch (error) {
      this.#log.error('alarm not armed', { detail: detailOf(error) });
    }
  }

  /**
   * Settles run one after another; a caller waits for the run that follows its commit — for the
   * whole of it (`done`), or only until what its change owes is done (`answered`, see
   * `settlePending`), or not at all where it owes nothing before its answer (`answerNow`). A run
   * that fails before then fails the caller's wait as well. `from` is what a change left behind as
   * it committed (`ownRecordsOf`), whose records its run writes, or `null` when it committed
   * nothing; the alarm's runs leave it out and write the backlog.
   */
  #settle(from?: OwnRecords | null, ended?: (outcome: SettleOutcome) => void): SettleRun {
    this.#waiting += 1;
    const run = chainSettle(this.#settling, this.#log, async (answered) => {
      this.#waiting -= 1;
      // Awaited on its own: as the argument of `ended?.(…)`, the run would not happen at all for a
      // caller with no `ended`.
      const outcome = await this.#runSettle(answered, from);
      ended?.(outcome);
    });
    this.#settling = run.done;
    return run;
  }

  async #runSettle(
    answered: () => void,
    from: OwnRecords | null | undefined,
  ): Promise<SettleOutcome> {
    if (!this.#tables) {
      // Erased while the run waited its turn: nothing of the scope is left to settle.
      return { pending: false, failed: false, continued: false };
    }
    let outcome: SettleOutcome;
    try {
      outcome = await settlePending(this.#deps(), answered, from);
    } catch (error) {
      this.#log.error('settle failed', { detail: detailOf(error) });
      outcome = { pending: true, failed: true, continued: false };
    }
    return finishSettle(outcome, from?.controlTags, this.#afterSettle.bind(this));
  }

  /**
   * An alarm's settle, whole, and whether it left anything owed: a run that could not deliver an
   * event or write a record ends as any other does, with its retry armed (`#afterSettle`).
   */
  async #settleOwes(): Promise<boolean> {
    const ended: { outcome?: SettleOutcome } = {};
    await this.#settle(undefined, (outcome) => {
      ended.outcome = outcome;
    }).done;
    return ended.outcome === undefined || ended.outcome.failed || ended.outcome.pending;
  }

  /**
   * What a settle leaves for the next one: how many have failed in a row, and — when work is still
   * owed — the alarm that comes back for it (`settleRetryMs`): at once for the rest of a rewrite a
   * run cut at its slice while making progress, which is no failure however many of its records
   * did fail, and after a backoff otherwise.
   *
   * The count is bookkeeping, and a failure to write it is logged and let go: the next settle
   * counts again. The alarm is not. Owed work that nothing is armed to come back for waits for
   * whatever change arrives next, which may be none; so a failure to arm it goes to the caller —
   * the change whose settle owed the work, and the one party that can try again — or, for the
   * alarm's own settle, to the runtime, which retries a failed alarm. A change answered before its
   * run was over — any whose delivery and tag records went out, since what the host's history owes
   * follows the answer, and any that owed no such record (`AT_ONCE`) — has gone by then: the
   * failure is logged, and what is owed waits for the next change's run to arm the alarm, or for
   * the one armed before that change was answered (`#mutate`).
   */
  async #afterSettle(outcome: SettleOutcome): Promise<void> {
    const failures = countSettleFailures(this.#sql, this.#log, outcome);
    if (outcome.failed || outcome.pending) {
      await this.#armAlarm(Date.now() + settleRetryMs(outcome, failures));
    }
  }

  /** The alarm is one per object: it fires at the earliest of what anything asked for. */
  async #armAlarm(at: number): Promise<void> {
    checkFault(() => this.#faults, 'alarm');
    await this.#alarm.arm(at);
  }

  async #rearm(now: number): Promise<void> {
    if (!this.#tables || readScope(this.#sql) === undefined) {
      // Nothing is seeded here: an object that holds no tables, or tables but no scope row. It has
      // nothing to prune and nothing to settle, and an alarm would only wake it again.
      return;
    }
    const lease = nextLeaseExpiry(this.#sql);
    if (lease !== undefined) await this.#armAlarm(lease + LEASE_SWEEP_GRACE_MS);
    await this.#armAlarm(nextRetentionAt(this.#sql, now, RETENTION_INTERVAL_MS));
  }

  async #listDataUploads(): Promise<DataUploadPage | undefined> {
    try {
      return await listDataUploads({
        sql: this.#sql,
        scopeId: this.#scopeId,
        blobs: this.#blobs(),
      });
    } catch (error) {
      this.#log.warn('data uploads not swept', { detail: detailOf(error) });
      return undefined;
    }
  }

  #blobs(): BlobStore {
    return blobStore(this.env.ARTIFACTS, () => this.#faults);
  }

  /**
   * Everything of the scope left in storage once its history is over: whatever the host's history
   * wrote under the scope's prefix, and any blob a failed write left behind. Its tables are about
   * to go, and after that nothing could name them.
   */
  async #eraseStorage(): Promise<boolean> {
    return eraseScopeStorage(this.#scopeId, this.#blobs(), this.#log);
  }

  #requireTestHooks(): void {
    if (!this.#vars.ARKOR_TEST_HOOKS) {
      throw new Error('test hooks are off');
    }
  }

  // ---- what a deploy calls ---------------------------------------------------------------------

  async seedScope(input: SeedScopeInput, now: number): Promise<SeedScopeResult> {
    const outcome = await this.#mutate(now, (tx) => () => applySeedScope(tx, input), SEED);
    if (this.#tables && readScope(this.#sql)?.status === 'active') {
      // An upload may never reach setData at all. Seeding must arm its eventual orphan sweep.
      await this.#armAlarm(now + RETENTION_INTERVAL_MS);
    }
    return outcome;
  }

  /**
   * Arm the alarm again (`#rearm`), as a host that checks on its scopes from time to time asks, so
   * that a scope whose sweep is not armed is swept again. Asked to, it has the host's history stop
   * as well, for good (`ScopeHistory.stop`), as that history reads `epoch`; what came of it is the
   * answer.
   */
  async ensureRetention(now: number, stop = false, epoch?: number): Promise<HistoryFields | null> {
    return this.#mutations.run(async () => {
      const stopped = stop ? this.#history.stop(this.ctx.storage, now, epoch) : null;
      await this.#rearm(now);
      return stopped;
    });
  }

  async seedEntries(input: SeedEntriesInput, now: number): Promise<SeedEntriesResult | Refusal> {
    const result = await this.#mutate(now, (tx) => planSeedEntries(tx, input), REFUSED);
    if (!isRefusal(result)) {
      for (const refused of result.refused) {
        this.#log.warn('build entry not seeded', {
          pathname: refused.descriptor.pathname,
          detail: refused.reason,
        });
      }
    }
    return result;
  }

  async retire(reason: string, now: number): Promise<RetireOutcome> {
    const outcome = await this.#mutate(now, (tx) => () => applyRetire(tx, reason), UNKNOWN);
    if (outcome.kind === 'retired') {
      // A scope that only ever held a build's seed has never armed an alarm: without one here,
      // nothing would come back to prune its bodies or, in the end, delete it.
      await this.#armAlarm(now);
    }
    // Answered once its marker is out, the run before the answer having written it or failed to.
    if (outcome.kind !== 'unknown' && this.#tables) requireScopeMarker(this.#sql);
    return outcome;
  }

  applyResourceChange(
    input: ApplyResourceChangeInput,
    now: number,
  ): Promise<ApplyResourceChangeResult | Refusal> {
    return this.#mutate(now, (tx) => planApplyResourceChange(tx, input), REFUSED);
  }

  async listResourceWarmJobs(
    input: ListResourceWarmJobsInput,
    now: number,
  ): Promise<ListResourceWarmJobsResult> {
    return this.#mutations.run(() => {
      if (!this.#tables) return { jobs: [], nextRetryAt: null };
      return this.ctx.storage.transactionSync(() => claimResourceWarmJobs(this.#sql, input, now));
    });
  }

  async finishResourceWarmJob(
    input: FinishResourceWarmJobInput,
    now: number,
  ): Promise<FinishResourceWarmJobResult> {
    return this.#mutations.run(() => {
      if (!this.#tables) return { kind: 'unknown', nextRetryAt: null };
      return this.ctx.storage.transactionSync(() => finishResourceWarmJob(this.#sql, input, now));
    });
  }

  // ---- regeneration ----------------------------------------------------------------------------

  /** Take an entry's lease, answered with the record of a later generation (`withCurrentRecord`). */
  async startAttempt(
    request: StartAttemptRequest,
    now: number,
  ): ReturnType<typeof withCurrentRecord> {
    const result = await this.#mutate(now, (tx) => planStartAttempt(tx, request), AT_ONCE);
    if (result.kind === 'leased') {
      await this.#armOrLog(result.leaseExpiresAt + LEASE_SWEEP_GRACE_MS);
    }
    return withCurrentRecord(result, request.replaces, this.#deps());
  }

  heartbeat(
    attemptId: string,
    fencingToken: number,
    now: number,
  ): Promise<Refusal | { readonly leaseExpiresAt: number }> {
    return this.#mutate(now, (tx) => () => applyHeartbeat(tx, attemptId, fencingToken), AT_ONCE);
  }

  recordArtifact(
    attemptId: string,
    upload: UploadedArtifact & { readonly fencingToken: number },
    now: number,
  ): Promise<Refusal | { readonly ok: true }> {
    return this.#mutate(now, (tx) => () => applyRecordArtifact(tx, attemptId, upload), AT_ONCE);
  }

  /** Publish an attempt's generation, answered with the record its settle wrote (`withWrittenRecord`). */
  commit(attemptId: string, request: CommitRequest, now: number): Promise<CommitOutcome | Refusal> {
    // A retired scope's commit is refused before its planning asks storage anything.
    const plan = async (tx: TxInput): Promise<Apply<CommitOutcome | Refusal>> => {
      const scope = requireActiveScope(tx.sql);
      return isRefusal(scope) ? () => scope : planCommit(tx, attemptId, request, this.#blobs());
    };
    const entryOf = (): string | undefined => findAttempt(this.#sql, attemptId)?.entry_id;
    const wanted = wantedRecords(entryOf);
    const committed = this.#mutate(now, plan, REFUSED, wanted);
    return withWrittenRecord(committed, wanted.records, entryOf, this.#deps());
  }

  fail(attemptId: string, request: FailRequest, now: number): Promise<FailResponse | Refusal> {
    return this.#mutate(now, (tx) => () => applyFail(tx, attemptId, request), AT_ONCE);
  }

  // ---- data cache and invalidation ------------------------------------------------------------

  async setData(input: DataSetInput, now: number): Promise<DataSetOutcome | Refusal> {
    const adopt = async (tx: TxInput): Promise<Apply<DataSetOutcome | Refusal>> => {
      const scope = requireActiveScope(this.#sql);
      if (isRefusal(scope)) return () => scope;
      const startedAt = dataUploadStartedAt(this.#scopeId, input.value.storageRef);
      const authorityNow = this.#vars.ARKOR_TEST_HOOKS ? now : Date.now();
      if (startedAt !== undefined && dataUploadExpired(this.#sql, startedAt, authorityNow)) {
        return () => refuse('lease_expired', 'the data upload expired before adoption');
      }
      // A key that carries no upload clock (`dataUploadStartedAt`) is checked for existence under
      // the same mutex as GC, through the store every other read of storage goes through; current
      // uploads use the timestamp fence without another R2 read.
      if (startedAt === undefined && !(await this.#blobs().exists(input.value.storageRef))) {
        return () => refuse('artifact_missing', 'the data upload is no longer present');
      }
      return planSetData(tx, input);
    };
    const outcome = await this.#mutate(now, adopt, REFUSED);
    const needsCleanup =
      !isRefusal(outcome) ||
      (outcome.code === 'quota_exceeded' && (readScope(this.#sql)?.body_bytes ?? 0) > 0);
    if (needsCleanup) {
      // A dynamic app may only write data entries and never lease a route regeneration. It
      // still accumulates former generations. Keep an earlier lease or retry alarm, and
      // schedule cleanup even when an already-full scope cannot accept this write.
      await this.#armAlarm(now + RETENTION_INTERVAL_MS);
    }
    return outcome;
  }

  /** Only the private control entrypoint selects absent-tag fanout; the gateway uses the default. */
  invalidate(request: InvalidateRequest, now: number, mode?: 'control'): Promise<InvalidateResult> {
    return this.#mutate(now, (tx) => planInvalidate(tx, request, mode), REFUSED);
  }

  // ---- reads ------------------------------------------------------------------------------------

  // An object that holds no tables answers each as for a scope never seeded.

  tagsDelta(since: number, limit: number, from?: number): TagsDeltaResponse {
    return this.#tables
      ? tagsDelta(this.#sql, { since, limit, from, revision: readRevision(this.#sql) })
      : { revision: 0, floor: 0, truncated: false, tags: [] };
  }

  resolve(entryId: string): ResolveResponse {
    return this.#tables
      ? resolveEntry(this.#sql, this.#scopeId, entryId)
      : { entryId, state: null, current: null, revision: 0 };
  }

  generation(generationId: string): PublicCacheGeneration | undefined {
    const result = this.readGeneration(generationId);
    return result.kind === 'found' ? result.generation : undefined;
  }

  artifact(artifactId: string): ArtifactLocation | undefined {
    return this.#tables ? locateArtifact(this.#sql, artifactId) : undefined;
  }

  readArtifactLocation(generationId: string, artifactId: string): ReadArtifactLocationResult {
    return this.#tables
      ? readArtifactLocation(this.#sql, this.#scopeId, generationId, artifactId)
      : NOT_RECORDED;
  }

  readHead(): ReadHeadResult {
    return this.#tables ? readHead(this.#sql, this.#history) : NOT_RECORDED;
  }

  readEntry(entryId: string, now: number): ReadEntryResult {
    return this.#tables ? readEntry(this.#sql, this.#scopeId, entryId, now) : NOT_RECORDED;
  }

  readGeneration(generationId: string): ReadGenerationResult {
    return this.#tables ? readGeneration(this.#sql, this.#scopeId, generationId) : NOT_RECORDED;
  }

  // ---- housekeeping -----------------------------------------------------------------------------

  /** What the alarm does, at the clock it is handed: sweep leases, settle, keep, come back. */
  async tick(now: number, options: TickOptions = {}): Promise<void> {
    if (!this.#tables) {
      return;
    }
    const scanDue = retentionDue(this.#sql, now, options.retention === true, RETENTION_INTERVAL_MS);
    const page = scanDue ? await this.#listDataUploads() : undefined;
    const deleteAll = await this.#mutations.run(async () => {
      this.ctx.storage.transactionSync(() => {
        expireLeases({
          sql: this.#sql,
          scopeId: this.#scopeId,
          limits: this.#limits,
          now,
          revision: readRevision(this.#sql) + 1,
          history: this.#history,
        });
      });
      const run = { ...this.#deps(), limits: this.#limits };
      const due = retentionDue(this.#sql, now, options.retention === true, RETENTION_INTERVAL_MS);
      return due && runRetention(run, now, page);
    });
    // Erasing waits for the whole run, and for one that left nothing owed: nothing of it may write
    // to storage after `deleteAll`, and what it could not deliver or write — whatever the host's
    // history owes — would go with the storage. A run that owes anything has armed its retry, and
    // the next retention looks again.
    const owed = await this.#settleOwes();
    if (deleteAll && !owed && (await this.#eraseStorage())) {
      // Under the lock, so that no change is planned against tables that go meanwhile; the tables
      // are given up first, so that no settle run begins against them, and those under way end.
      await this.#mutations.run(async () => {
        this.#tables = false;
        try {
          await Promise.allSettled([this.#settling]);
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.deleteAll();
        } catch (error) {
          this.#tables = true;
          throw error;
        }
      });
      return;
    }
    await this.#rearm(now);
  }

  override async alarm(): Promise<void> {
    try {
      await this.tick(Date.now());
    } catch (error) {
      this.#log.error('alarm failed', { detail: detailOf(error) });
      await this.#armAlarm(Date.now() + retryDelayMs(1));
    }
  }

  /** Test configurations only: make the next KV, storage or history call fail. */
  setTestFaults(faults: TestFaults): void {
    this.#requireTestHooks();
    this.#faults = faults;
  }

  /**
   * Test configurations only: shrink a ceiling to where a test can reach it. The defaults
   * (`DEFAULT_CACHE_VARS`) are whole numbers of gigabytes and tens of thousands of entries, which
   * no test could fill.
   */
  setTestLimits(limits: Partial<ScopeLimits>): void {
    this.#requireTestHooks();
    this.#testLimits = limits;
  }

  /** Test configurations only: how many settle runs are asked for and not yet begun. */
  testWaitingRuns(): number {
    this.#requireTestHooks();
    return this.#waiting;
  }

  /** Test configurations only: wait until every settle run asked for so far is over. */
  async testSettled(): Promise<void> {
    this.#requireTestHooks();
    await Promise.allSettled([this.#settling]);
  }

  /** Test configurations only: when the object has asked to be woken, if it has. */
  async testAlarm(): Promise<number | null> {
    this.#requireTestHooks();
    return this.ctx.storage.getAlarm();
  }
}
