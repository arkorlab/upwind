import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  kvGenerationKey,
  MAX_TAGS_PER_CALL,
  r2BlobKey,
  tagIdFor,
  tagKindOf,
} from '@stayingupwind/core/cache';
import { fromBase64 } from '@stayingupwind/core/util';
import type {
  ArtifactUpload,
  AttemptOutcome,
  AttemptRequest,
  CacheHost,
  CommitOutcome,
  CommitRequest,
  DataRead,
  DataReadRequest,
  DataWriteRequest,
  DataWritten,
  FailRequest,
  InvalidateOutcome,
  InvalidateRequest,
  TagDelta,
  TagInvalidations,
  UploadedArtifact,
} from '@stayingupwind/runtime/cache-host';

import { limitsOf, parseVars } from '../env.ts';
import { createLogger } from '../logger.ts';
import { rememberArtifactFailure } from '../scope/artifacts.ts';
import {
  applyFail,
  applyHeartbeat,
  applyRecordArtifact,
  findAttempt,
  planStartAttempt,
} from '../scope/attempts.ts';
import { answerCommit, wantedRecords, withCurrentRecord } from '../scope/commit-record.ts';
import { type CommitOutcome as AuthorityCommitOutcome, planCommit } from '../scope/commit.ts';
import { adoptDataUpload, carriedValueOf } from '../scope/data-adopt.ts';
import { dataUploadKey } from '../scope/data-uploads.ts';
import type { DataSetInput, DataSetOutcome } from '../scope/data.ts';
import { NO_HISTORY } from '../scope/history.ts';
import { planInvalidate } from '../scope/invalidations.ts';
import { BlobLengthError } from '../scope/io.ts';
import { MutationPipeline, type MutationPlan, type OwnRun } from '../scope/mutation-pipeline.ts';
import { Alarm, initializeScope, ScopeQueue } from '../scope/mutations.ts';
import { locateArtifact, readCurrentData } from '../scope/reads.ts';
import { RepairRunner } from '../scope/repair-runner.ts';
import {
  chainSettle,
  finishSettle,
  type OwnRecords,
  type SettleDeps,
  type SettleOutcome,
  settlePending,
  type SettleRun,
} from '../scope/settle.ts';
import { isRefusal, readRevision, readScope, type Refusal, refuse } from '../scope/state.ts';
import { findTag, tagsDelta, toDeltaEntry } from '../scope/tags.ts';
import type { Timing } from '../scope/timing.ts';
import { authorityCommitRequest } from './contract.ts';
import { CacheFiles } from './files.ts';
import { maintainNativeCache } from './maintenance.ts';
import type { NativeCacheWorkerOptions } from './protocol.ts';
import { seedNativeCache } from './seed.ts';
import { sqlStorage, transaction } from './sql.ts';
import { unixMilliseconds } from './timestamp.ts';

const RETRY_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DELTA_PAGE_SIZE = 500;

const NOT_SEEDED = refuse('not_found', 'the native cache has not been seeded');
const REFUSED = { empty: NOT_SEEDED } as const;
const AT_ONCE = { ...REFUSED, atOnce: true } as const;

function accepted<T>(value: T | Refusal): T {
  if (isRefusal(value)) throw new Error(`native cache ${value.code}: ${value.message}`);
  return value;
}

