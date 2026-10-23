import type { ScopeLimits } from '../env.ts';
import type { ArtifactRepair } from './artifact-repair.ts';
import type { OwnRecords } from './settle.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';
import type { TxInput } from './tx.ts';

/** One active repair owns the write-side continuation; normal reads never consult this row. */
const ACTIVE_JOB = 'artifact_repair_job';
const DATA_PREFIX = 'artifact_repair_data:';
const RESULT_PREFIX = 'artifact_repair_result:';
const GARBAGE_PREFIX = 'artifact_repair_gc:';
const GARBAGE_ROWS_AT_ONCE = 32;
const RESULT_KEEP_MS = 86_400_000;
const TIME_KEY_WIDTH = 16;
export const REPAIR_PIN_PREFIX = 'artifact_repair_pin:';
/** Even four UTF-8 bytes per code unit keep an individual metadata value below SQLite's limit. */
const CHUNK_CODE_UNITS = 65_536;
const LAST_SINGLE_CODE_UNIT = 0xff_ff;
const JOB_VERSION = 1;
const OWNER_CHANGED = 'the repair owner changed';
// JSON.stringify can return undefined for runtime values despite its standard-library overload.
const repairJson: (value: unknown) => string | undefined = JSON.stringify;

export type RepairPhase = 'preflight' | 'apply' | 'publish';

export interface RepairJob {
  readonly version: typeof JOB_VERSION;
  readonly id: string;
  readonly operation: 'commit' | 'seed' | 'data';
  readonly preparedAt: number;
  readonly fromRevision: number;
  readonly limits: ScopeLimits;
  readonly failures?: number;
  readonly retryAt?: number;
  /** Publication remains private until every physical group has finished. */
  readonly finalizing?: {
    readonly phase: 'records' | 'events' | 'pins';
    readonly after: string;
    readonly index: number;
  };
  readonly attemptId: string | null;
  readonly phase: RepairPhase;
  readonly group: number;
  readonly groupCount: number;
  /** The last visited primary-key entry, including nonmatching and unpublished entries. */
  readonly after: string;
}

/** One admitted generation's relocation plan, kept separately from all other generations. */
export interface RepairGroup {
  readonly entryId: string;
  readonly repairs: readonly ArtifactRepair[];
  /** Exact failure observations; completing an older repair cannot clear a later ABA marker. */
  readonly failureMarkers: readonly [string, string][];
}

export interface RepairCompletion<T> {
  readonly value: T;
  readonly own: OwnRecords | null;
}

export type RepairStep<T> =
  | { readonly kind: 'pending' }
  | { readonly kind: 'completed'; readonly value: T };

/** Ephemeral, rare-path preparation: arm an alarm before this closure persists any job. */
export interface RepairStart<T = never> {
  readonly kind: 'repair-start';
  readonly prepare?: (() => Promise<void>) | undefined;
  /** SQL-only initial publication probe; the caller rolls it back before start. */
  readonly preflight?: ((input: TxInput) => void) | undefined;
  readonly start: (input: TxInput) => T | RepairPending;
}

/** Discovery after asynchronous planning must first roll back its entire candidate transaction. */
export class RepairPreparationRequiredError<T = unknown> extends Error {
  override name = 'RepairPreparationRequiredError';
  readonly preparation: RepairStart<T>;

  constructor(preparation: RepairStart<T>, options?: ErrorOptions) {
    super('the repair needs a prepared continuation', options);
    this.preparation = preparation;
  }
}

export function isRepairPreparationRequired<T>(
  value: unknown,
): value is RepairPreparationRequiredError<T> {
  return value instanceof RepairPreparationRequiredError;
}

export function isRepairStart<T>(value: unknown): value is RepairStart<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'repair-start' &&
    'start' in value &&
    typeof value.start === 'function'
  );
}

export interface RepairPending {
  readonly kind: 'repair-pending';
  readonly jobId: string;
}

export function isRepairPending(value: unknown): value is RepairPending {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'repair-pending' &&
    'jobId' in value &&
    typeof value.jobId === 'string'
  );
}

export function readRepairJob(sql: SqlStorage): RepairJob | undefined {
  const text = readMeta(sql, ACTIVE_JOB);
  if (text === undefined) return undefined;
  const job = JSON.parse(text) as Omit<RepairJob, 'version'> & { readonly version: unknown };
  if (
    job.version !== JOB_VERSION ||
    typeof job.id !== 'string' ||
    !['commit', 'data', 'seed'].includes(job.operation) ||
    !['apply', 'preflight', 'publish'].includes(job.phase) ||
    !Number.isSafeInteger(job.group) ||
    !Number.isSafeInteger(job.groupCount) ||
    job.group < 0 ||
    job.groupCount <= 0 ||
    job.group > job.groupCount ||
    typeof job.after !== 'string'
  )
    throw new Error('the durable repair continuation is invalid');
  return job as RepairJob;
}

