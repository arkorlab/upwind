import { r2CachePrefix } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';

import { detailOf, type Logger } from '../logger.ts';
import type { BlobStore } from './io.ts';
import { queueDeletions } from './retention.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';

/** An upload must be adopted within an hour; after that, only an existing reference keeps it. */
const UPLOAD_LIFETIME_MS = 3_600_000;
const SCAN_BATCH = 200;
const META_SCAN_CURSOR = 'data_upload_scan_cursor';
const META_SCAN_PHASE = 'data_upload_scan_phase';
const META_SWEEP_CLOCK = 'data_upload_sweep_clock';
type ScanPhase = 'data' | 'blobs';

export function dataUploadKey(scopeId: string, sha256: string, now: number): string {
  return `${r2CachePrefix(scopeId)}data/${now}/${createId('upload')}/${sha256}`;
}

/** Keys of another shape — a canonical blob's among them — carry no upload clock. */
export function dataUploadStartedAt(scopeId: string, storageRef: string): number | undefined {
  const prefix = `${r2CachePrefix(scopeId)}data/`;
  if (!storageRef.startsWith(prefix)) return undefined;
  const first = storageRef.slice(prefix.length).split('/', 1)[0] ?? '';
  return /^\d{13}$/u.test(first) ? Number(first) : undefined;
}

export function dataUploadExpired(sql: SqlStorage, startedAt: number, now: number): boolean {
  // The gateway's request clock can predate a sweep when its RPC arrives late.
  const authorityNow = Math.max(now, Number(readMeta(sql, META_SWEEP_CLOCK) ?? '0'));
  return startedAt + UPLOAD_LIFETIME_MS <= authorityNow;
}

export function dataUploadScanPending(sql: SqlStorage): boolean {
  return readMeta(sql, META_SCAN_CURSOR) !== undefined || scanPhase(sql) === 'blobs';
}

function scanPhase(sql: SqlStorage): ScanPhase {
  return readMeta(sql, META_SCAN_PHASE) === 'blobs' ? 'blobs' : 'data';
}

interface ListInput {
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly blobs: BlobStore;
}

export interface DataUploadPage {
  readonly objects: readonly { readonly key: string; readonly uploadedAt: number }[];
  readonly phase: ScanPhase;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

/** R2 listing runs outside the mutation mutex, so a slow scan never holds up an app write. */
export async function listDataUploads(input: ListInput): Promise<DataUploadPage> {
  const phase = scanPhase(input.sql);
  const before = readMeta(input.sql, META_SCAN_CURSOR);
  const page = await input.blobs.listPage({
    prefix: `${r2CachePrefix(input.scopeId)}${phase}/`,
    cursor: before,
    limit: SCAN_BATCH,
  });
  return { objects: page.objects, phase, before, after: page.cursor };
}

/** A failed sweep leaves the ordinary retention run and its retry policy unchanged. */
export async function tryListDataUploads(
  input: ListInput & { readonly log: Logger },
): Promise<DataUploadPage | undefined> {
  try {
    return await listDataUploads(input);
  } catch (error) {
    input.log.warn('data uploads not swept', { detail: detailOf(error) });
    return undefined;
  }
}

function advanceScan(sql: SqlStorage, page: DataUploadPage): void {
  // A concurrent tick may already have advanced. Replaying a complete older cycle only
  // rescans; it cannot skip a prefix or page in the current cycle.
  if (scanPhase(sql) !== page.phase || readMeta(sql, META_SCAN_CURSOR) !== page.before) return;
  if (page.after !== undefined) {
    writeMeta(sql, META_SCAN_CURSOR, page.after);
    return;
  }
  deleteMeta(sql, META_SCAN_CURSOR);
  if (page.phase === 'data') writeMeta(sql, META_SCAN_PHASE, 'blobs');
  else deleteMeta(sql, META_SCAN_PHASE);
}

/** In the retention transaction under the mutation mutex: check references as they are now. */
export function queueDataUploads(input: {
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly now: number;
  readonly page: DataUploadPage;
}): void {
  const { sql, scopeId, now, page } = input;
  const expired = page.objects.filter((object) => {
    const startedAt = dataUploadStartedAt(scopeId, object.key) ?? object.uploadedAt;
    return startedAt + UPLOAD_LIFETIME_MS <= now;
  });
  const keys = expired.map((object) => object.key);
  const rows = sql.exec<{ storage_ref: string }>(
    `SELECT storage_ref FROM artifacts
     WHERE refs > 0 AND storage_ref IN (SELECT value FROM json_each(?))
     UNION
     SELECT aa.storage_ref FROM attempt_artifacts aa
     JOIN attempts a ON a.attempt_id = aa.attempt_id
     WHERE a.status <> 'committed' AND aa.storage_ref IN (SELECT value FROM json_each(?))`,
    JSON.stringify(keys),
    JSON.stringify(keys),
  );
  const referenced = new Set<string>();
  for (const row of rows) {
    referenced.add(row.storage_ref);
  }
  queueDeletions(
    sql,
    keys.filter((key) => !referenced.has(key)),
    now,
  );
  const sweptAt = Math.max(now, Number(readMeta(sql, META_SWEEP_CLOCK) ?? '0'));
  writeMeta(sql, META_SWEEP_CLOCK, String(sweptAt));
  advanceScan(sql, page);
}
