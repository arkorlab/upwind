import { releaseStream, withDeadline } from '@stayingupwind/core/util';

import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { CacheBody, type RecordBytes } from './cache-body.ts';

/**
 * A data center's copy of a delivery record, kept in the Cache API beside KV.
 *
 * KV is where the authority writes a record, and KV stays the answer. A copy is what an isolate in
 * this data center last read there, kept so that another isolate — one that does not hold the
 * record — can put it in front of the first byte without waiting for KV. KV keeps a record in a
 * data center for its `cacheTtl`, 30 s at the least; a page asked for less often than that went to
 * KV's upper tiers or its storage on every request, and the document waited for it.
 *
 * A copy is the record's bytes exactly as KV answered them, decoded and verified by the isolate
 * that kept it. It is trusted the way a copy of a shell is: decoded again — which checks that its
 * bodies are exactly as long as its header says — but not hashed again. What it cannot tell is
 * whether KV has moved on since, so it carries the moment it was kept and the revision it was kept
 * at: the first says whether it is still young enough to answer (`runtimeCache.cacheApiMaxAgeMs`),
 * and the second lets KV's answer be weighed against it without decoding it again.
 */

/**
 * Longest a read waits on the Cache API before the copy is taken for missing. KV has been asked
 * alongside the whole time, so this bounds only the wait of a request whose KV read failed.
 */
const COPY_READ_BUDGET_MS = 100;
/** A copy is kept again once it is this far into its age, so one that is asked for never lapses. */
const COPY_REFRESH_FRACTION = 2;
const KEPT_AT_HEADER = 'x-arkor-kept-at';
const REVISION_HEADER = 'x-arkor-revision';
const MS_PER_SECOND = 1000;

/** When a copy was kept, and the revision of the record it is a copy of. */
export interface CopyStamps {
  readonly keptAt: number;
  readonly revision: number;
}

