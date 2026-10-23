import type * as Contract from '@stayingupwind/host/cache';
import { DurableObject } from 'cloudflare:workers';

import type { CacheBindings } from '../bindings.ts';
import { limitsOf, parseVars, type ScopeLimits, type Vars } from '../env.ts';
import { createLogger, detailOf, type Logger } from '../logger.ts';
import { rememberArtifactFailure } from './artifacts.ts';
import {
  applyFail,
  applyHeartbeat,
  applyRecordArtifact,
  findAttempt,
  planStartAttempt,
  type UploadedArtifact,
} from './attempts.ts';
import * as recordAnswers from './commit-record.ts';
import { type CommitOutcome, planCommit } from './commit.ts';
import { adoptDataUpload, carriedValueOf } from './data-adopt.ts';
import type { DataSetInput, DataSetOutcome } from './data.ts';
import * as history from './history.ts';
import { type InvalidateResult, planInvalidate } from './invalidations.ts';
import { type BlobStore, blobStore, checkFault, kvSink, type TestFaults } from './io.ts';
import {
  MutationPipeline,
  LEASE_SWEEP_GRACE_MS,
  RETENTION_INTERVAL_MS,
  type OwnRun,
} from './mutation-pipeline.ts';
import { Alarm, ScopeQueue } from './mutations.ts';
import {
  type ArtifactLocation,
  locateArtifact,
  readArtifactLocation,
  readCurrentData,
  readEntry,
  readGeneration,
  readHead,
  resolveEntry,
} from './reads.ts';
import { isRepairPending, type RepairPending, type RepairStart } from './repair-jobs.ts';
import { RepairRunner } from './repair-runner.ts';
import {
  claimResourceWarmJobs,
  finishResourceWarmJob,
  planApplyResourceChange,
} from './resource-changes.ts';
import type { TickOptions } from './retention-run.ts';
import { ScopeContext } from './scope-context.ts';
import { tickScope } from './scope-tick.ts';
import { seedRepairCopier } from './seed-repair-copy.ts';
import type { SeedRepairVerification } from './seed-repair.ts';
import * as seed from './seed.ts';
import { countSettleFailures, retryDelayMs, settleRetryMs } from './settle-retry.ts';
import {
  chainSettle,
  finishSettle,
  type OwnRecords,
  requireScopeMarker,
  type SettleDeps,
  type SettleOutcome,
  settlePending,
  type SettleRun,
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
import { Timing } from './timing.ts';
import type { Apply, TxInput } from './tx.ts';

/**
 * One deployment's cache authority: the only writer of its entries, generations, tags,
 * invalidations and leases, addressed with `idFromName(scopeId)`, and created where its host would
 * prefer it (`AuthorityHost.locationHint`: a hint, which the runtime need not follow).
 *
 * Every mutation is one synchronous SQLite transaction at one scope revision, planned under a
 * mutex so the ids derived ahead of it are derived for the revision it commits at. What the commit
 * owes to KV, and whatever the host's history owes for it (`history.ScopeHistory.publish`), is settled
 * afterwards — awaited by the caller as far as the delivery and tag records, which are what is
 * served and judged, so those are written before a change is answered, while what the history owes
 * follows the answer, and a change that owes no such record is answered as it commits — and by the
 * alarm when that fails, or when a rewrite is larger than one run's slice.
 *
 * It holds no tables until it is seeded, and none once retention has erased it. Reached for a scope
 * it holds no tables of, it answers as for one never seeded, and writes nothing: a straggler's call
 * to a scope retention erased leaves no object behind.
 */

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
  /** The history a host keeps of each scope, made as each object is (`history.ScopeHistory`): none here. */
  static readonly historyOf: history.HistoryFactory = () => history.NO_HISTORY;
  readonly #mutations = new ScopeQueue();
  readonly #alarm = new Alarm(this.ctx.storage);
  readonly #repairs = new RepairRunner({
    storage: this.ctx.storage,
    queue: this.#mutations,
    arm: (at) => this.#armAlarm(at),
    defer: (at) => this.#alarm.postpone(at),
    input: (now) => this.#pipeline.input(now),
  });
  #settling: Promise<void> = Promise.resolve();
  /** Settle runs asked for and not begun: a run's slice gives way to them (`othersWaiting`). */
  #waiting = 0;
  #faults: TestFaults = {};
  #testLimits: Partial<ScopeLimits> = {};
  #logger: Logger | undefined;
  readonly #scope: ScopeContext;
  readonly #pipeline: MutationPipeline;
  readonly #history: history.ScopeHistory;

  constructor(ctx: DurableObjectState, env: CacheBindings) {
    super(ctx, env);
    this.#history = new.target.historyOf(env, () => this.#faults);
    this.#scope = new ScopeContext(ctx, this.#history);
    this.#pipeline = new MutationPipeline({
      storage: this.ctx.storage,
      queue: this.#mutations,
      repairs: this.#repairs,
      mutationHost: () => {
        return {
          storage: this.ctx.storage,
          ...this.#scope.identity,
          kv: this.env.CACHE_STATE,
          limits: this.#limits,
          history: this.#history,
          tables: this.#scope.tables,
          createdTables: () => {
            this.#scope.tables = true;
          },
        };
      },
      tables: () => this.#scope.tables,
      committed: (tables) => {
        this.#scope.committed(tables);
      },
      testHooks: () => this.#vars.ARKOR_TEST_HOOKS,
      settling: () => this.#settling,
      settle: (own, timing) => this.#settle(own, undefined, timing),
      arm: (at) => this.#armAlarm(at),
      armAnswered: (at, atOnce) => (atOnce ? this.#armOrLog(at) : this.#armAlarm(at)),
    });
  }

  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  get #vars(): Vars {
    return parseVars(this.env);
  }

  get #limits(): ScopeLimits {
    return { ...limitsOf(this.#vars), ...this.#testLimits };
  }

  get #log(): Logger {
    this.#logger ??= createLogger({ scopeId: this.#scope.scopeId });
    return this.#logger;
  }

  #deps(): SettleDeps {
    const faults = (): TestFaults => this.#faults;
    return {
      sql: this.#sql,
      ...this.#scope.identity,
      kv: kvSink(this.env.CACHE_STATE, faults),
      blobs: this.#blobs(),
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
   * A change that committed waits for its run to attempt its delivery and tag records; a public
   * projection KV refuses is retried after the answer (`#settle`). Its run waits for the preceding
   * runs as well, an invalidation's rewrite say. An operation that never leaves such a record —
   * a lease, a heartbeat, an upload's record, a failed attempt's
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
  #mutate<T>(
    now: number,
    plan: (
      input: TxInput,
    ) =>
      | Apply<T | RepairPending | RepairStart<T>>
      | Promise<Apply<T | RepairPending | RepairStart<T>>>,
    answers: { readonly atOnce?: boolean } & ({ readonly empty: T } | { readonly seed: T }),
    own: OwnRun = {},
  ): Promise<T> {
    return this.#pipeline.run(now, plan, answers, own);
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
   * that cannot arm its retry fails the caller's wait; an owned private mark must also be written.
   * `from` is what a change left behind as it committed (`ownRecordsOf`), whose records its run
   * writes, or `null` when it committed nothing; the alarm's runs leave it out and write the backlog.
   * `timing` is where a change that
   * says how long its parts took has its run timed, whether it committed anything or not.
   */
  #settle(
    from?: OwnRecords | null,
    ended?: (outcome: SettleOutcome) => void,
    timing?: Timing,
  ): SettleRun {
    this.#waiting += 1;
    const run = chainSettle(this.#settling, this.#log, async (answered) => {
      this.#waiting -= 1;
      timing?.lap('settle-wait');
      // Awaited on its own: as the argument of `ended?.(…)`, the run would not happen at all for a
      // caller with no `ended`.
      const outcome = await this.#runSettle(answered, from, timing);
      ended?.(outcome);
    });
    this.#settling = run.done;
    return run;
  }

  async #runSettle(
    answered: () => void,
    from: OwnRecords | null | undefined,
    timing: Timing | undefined,
  ): Promise<SettleOutcome> {
    if (!this.#scope.tables) {
      // Erased while the run waited its turn: nothing of the scope is left to settle.
      return { pending: false, failed: false, continued: false };
    }
    let outcome: SettleOutcome;
    try {
      outcome = await settlePending({ ...this.#deps(), timing }, answered, from);
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

  #blobs(): BlobStore {
    return blobStore(this.env.ARTIFACTS, () => this.#faults, {
      repairOwner: this.ctx.id.toString(),
    });
  }

  /**
   * `body` under the lock, in one transaction of its own: a change that leaves no record and asks
   * for no run. Answered with `empty` where the object holds no tables, and nothing is written.
   */
  #locked<T>(empty: T, body: () => T): Promise<T> {
    return this.#pipeline.locked(empty, body);
  }

  #requireTestHooks(): void {
    if (!this.#vars.ARKOR_TEST_HOOKS) throw new Error('test hooks are off');
  }

  // ---- what a deploy calls ---------------------------------------------------------------------

  async seedScope(input: Contract.SeedScopeInput, now: number): Promise<Contract.SeedScopeResult> {
    const outcome = await this.#mutate(now, (tx) => () => seed.applySeedScope(tx, input), SEED);
    if (this.#scope.tables && readScope(this.#sql)?.status === 'active') {
      // An upload may never reach setData at all. Seeding must arm its eventual orphan sweep.
      await this.#armAlarm(now + RETENTION_INTERVAL_MS);
    }
    return outcome;
  }

  /**
   * Arm the alarm again (`#rearm`), as a host that checks on its scopes from time to time asks, so
   * that a scope whose sweep is not armed is swept again. Asked to, it has the host's history stop
   * as well, for good (`history.ScopeHistory.stop`), as that history reads `epoch`; what came of it is the
   * answer.
   */
  async ensureRetention(
    now: number,
    stop = false,
    epoch?: number,
  ): Promise<history.HistoryFields | null> {
    return this.#pipeline.unblocked(async () => {
      const stopped = stop ? this.#history.stop(this.ctx.storage, now, epoch) : null;
      await this.#pipeline.rearm(now);
      return stopped;
    });
  }

  async seedEntries(
    input: Contract.SeedEntriesInput,
    now: number,
  ): Promise<Contract.SeedEntriesResult | Refusal> {
    let result: Contract.SeedEntriesResult | Refusal | SeedRepairVerification | RepairPending =
      await this.#mutate(
        now,
        (tx) => seed.planSeedEntries(tx, input, undefined, () => this.#pipeline.prepare()),
        REFUSED,
      );
    if (seed.needsSeedVerification(result)) {
      result = await seed.finishSeedRepair(result, {
        bucket: this.env.ARTIFACTS,
        retry: (seen) => {
          return this.#mutate(
            now,
            (tx) => seed.planSeedEntries(tx, input, seen, () => this.#pipeline.prepare()),
            REFUSED,
          );
        },
        faults: () => this.#faults,
        copyRepair: seedRepairCopier(this.env.ARTIFACTS, {
          namespace: this.#scope.repairNamespace,
          scopeOwner: this.ctx.id.toString(),
        }),
      });
    }
    if (isRepairPending(result)) throw new Error('a private seed continuation escaped the writer');
    seed.logSeedRefusals(this.#log, result);
    return result;
  }

  async retire(reason: string, now: number): Promise<seed.RetireOutcome> {
    const outcome = await this.#mutate(now, (tx) => () => seed.applyRetire(tx, reason), UNKNOWN);
    if (outcome.kind === 'retired') {
      // A scope that only ever held a build's seed has never armed an alarm: without one here,
      // nothing would come back to prune its bodies or, in the end, delete it.
      await this.#armAlarm(now);
    }
    // Answered once its marker is out, the run before the answer having written it or failed to.
    if (outcome.kind !== 'unknown' && this.#scope.tables) requireScopeMarker(this.#sql);
    return outcome;
  }

  applyResourceChange(
    input: Contract.ApplyResourceChangeInput,
    now: number,
  ): Promise<Contract.ApplyResourceChangeResult | Refusal> {
    return this.#mutate(now, (tx) => planApplyResourceChange(tx, input), REFUSED);
  }

  async listResourceWarmJobs(
    input: Contract.ListResourceWarmJobsInput,
    now: number,
  ): Promise<Contract.ListResourceWarmJobsResult> {
    const none: Contract.ListResourceWarmJobsResult = { jobs: [], nextRetryAt: null };
    return this.#locked(none, () => claimResourceWarmJobs(this.#sql, input, now));
  }

  async finishResourceWarmJob(
    input: Contract.FinishResourceWarmJobInput,
    now: number,
  ): Promise<Contract.FinishResourceWarmJobResult> {
    const none: Contract.FinishResourceWarmJobResult = { kind: 'unknown', nextRetryAt: null };
    return this.#locked(none, () => finishResourceWarmJob(this.#sql, input, now));
  }

  // ---- regeneration ----------------------------------------------------------------------------

  /** Take an entry's lease, answered with the record of a later generation (`withCurrentRecord`). */
  async startAttempt(
    request: Contract.StartAttemptRequest,
    now: number,
  ): ReturnType<typeof recordAnswers.withCurrentRecord> {
    const result = await this.#mutate(now, (tx) => planStartAttempt(tx, request), AT_ONCE, {
      leaseClock: true,
    });
    if (result.kind === 'leased') {
      await this.#armOrLog(result.leaseExpiresAt + LEASE_SWEEP_GRACE_MS);
    }
    return recordAnswers.withCurrentRecord(result, request.replaces, this.#deps());
  }

  heartbeat(
    attemptId: string,
    fencingToken: number,
    now: number,
  ): Promise<Refusal | { readonly leaseExpiresAt: number }> {
    return this.#mutate(now, (tx) => () => applyHeartbeat(tx, attemptId, fencingToken), AT_ONCE, {
      leaseClock: true,
      repairHeartbeat: attemptId,
    });
  }

  recordArtifact(
    attemptId: string,
    upload: UploadedArtifact & { readonly fencingToken: number },
    now: number,
  ): Promise<ReturnType<typeof applyRecordArtifact>> {
    return this.#mutate(now, (tx) => () => applyRecordArtifact(tx, attemptId, upload), AT_ONCE, {
      leaseClock: true,
    });
  }

  /** Publish an attempt's generation, answered with the record its run wrote (`answerCommit`). */
  commit(
    attemptId: string,
    request: Contract.CommitRequest,
    now: number,
  ): Promise<CommitOutcome | Refusal> {
    // A retired scope's commit is refused before its planning asks storage anything.
    const plan = async (tx: TxInput): Promise<Apply<CommitOutcome | Refusal | RepairPending>> => {
      const scope = requireActiveScope(tx.sql);
      return isRefusal(scope)
        ? () => scope
        : planCommit(
            Object.assign(tx, { prepareRepair: () => this.#pipeline.prepare() }),
            attemptId,
            request,
            this.#blobs(),
          );
    };
    const entryOf = (): string | undefined => findAttempt(this.#sql, attemptId)?.entry_id;
    const wanted = recordAnswers.wantedRecords(entryOf);
    const committed = this.#mutate<CommitOutcome | Refusal>(now, plan, REFUSED, {
      wanted,
      leaseClock: true,
    });
    return recordAnswers.answerCommit(committed, wanted, entryOf, this.#deps());
  }

  fail(
    attemptId: string,
    request: Contract.FailRequest,
    now: number,
  ): Promise<Contract.FailResponse | Refusal> {
    return this.#mutate(now, (tx) => () => applyFail(tx, attemptId, request), AT_ONCE, {
      leaseClock: true,
    });
  }

  // ---- data cache and invalidation ------------------------------------------------------------

  async setData(input: DataSetInput, now: number): Promise<DataSetOutcome | Refusal> {
    const timing = new Timing();
    const deps = { sql: this.#sql, scopeId: this.#scope.scopeId, blobs: () => this.#blobs() };
    const authorityNow = () => (this.#vars.ARKOR_TEST_HOOKS ? now : Date.now());
    const adopt = (tx: TxInput) => adoptDataUpload({ ...deps, now: authorityNow }, tx, input);
    const carried = carriedValueOf(input);
    const outcome = await this.#mutate<DataSetOutcome | Refusal>(now, adopt, REFUSED, {
      timing,
      carried,
    });
    const needsCleanup =
      !isRefusal(outcome) ||
      (outcome.code === 'quota_exceeded' && (readScope(this.#sql)?.body_bytes ?? 0) > 0);
    if (needsCleanup) {
      // A dynamic app may only write data entries and never lease a route regeneration. It
      // still accumulates former generations. Keep an earlier lease or retry alarm, and
      // schedule cleanup even when an already-full scope cannot accept this write.
      await this.#armAlarm(now + RETENTION_INTERVAL_MS);
    }
    timing.lap('cleanup');
    return isRefusal(outcome) ? outcome : { ...outcome, timing: timing.parts };
  }

  /** Only the private control entrypoint selects absent-tag fanout; the gateway uses the default. */
  invalidate(
    request: Contract.InvalidateRequest,
    now: number,
    mode?: 'control',
  ): Promise<InvalidateResult> {
    return this.#mutate(now, (tx) => planInvalidate(tx, request, mode), REFUSED);
  }

  // ---- reads ------------------------------------------------------------------------------------

  // An object that holds no tables answers each as for a scope never seeded.

  tagsDelta(since: number, limit: number, from?: number): Contract.TagsDeltaResponse {
    return this.#scope.tables
      ? tagsDelta(this.#sql, { since, limit, from, revision: readRevision(this.#sql) })
      : { revision: 0, floor: 0, truncated: false, tags: [] };
  }

  resolve(entryId: string): Contract.ResolveResponse {
    return this.#scope.tables
      ? resolveEntry(this.#sql, this.#scope.scopeId, entryId)
      : { entryId, state: null, current: null, revision: 0 };
  }

  generation(generationId: string): Contract.PublicCacheGeneration | undefined {
    const result = this.readGeneration(generationId);
    return result.kind === 'found' ? result.generation : undefined;
  }

  artifact(artifactId: string): ArtifactLocation | undefined {
    return this.#scope.tables ? locateArtifact(this.#sql, artifactId) : undefined;
  }

  /**
   * Remember that storage does not hold the bytes the scope names at an artifact's location — none,
   * another length, or other bytes by the digest it keeps — as a read found (`artifactBytes`,
   * Codex): the next upload of the bytes is then a repair, as it is after a projection that could
   * not read them. Only where the location is still the artifact's (`rememberArtifactFailure`): one
   * moved since the read was answered is left as it is, and the answer is whether the failure was
   * remembered.
   */
  async rememberCorruptArtifact(location: ArtifactLocation): Promise<boolean> {
    return this.#locked(false, () => rememberArtifactFailure(this.#sql, location));
  }

  readArtifactLocation(
    generationId: string,
    artifactId: string,
  ): Contract.ReadArtifactLocationResult {
    return this.#scope.tables
      ? readArtifactLocation(this.#sql, this.#scope.scopeId, generationId, artifactId)
      : NOT_RECORDED;
  }

  readHead(): Contract.ReadHeadResult {
    return this.#scope.tables ? readHead(this.#sql, this.#history) : NOT_RECORDED;
  }

  /** The data-cache value the key holds now, read from the scope rather than from KV. */
  currentData(request: Contract.CurrentDataRequest): ReturnType<typeof readCurrentData> {
    return this.#scope.tables ? readCurrentData(this.#deps(), request) : Promise.resolve(undefined);
  }

  /** A newer route record from the authority's current state, without leasing or writing it. */
  async currentRecord(entry: string, after: number): Promise<ArrayBuffer | undefined> {
    return this.#scope.tables
      ? recordAnswers.readCurrentRecord(this.#deps(), entry, after)
      : undefined;
  }

  readEntry(entryId: string, now: number): Contract.ReadEntryResult {
    const { tables, scopeId } = this.#scope;
    return tables ? readEntry(this.#sql, scopeId, entryId, now) : NOT_RECORDED;
  }

  readGeneration(generationId: string): Contract.ReadGenerationResult {
    const { tables, scopeId } = this.#scope;
    return tables ? readGeneration(this.#sql, scopeId, generationId) : NOT_RECORDED;
  }

  // ---- housekeeping -----------------------------------------------------------------------------

  /** What the alarm does, at the clock it is handed: sweep leases, settle, keep, come back. */
  tick(now: number, options: TickOptions = {}): Promise<void> {
    return tickScope(
      {
        scope: this.#scope,
        storage: this.ctx.storage,
        queue: this.#mutations,
        repairs: this.#repairs,
        deps: () => this.#deps(),
        limits: () => this.#limits,
        blobs: () => this.#blobs(),
        log: this.#log,
        arm: (at) => this.#armAlarm(at),
        rearm: (at) => this.#pipeline.rearm(at),
        settleOwes: () => this.#settleOwes(),
        settling: () => this.#settling,
      },
      now,
      options,
    );
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