export function repairDataKey(jobId: string, name: string): string {
  return `${DATA_PREFIX}${jobId}:${name}`;
}

function keyOf(jobId: string, name: string): string {
  return `${DATA_PREFIX}${jobId}:${name}:`;
}

/**
 * Requests already admitted by the existing protocol gain no new metadata-size admission limit.
 * A large original seed batch or commit is split across existing meta rows. Surrogate pairs are
 * not split: SQLite stores UTF-8, so persisting a lone half would change the reconstructed JSON.
 */
export function writeRepairValue(
  sql: SqlStorage,
  jobId: string,
  name: string,
  value: unknown,
): void {
  const json = repairJson(value);
  if (json === undefined) throw new Error('a durable repair value is missing');
  const prefix = keyOf(jobId, name);
  let count = 0;
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + CHUNK_CODE_UNITS, json.length);
    // A character beginning just before the cut must remain with its low surrogate.
    if ((json.codePointAt(end - 1) ?? 0) > LAST_SINGLE_CODE_UNIT) end -= 1;
    writeMeta(sql, `${prefix}${count}`, json.slice(start, end));
    start = end;
    count += 1;
  }
  writeMeta(sql, `${prefix}count`, String(count));
}

export function hasRepairValue(sql: SqlStorage, jobId: string, name: string): boolean {
  return readMeta(sql, `${keyOf(jobId, name)}count`) !== undefined;
}

/** Only a bounded group, or the original operation at its final publication, is reconstructed. */
export function readRepairValue<T>(
  sql: SqlStorage,
  jobId: string,
  name: string,
  decode: (value: unknown) => T = (value) => value as T,
): T {
  const prefix = keyOf(jobId, name);
  const count = Number(readMeta(sql, `${prefix}count`));
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('the durable repair payload is missing');
  }
  const chunks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = readMeta(sql, `${prefix}${index}`);
    if (chunk === undefined) throw new Error('the durable repair payload is incomplete');
    chunks.push(chunk);
  }
  return decode(JSON.parse(chunks.join('')));
}

/** Called in the same protected SQLite transaction as the private accepted publication. */
export function beginRepairJob(
  sql: SqlStorage,
  input: {
    readonly operation: RepairJob['operation'];
    readonly preparedAt: number;
    readonly fromRevision: number;
    readonly limits: ScopeLimits;
    readonly attemptId: string | null;
    readonly publication: unknown;
    readonly groups: readonly RepairGroup[];
    readonly groupCount?: number;
  },
): RepairPending {
  if (readRepairJob(sql) !== undefined) throw new Error('another repair already owns the scope');
  const groupCount = input.groupCount ?? input.groups.length;
  if (groupCount <= 0) throw new Error('a repair job needs a relocation');
  const id = crypto.randomUUID();
  writeRepairValue(sql, id, 'publication', input.publication);
  for (const [index, group] of input.groups.entries()) {
    writeRepairValue(sql, id, `group-${index}`, group);
  }
  const job: RepairJob = {
    version: JOB_VERSION,
    id,
    operation: input.operation,
    preparedAt: input.preparedAt,
    fromRevision: input.fromRevision,
    limits: input.limits,
    attemptId: input.attemptId,
    phase: 'preflight',
    group: 0,
    groupCount,
    after: '',
  };
  for (const group of input.groups) pinRepairGroup(sql, id, group);
  writeMeta(sql, ACTIVE_JOB, JSON.stringify(job));
  return { kind: 'repair-pending', jobId: id };
}

/** Pins protect the accepted failure observation from an older in-flight projection. */
export function pinRepairGroup(sql: SqlStorage, jobId: string, group: RepairGroup): void {
  for (const repair of group.repairs) {
    const key = REPAIR_PIN_PREFIX + repair.sha256;
    const existing = readMeta(sql, key);
    if (existing !== undefined && existing !== jobId)
      throw new Error('another repair pins this artifact');
    writeMeta(sql, key, jobId);
  }
}

/** All SQL snapshots and the publishing generation are complete before these fences are released. */
export function releaseRepairGroup(
  sql: SqlStorage,
  jobId: string,
  group: RepairGroup,
  repaired = false,
): void {
  for (const repair of group.repairs) {
    sql.exec(
      `DELETE FROM meta WHERE key = ? AND value = ?`,
      REPAIR_PIN_PREFIX + repair.sha256,
      jobId,
    );
  }
  if (!repaired) return;
  for (const [sha256, marker] of group.failureMarkers) {
    sql.exec(`DELETE FROM meta WHERE key = ? AND value = ?`, `artifact_failure:${sha256}`, marker);
  }
}