/** A record as this data center keeps it: its bytes, when they were kept, and at which revision. */
export interface RecordCopy extends CopyStamps {
  readonly bytes: RecordBytes;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The URL a record's copy is kept under: its KV key, which names the scope and the entry, under the
 * host's key host (`EdgeNames.cacheKeyHost`). Only records enter the host's record cache
 * (`EdgeNames.recordCache`), so a `fetch()` filling `caches.default` never meets one.
 */
export function recordCopyUrl(cacheKeyHost: string, recordKey: string): string {
  try {
    return `https://${cacheKeyHost}/${encodeURIComponent(recordKey)}`;
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    // A separate path segment cannot collide with the existing single encoded component.
    return `https://${cacheKeyHost}/utf16/${encodeURIComponent(JSON.stringify(recordKey))}`;
  }
}

function copyRequest(edge: EdgeContext, recordKey: string): Request {
  return new Request(recordCopyUrl(edge.host.names.cacheKeyHost, recordKey));
}

/** A stamp the copy carries, when it carries one: `Number(null)` would read a missing one as 0. */
function stampOf(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const stamp = Number(value);
  return Number.isSafeInteger(stamp) ? stamp : undefined;
}

/** The copy the Cache API holds and its stamps, its body not read yet. One without both is none. */
async function matchStamped(
  edge: EdgeContext,
  recordKey: string,
): Promise<{ readonly hit: Response; readonly stamps: CopyStamps } | undefined> {
  const cache = await caches.open(edge.host.names.recordCache);
  const hit = await cache.match(copyRequest(edge, recordKey));
  if (hit === undefined) {
    return undefined;
  }
  const keptAt = stampOf(hit.headers.get(KEPT_AT_HEADER));
  const revision = stampOf(hit.headers.get(REVISION_HEADER));
  if (keptAt === undefined || revision === undefined) {
    releaseStream(hit.body, 'a record copy without its stamps');
    return undefined;
  }
  return { hit, stamps: { keptAt, revision } };
}

async function matchCopy(
  edge: EdgeContext,
  recordKey: string,
  reading: CacheBody,
): Promise<RecordCopy | undefined> {
  const stamped = await matchStamped(edge, recordKey);
  if (stamped === undefined) {
    return undefined;
  }
  const pending = reading.open(stamped.hit);
  return pending === undefined
    ? undefined
    : { ...stamped.stamps, bytes: reading.finish(await pending) };
}

async function matchStamps(edge: EdgeContext, recordKey: string): Promise<CopyStamps | undefined> {
  const stamped = await matchStamped(edge, recordKey);
  if (stamped === undefined) {
    return undefined;
  }
  releaseStream(stamped.hit.body, 'a record copy read for its stamps');
  return stamped.stamps;
}

/** Whether a copy is still young enough to answer, judged on this isolate's clock. */
function young(edge: EdgeContext, stamps: CopyStamps, maxAgeMs: number): boolean {
  return edge.runtime.now() - stamps.keptAt < maxAgeMs;
}

/**
 * This data center's copy of a record, when it has one young enough to answer. Never rejects: a
 * Cache API that fails, or is slower than its budget, has no copy, and KV answers as it would have.
 *
 * Its age is judged on this isolate's clock rather than left to the Cache API's own expiry, which
 * counts in whole seconds and may keep an entry a little past it; the copy says when it was kept.
 */
export async function readCopy(
  edge: EdgeContext,
  recordKey: string,
  maxAgeMs: number,
): Promise<RecordCopy | undefined> {
  const reading = new CacheBody();
  try {
    const copy = await withDeadline(
      matchCopy(edge, recordKey, reading),
      COPY_READ_BUDGET_MS,
      'record copy read',
    );
    return copy !== undefined && young(edge, copy, maxAgeMs) ? copy : undefined;
  } catch (error) {
    reading.stop();
    logWarn('record copy read failed', { key: recordKey, detail: errorDetail(error) });
    return undefined;
  }
}

/**
 * The stamps of the copy this data center holds now, without its bytes: what a write looks at
 * first, since the copy a request read may have been replaced since by another request's. A copy
 * too old to answer is none, as it is to a read. Never rejects: a Cache API that cannot say has no
 * copy, and the write goes ahead.
 */
async function copyStampsNow(
  edge: EdgeContext,
  recordKey: string,
  maxAgeMs: number,
): Promise<CopyStamps | undefined> {
  try {
    const stamps = await withDeadline(
      matchStamps(edge, recordKey),
      COPY_READ_BUDGET_MS,
      'record copy stamps read',
    );
    return stamps !== undefined && young(edge, stamps, maxAgeMs) ? stamps : undefined;
  } catch (error) {
    logWarn('record copy read failed', { key: recordKey, detail: errorDetail(error) });
    return undefined;
  }
}

/**
 * Keep a record's bytes as this data center's copy: bytes KV answered with, held to their digests,
 * or a copy's own, kept again. Only ever behind a response, and a failure is only logged: the copy
 * is an accelerator, and KV answers without it.
 */
async function keepCopy(
  edge: EdgeContext,
  recordKey: string,
  record: { readonly bytes: RecordBytes; readonly revision: number },
  maxAgeMs: number,
): Promise<CopyStamps | undefined> {
  try {
    const cache = await caches.open(edge.host.names.recordCache);
    const stamps = { keptAt: edge.runtime.now(), revision: record.revision };
    const kept = new Response(record.bytes, {
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': `max-age=${String(Math.ceil(maxAgeMs / MS_PER_SECOND))}`,
        [KEPT_AT_HEADER]: String(stamps.keptAt),
        [REVISION_HEADER]: String(stamps.revision),
      },
    });
    await cache.put(copyRequest(edge, recordKey), kept);
    return stamps;
  } catch (error) {
    logWarn('record copy write failed', { key: recordKey, detail: errorDetail(error) });
    return undefined;
  }
}