/** The existing authority pipeline with local SQLite, local object files and a Node alarm. */
export class NativeAuthority implements CacheHost {
  static async open(options: NativeCacheWorkerOptions): Promise<NativeAuthority> {
    // The directory is configured by the process owner, never by an HTTP request.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(options.directory, { recursive: true });
    const database = new DatabaseSync(path.join(options.directory, 'cache.sqlite'), { timeout: 0 });
    try {
      // SQLite keeps this exclusive lock across commits and releases it on process death.
      database.exec(
        'PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; COMMIT',
      );
      const authority = new NativeAuthority(options, database);
      await authority.#files.init();
      await authority.#seed();
      await authority.#pipeline.rearm(Date.now());
      const due = await authority.#storage.getAlarm();
      if (due !== null) authority.#schedule(due);
      return authority;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  readonly #options: NativeCacheWorkerOptions;
  readonly #database: DatabaseSync;
  readonly #sql: SqlStorage;
  readonly #files: CacheFiles;
  readonly #queue = new ScopeQueue();
  readonly #limits = limitsOf(parseVars({}));
  readonly #log = createLogger({ component: 'native-cache' });
  readonly #storage: DurableObjectStorage;
  readonly #alarm: Alarm;
  readonly #repairs: RepairRunner;
  readonly #pipeline: MutationPipeline;
  #tables: boolean;
  #settling: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ticking: Promise<void> | undefined;
  #closed = false;
  #tickAgain = false;

  private constructor(options: NativeCacheWorkerOptions, database: DatabaseSync) {
    this.#options = options;
    this.#database = database;
    this.#sql = sqlStorage(database);
    this.#files = new CacheFiles(options.directory, database);
    database.exec(
      'CREATE TABLE IF NOT EXISTS native_alarm (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL)',
    );
    this.#tables = initializeScope(this.#sql, Date.now(), NO_HISTORY);
    this.#storage = {
      sql: this.#sql,
      transactionSync: <T>(body: () => T) => transaction(database, body),
      getAlarm: () => {
        const row = database.prepare('SELECT at FROM native_alarm WHERE id=1').get();
        return Promise.resolve(typeof row?.['at'] === 'number' ? row['at'] : null);
      },
      setAlarm: (at: number | Date) => {
        const moment = Number(at);
        database
          .prepare(
            'INSERT INTO native_alarm(id,at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at',
          )
          .run(moment);
        this.#schedule(moment);
        return Promise.resolve();
      },
      deleteAlarm: () => {
        database.exec('DELETE FROM native_alarm');
        clearTimeout(this.#timer);
        return Promise.resolve();
      },
    } as unknown as DurableObjectStorage;
    this.#alarm = new Alarm(this.#storage);
    this.#repairs = new RepairRunner({
      storage: this.#storage,
      queue: this.#queue,
      input: (now) => this.#pipeline.input(now),
      arm: (at) => this.#alarm.arm(at),
      defer: (at) => this.#alarm.postpone(at),
    });
    this.#pipeline = new MutationPipeline({
      storage: this.#storage,
      queue: this.#queue,
      repairs: this.#repairs,
      mutationHost: () => {
        return {
          storage: this.#storage,
          ...this.#identity(),
          kv: this.#files.kv as unknown as KVNamespace,
          limits: this.#limits,
          history: NO_HISTORY,
          tables: this.#tables,
          createdTables: () => {
            this.#tables = true;
          },
        };
      },
      tables: () => this.#tables,
      committed: (tables) => {
        this.#tables = tables;
      },
      testHooks: () => false,
      settling: () => this.#settling,
      settle: (own, timing) => this.#settle(own, timing),
      arm: (at) => this.#alarm.arm(at),
      armAnswered: (at) => this.#alarm.arm(at),
    });
  }

  #identity() {
    const scope = this.#tables ? readScope(this.#sql) : undefined;
    return {
      scopeId: this.#options.scopeId,
      buildId: this.#options.buildId,
      packSchemaVersion: scope?.pack_schema_version === 2 ? (2 as const) : (1 as const),
      repairNamespace:
        typeof scope?.repair_namespace === 'string' ? scope.repair_namespace : undefined,
    };
  }

  #deps(): SettleDeps {
    return {
      sql: this.#sql,
      ...this.#identity(),
      kv: this.#files.kv,
      blobs: this.#files.blobs,
      history: NO_HISTORY,
      log: this.#log,
      now: Date.now,
      transaction: (body) => this.#storage.transactionSync(body),
      sliceMs: this.#limits.projectionSliceMs,
      othersWaiting: () => false,
      continueSoon: () => this.#alarm.arm(Date.now() + 1),
    };
  }

  #mutate<T>(
    plan: MutationPlan<T | Refusal>,
    atOnce = false,
    own: OwnRun = {},
  ): Promise<T | Refusal> {
    return this.#pipeline.run<T | Refusal>(Date.now(), plan, atOnce ? AT_ONCE : REFUSED, own);
  }

  #settle(own?: OwnRecords | null, timing?: Timing): SettleRun {
    const run = chainSettle(this.#settling, this.#log, async (answered) => {
      const outcome = await settlePending({ ...this.#deps(), timing }, answered, own);
      await finishSettle(outcome, own?.controlTags, (result: SettleOutcome) => {
        return result.failed || result.pending
          ? this.#alarm.arm(Date.now() + RETRY_MS)
          : Promise.resolve();
      });
    });
    this.#settling = run.done;
    return run;
  }

  async #runTick(): Promise<void> {
    try {
      await this.#tick();
    } catch (error) {
      this.#log.error('maintenance failed', {
        detail: error instanceof Error ? error.message : String(error),
      });
      this.#schedule(Date.now() + RETRY_MS);
    } finally {
      this.#ticking = undefined;
      if (this.#tickAgain) {
        this.#tickAgain = false;
        this.#schedule(Date.now() + 1);
      }
    }
  }

  #schedule(at: number): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    const delay = Math.max(1, Math.min(at - Date.now(), MAX_TIMER_DELAY_MS));
    this.#timer = setTimeout(() => {
      if (this.#ticking !== undefined) {
        this.#tickAgain = true;
        return;
      }
      this.#ticking = this.#runTick();
    }, delay);
    this.#timer.unref();
  }

  #tick(): Promise<void> {
    return maintainNativeCache({
      ...this.#deps(),
      storage: this.#storage,
      queue: this.#queue,
      repairs: this.#repairs,
      pipeline: this.#pipeline,
      limits: this.#limits,
      settle: () => this.#settle().done,
      arm: (at) => this.#alarm.arm(at),
    });
  }

  #seed(): Promise<void> {
    return seedNativeCache(this.#options, this.#files, this.#pipeline, () => this.#settle().done);
  }

  async startAttempt(request: AttemptRequest): Promise<AttemptOutcome> {
    const answer = accepted(
      await this.#mutate(
        (tx) => {
          return planStartAttempt(tx, {
            ...request,
            producer: { kind: 'attempt', reason: request.reason },
          });
        },
        true,
        { leaseClock: true },
      ),
    );
    const current = accepted(await withCurrentRecord(answer, request.replaces, this.#deps()));
    const common = {
      current: current.current,
      attemptId: current.attemptId,
      leaseExpiresAt: current.leaseExpiresAt,
      ...(current.recordBytes !== undefined && { record: current.recordBytes }),
    };
    return current.kind === 'leased'
      ? { ...common, kind: 'leased', entryId: current.entryId, fencingToken: current.fencingToken }
      : { ...common, kind: 'busy' };
  }

  async uploadArtifact(upload: ArtifactUpload): Promise<UploadedArtifact> {
    if (upload.bytes.byteLength > this.#limits.maxArtifactBytes)
      throw new Error('native cache artifact exceeds its size limit');
    const sha256 = createHash('sha256').update(upload.bytes).digest('hex');
    const proposed = r2BlobKey(this.#options.scopeId, sha256);
    const recorded = accepted(
      await this.#mutate(
        (tx) => {
          return () => {
            return applyRecordArtifact(tx, upload.attemptId, {
              sha256,
              byteLength: upload.bytes.byteLength,
              contentType: upload.contentType,
              role: upload.role,
              encoding: 'identity',
              storageRef: proposed,
              fencingToken: upload.fencingToken,
            });
          };
        },
        true,
        { leaseClock: true },
      ),
    );
    await this.#files.blobs.write(
      recorded.storageRef ?? proposed,
      upload.bytes,
      upload.contentType,
    );
    return { sha256, byteLength: upload.bytes.byteLength };
  }

  async uploadArtifacts(uploads: readonly ArtifactUpload[]): Promise<readonly UploadedArtifact[]> {
    const written: UploadedArtifact[] = [];
    for (const upload of uploads) written.push(await this.uploadArtifact(upload));
    return written;
  }

  async heartbeat(attemptId: string, fencingToken: number): Promise<void> {
    accepted(
      await this.#mutate((tx) => () => applyHeartbeat(tx, attemptId, fencingToken), true, {
        leaseClock: true,
        repairHeartbeat: attemptId,
      }),
    );
  }

  async commit(attemptId: string, request: CommitRequest): Promise<CommitOutcome> {
    const entryOf = () => findAttempt(this.#sql, attemptId)?.entry_id;
    const wanted = wantedRecords(entryOf);
    const sent = authorityCommitRequest(request);
    const committed = this.#mutate<AuthorityCommitOutcome | Refusal>(
      (tx) => {
        return planCommit(
          Object.assign(tx, { prepareRepair: () => this.#pipeline.prepare() }),
          attemptId,
          sent,
          this.#files.blobs,
        );
      },
      false,
      { wanted, leaseClock: true },
    );
    const result = accepted(await answerCommit(committed, wanted, entryOf, this.#deps()));
    return result.kind === 'published'
      ? {
          kind: 'published',
          generationId: result.generationId,
          ...(result.recordBytes !== undefined && { record: result.recordBytes }),
        }
      : { kind: 'refused', reason: result.kind };
  }

  async fail(attemptId: string, request: FailRequest): Promise<void> {
    accepted(
      await this.#mutate((tx) => () => applyFail(tx, attemptId, request), true, {
        leaseClock: true,
      }),
    );
  }

  readRecord(entryId: string): Promise<Uint8Array | undefined> {
    return this.#files.read('kv', kvGenerationKey(this.#options.scopeId, entryId));
  }

  async readArtifact(artifactId: string): Promise<Uint8Array | undefined> {
    const location = locateArtifact(this.#sql, artifactId);
    if (location === undefined) return undefined;
    try {
      const bytes = await this.#files.blobs.read(location.storageRef, location.byteLength);
      if (
        bytes !== undefined &&
        createHash('sha256').update(bytes).digest('hex') === location.sha256
      )
        return bytes;
    } catch (error) {
      if (!(error instanceof BlobLengthError)) throw error;
    }
    await this.#pipeline.locked(false, () => rememberArtifactFailure(this.#sql, location));
    return undefined;
  }

  async getData(request: DataReadRequest): Promise<DataRead | undefined> {
    return await readCurrentData(this.#deps(), request);
  }

  async setData(request: DataWriteRequest): Promise<DataWritten> {
    const bytes = fromBase64(request.valueBase64);
    if (bytes.byteLength > this.#limits.maxArtifactBytes)
      throw new Error('native cache value exceeds its size limit');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storageRef = dataUploadKey(this.#options.scopeId, sha256, Date.now());
    await this.#files.blobs.write(storageRef, bytes, 'application/octet-stream');
    const input: DataSetInput = {
      key: request.key,
      entry: {
        ...request.entry,
        timestamp: unixMilliseconds(request.entry.timestamp),
        tags: [...request.entry.tags],
        dependencyCoverage: 'complete',
      },
      value: {
        sha256,
        byteLength: bytes.byteLength,
        contentType: 'application/octet-stream',
        storageRef,
      },
      order: request.order,
      bytes,
    };
    const result = accepted(
      await this.#mutate<DataSetOutcome | Refusal>(
        (tx) => {
          return adoptDataUpload(
            {
              sql: this.#sql,
              scopeId: this.#options.scopeId,
              now: Date.now,
              blobs: () => this.#files.blobs,
            },
            tx,
            input,
          );
        },
        false,
        { carried: carriedValueOf(input) },
      ),
    );
    if (result.retainedStorageRef !== storageRef) await this.#files.blobs.delete([storageRef]);
    return result;
  }

  async getTags(values: readonly string[]): Promise<TagInvalidations> {
    const tags: TagInvalidations['tags'][number][] = [];
    const unique = new Set(values);
    for (const value of unique) {
      const tag = findTag(
        this.#sql,
        await tagIdFor(this.#options.scopeId, tagKindOf(value), value),
      );
      if (tag?.stale_at !== null && tag?.stale_at !== undefined)
        tags.push(toDeltaEntry(tag, this.#sql));
    }
    return { tags };
  }

  tagsDelta(since: number): Promise<TagDelta> {
    const result = tagsDelta(this.#sql, {
      since,
      limit: DELTA_PAGE_SIZE,
      revision: readRevision(this.#sql),
    });
    return Promise.resolve({
      ...result,
      tags: result.tags.filter((tag) => tag.kind === tagKindOf(tag.value)),
    });
  }

  async invalidate(request: InvalidateRequest): Promise<InvalidateOutcome> {
    const tags = [...new Set(request.tags)];
    let revision = readRevision(this.#sql);
    const invalidations: InvalidateOutcome['invalidations'][number][] = [];
    for (let offset = 0; offset < tags.length; offset += MAX_TAGS_PER_CALL) {
      const result = accepted(
        await this.#mutate((tx) => {
          return planInvalidate(tx, {
            tags: tags.slice(offset, offset + MAX_TAGS_PER_CALL).map((value) => ({ value })),
            cause: { source: 'app-worker', api: request.api },
            ...(request.expire !== undefined && { expire: request.expire }),
            ...(request.inForceAt !== undefined && { inForceAt: request.inForceAt }),
          });
        }),
      );
      revision = result.revision;
      invalidations.push(...result.invalidations);
    }
    return { revision, invalidations };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#ticking;
    for (;;) {
      const settling = this.#settling;
      await settling;
      if (settling === this.#settling) break;
    }
    await this.#queue.run(() => {
      // All accepted mutations have left the writer queue.
    });
    this.#database.close();
  }
}