/** Cursor movement and its snapshot update must be committed by one transactionSync body. */
export function advanceRepairJob(sql: SqlStorage, job: RepairJob): void {
  if (readRepairJob(sql)?.id !== job.id) throw new Error(OWNER_CHANGED);
  writeMeta(sql, ACTIVE_JOB, JSON.stringify({ ...job, failures: 0, retryAt: undefined }));
}

/** A caught transient failure retains its cursor and its pins, with a durable retry time. */
export function retryRepairJob(sql: SqlStorage, job: RepairJob, retryAt: number): void {
  if (readRepairJob(sql)?.id !== job.id) throw new Error(OWNER_CHANGED);
  writeMeta(
    sql,
    ACTIVE_JOB,
    JSON.stringify({ ...job, failures: (job.failures ?? 0) + 1, retryAt }),
  );
}

/** The public result becomes available only after every live SQL snapshot has been retargeted. */
export function completeRepairJob(
  sql: SqlStorage,
  job: RepairJob,
  result: RepairCompletion<unknown>,
  now: number,
): void {
  if (readRepairJob(sql)?.id !== job.id) throw new Error(OWNER_CHANGED);
  writeRepairValue(sql, job.id, 'result', result);
  writeMeta(sql, `${RESULT_PREFIX}${job.id}`, 'complete');
  deleteMeta(sql, ACTIVE_JOB);
  writeMeta(
    sql,
    garbageKey(now, job.id),
    JSON.stringify({
      id: job.id,
      phase: 'payload',
      after: `${DATA_PREFIX}${job.id}:`,
      completedAt: now,
    }),
  );
}

export function repairJobResult<T>(
  sql: SqlStorage,
  jobId: string,
): RepairCompletion<T> | undefined {
  return readMeta(sql, `${RESULT_PREFIX}${jobId}`) === 'complete'
    ? readRepairValue<RepairCompletion<T>>(sql, jobId, 'result')
    : undefined;
}

interface RepairGarbage {
  readonly id: string;
  readonly phase: 'payload' | 'result';
  readonly after: string;
  readonly completedAt: number;
}

function garbageKey(at: number, id: string): string {
  return `${GARBAGE_PREFIX}${String(Math.max(0, Math.trunc(at))).padStart(TIME_KEY_WIDTH, '0')}:${id}`;
}

/** The time is part of the indexed key, so selecting due work never scans future jobs. */
export function nextRepairGarbageAt(sql: SqlStorage): number | undefined {
  const row = sql
    .exec<{ key: string }>(
      `SELECT key FROM meta WHERE key >= ? AND key < ? ORDER BY key LIMIT 1`,
      GARBAGE_PREFIX,
      `${GARBAGE_PREFIX}\u{FFFF}`,
    )
    .toArray()[0];
  return row === undefined
    ? undefined
    : Number(row.key.slice(GARBAGE_PREFIX.length).split(':', 1)[0]);
}

/** At most one bounded primary-key page, even for an unusually large admitted seed batch. */
export function collectRepairGarbage(sql: SqlStorage, now: number): boolean {
  const saved = sql
    .exec<{ key: string; value: string }>(
      `SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key LIMIT 1`,
      GARBAGE_PREFIX,
      garbageKey(now, '\u{FFFF}'),
    )
    .toArray()[0];
  if (saved === undefined) return false;
  const work = JSON.parse(saved.value) as RepairGarbage;
  const prefix = `${DATA_PREFIX}${work.id}:`;
  const page = sql
    .exec<{ key: string }>(
      `SELECT key FROM meta WHERE key > ? AND key < ? ORDER BY key LIMIT ?`,
      work.after,
      `${prefix}\u{FFFF}`,
      GARBAGE_ROWS_AT_ONCE,
    )
    .toArray();
  for (const row of page) {
    if (work.phase === 'result' || !row.key.startsWith(keyOf(work.id, 'result'))) {
      deleteMeta(sql, row.key);
    }
  }
  if (page.length === GARBAGE_ROWS_AT_ONCE) {
    writeMeta(sql, saved.key, JSON.stringify({ ...work, after: page.at(-1)?.key ?? work.after }));
    return true;
  }
  deleteMeta(sql, saved.key);
  if (work.phase === 'payload') {
    writeMeta(
      sql,
      garbageKey(work.completedAt + RESULT_KEEP_MS, work.id),
      JSON.stringify({
        ...work,
        phase: 'result',
        after: prefix,
      }),
    );
  } else {
    deleteMeta(sql, `${RESULT_PREFIX}${work.id}`);
  }
  return (nextRepairGarbageAt(sql) ?? Infinity) <= now;
}