/**
 * Take this data center's copy away. Only this data center's: the Cache API deletes nowhere else,
 * and every other data center finds the same answer when its own read of KV comes back.
 */
async function dropCopy(edge: EdgeContext, recordKey: string): Promise<void> {
  try {
    const cache = await caches.open(edge.host.names.recordCache);
    await cache.delete(copyRequest(edge, recordKey));
  } catch (error) {
    logWarn('record copy delete failed', { key: recordKey, detail: errorDetail(error) });
  }
}

/**
 * Take this data center's copy away — KV holds no record to copy, or one the edge cannot read, or
 * the copy could not be served — if `condemned` holds of the copy it holds now. The copy is read
 * again for its stamps first: another request may have kept one since, later than whatever
 * condemned the copy this request saw. None young enough, or none that can be read, is left alone.
 */
export async function dropCopyIf(
  edge: EdgeContext,
  recordKey: string,
  maxAgeMs: number,
  condemned: (now: CopyStamps) => boolean,
): Promise<void> {
  const now = await copyStampsNow(edge, recordKey, maxAgeMs);
  if (now !== undefined && condemned(now)) {
    await dropCopy(edge, recordKey);
  }
}

/**
 * Whether a record at `revision` should be kept over a copy with these stamps: when there is none
 * young enough, when the one there is of an earlier record, and — for the same record — once the
 * copy is far enough into its age that a data center where the page is asked for keeps one without
 * a gap. Never over a copy of a later record: that is KV behind here, or a later request's answer
 * kept first, and the copy is the one that saw further.
 */
export function worthKeeping(
  edge: EdgeContext,
  copy: CopyStamps | undefined,
  revision: number,
  maxAgeMs: number,
): boolean {
  if (copy === undefined || copy.revision < revision) {
    return true;
  }
  const refreshAfterMs = maxAgeMs / COPY_REFRESH_FRACTION;
  return copy.revision === revision && edge.runtime.now() - copy.keptAt >= refreshAfterMs;
}

/**
 * Keep a record as this data center's copy when it is worth keeping over the copy the data center
 * holds now: the copy a request read may have been replaced since by another request's, with a
 * later record. The Cache API has no compare-and-set, so a copy kept between this look and the
 * write can still be written over; the next read of KV in the data center puts it right.
 *
 * `keeping.wanted` is asked again after each wait — the look, and the write — and a copy it no
 * longer wants once written is taken back, unless another has been kept in its place: what the
 * caller knows of the record can change while either is out (a record this isolate condemned
 * meanwhile, `condemned.ts`), and isolates that know nothing of it would answer with the copy for
 * its life.
 */
export async function keepCopyAhead(
  edge: EdgeContext,
  recordKey: string,
  record: { readonly bytes: RecordBytes; readonly revision: number },
  keeping: { readonly maxAgeMs: number; readonly wanted: () => boolean },
): Promise<void> {
  const { maxAgeMs, wanted } = keeping;
  const now = await copyStampsNow(edge, recordKey, maxAgeMs);
  if (!wanted() || !worthKeeping(edge, now, record.revision, maxAgeMs)) {
    return;
  }
  const kept = await keepCopy(edge, recordKey, record, maxAgeMs);
  if (kept !== undefined && !wanted()) {
    await dropCopyIfStill(edge, recordKey, maxAgeMs, kept);
  }
}

/**
 * Take away a copy a request could not serve, unless another has been kept in its place since: the
 * one there now goes only if it was kept at the same moment, at the same revision.
 */
export async function dropCopyIfStill(
  edge: EdgeContext,
  recordKey: string,
  maxAgeMs: number,
  copy: CopyStamps,
): Promise<void> {
  await dropCopyIf(
    edge,
    recordKey,
    maxAgeMs,
    (now) => now.keptAt === copy.keptAt && now.revision === copy.revision,
  );
}
