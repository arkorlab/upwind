import { type DecodedGenerationPack, kvGenerationKey } from '@stayingupwind/core/cache';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { transferInvalidations } from './condemned.ts';
import { readCurrentBehind } from './generation-current.ts';
import { readGeneration } from './generation-loader.ts';
import { lookAtScopeBehind } from './scope-signal.ts';

/**
 * What an isolate holds of an entry's delivery record, and how it serves it: the front of every
 * read of a record.
 *
 * Within the hold (`runtimeCache.holdMs`) the record this isolate read answers as it is — or, for a
 * read asked to hold absences, KV's answer that there is none. Past it, it answers all the same,
 * however long ago it was read, as a pointer is (`PointerReader.get`): it is held again, so that
 * the requests arriving meanwhile do not each ask, and the entry is read behind the response by the
 * same read a request that holds nothing makes before its first byte (`readGeneration`) — the copy
 * and KV together, KV's answer weighed against the copy, no record put in place of a later one.
 * What that read brings answers the requests after it; a read that fails leaves the record held,
 * and asks again a hold later. The first byte is not held for KV. Only an isolate that holds
 * nothing of the entry reads before it: its first request for the page, or one after its memory
 * made room for others.
 *
 * What it costs is a request: a change — a regeneration, an invalidation, a record KV no longer
 * has — reaches an isolate one request later than it did, the one that found the hold over, and
 * any that arrive while its read is out. Not a record's freshness: what a record says of that is
 * judged when it is served (`decideGeneration`), so one that expired while it was held is
 * regenerated in the foreground, as it always was.
 *
 * A record whose serving asks for its regeneration — a 200 past its `revalidate`, regenerated
 * behind the response, or past its `expire`, regenerated in the foreground — is held for
 * `STALE_HOLD_MS` rather than the whole hold: the record that regeneration publishes is what the
 * requests after it should find, a second later rather than five. That is judged where a document
 * is served from the record (`readServedAgain`), not where the record is read: a document's record
 * is read ahead of the middleware, and a class shell's beside a member's own, so a request the
 * middleware answers itself or that goes to the Worker whole, or a member whose own record answers,
 * reads a record it neither serves nor asks to have regenerated. A record no request serves keeps
 * the whole hold however stale it is, and so does one whose serving asks for none — of another
 * status, which is handed on, or whose freshness cannot be told, or served to a `HEAD`.
 *
 * A hold of zero holds nothing, and every request reads the record before its first byte: a
 * setting for measuring the read, not for serving.
 */

/**
 * How long a record whose serving asks for its regeneration is held at most: one second, or the
 * policy's hold where that is shorter. The read behind the response moves sooner; the first byte
 * waits for nothing more.
 */
const STALE_HOLD_MS = 1000;

export interface GenerationKey {
  readonly scopeId: string;
  readonly entryId: string;
}

/** A record this isolate holds, when its hold began, and what it weighs in memory. */
export interface HeldGeneration {
  readonly pack: DecodedGenerationPack;
  /**
   * When this isolate read it, or held it again: a request that finds the hold over serves it and
   * holds it again while the entry is read behind the response (`generation-hold.ts`).
   */
  readonly readAt: number;
  readonly bytes: number;
  /** Set only after authority bytes pass identity, digest, revision and invalidation fences. */
  readonly authorityConfirmedAt?: number | undefined;
}

export interface LoadOptions {
  /**
   * Hold a record's absence for the hold as well as its presence. For an entry that may have no
   * record at all — a member's own, beside the class shell's — asking KV on every request would
   * find it absent on every request; held, the absence is asked about once per hold, as a record
   * is.
   */
  readonly holdAbsence?: boolean | undefined;
}

/** The entry, and the KV key its record is kept under. */
interface RecordName {
  readonly key: GenerationKey;
  readonly recordKey: string;
}

/** A read in flight, and what it is for. */
export interface Read extends RecordName {
  readonly options: LoadOptions;
  /** The loader supplies policy context for bounded negative-KV recovery. */
  readonly settings?: RuntimeCacheSettings;
  readonly startedAt: number;
  /** The data center's copies are read and kept beside KV. */
  readonly copies: boolean;
  /**
   * The revision of the record in this isolate's memory when the read began: the one a request
   * served past its hold, for the read behind that response (`generation-hold.ts`); the last one
   * read, under a hold of zero; none, for a read that found nothing held.
   */
  readonly heldRevision: number | undefined;
  /**
   * The record this isolate held when the read began. Each read that puts one in place decodes it
   * anew, so a record held since under another pack is one another read put there, however close
   * in time the two reads were; a hold renewed meanwhile keeps its pack, and is no read
   * (`forgetSeen`).
   */
  readonly heldAtStart: HeldGeneration | undefined;
  /** The record this read put in place itself, if it put one: the data center's copy, say. */
  readonly adopted: { held: HeldGeneration | undefined };
}

type GenerationSource = 'memory' | 'cache-api' | 'kv';

export type GenerationLoad =
  | {
      readonly kind: 'generation';
      readonly pack: DecodedGenerationPack;
      readonly source: GenerationSource;
      /**
       * The record's size as KV returned it, for a load that read it there: what serving it is
       * reported to the host's observer as (`EdgeObserver.recordServed`), which a host may meter.
       * None for one this isolate held, nor for one this data center's copy answered with.
       */
      readonly readBytes?: number | undefined;
      /**
       * The load waited on KV's answer, whatever its bytes are: a record this isolate held, served
       * because KV answered with an earlier one, comes from memory, but only once KV had answered.
       * A record KV's own answer brought says so by its `source`.
       */
      readonly afterKv?: boolean | undefined;
      readonly lookupMs: number;
    }
  /** KV holds no record: the entry was never seeded, or the scope is gone. */
  | { readonly kind: 'none'; readonly lookupMs: number }
  /** A record that cannot be read as one; it is never taken for a generation. */
  | {
      readonly kind: 'unusable';
      readonly reason: 'corrupt' | 'unsupported';
      readonly lookupMs: number;
    }
  /**
   * KV threw, and this data center had no copy to answer with. The record this isolate last read,
   * if any, is offered for what it is worth.
   */
  | {
      readonly kind: 'unavailable';
      readonly detail: string;
      readonly held: DecodedGenerationPack | undefined;
      readonly lookupMs: number;
    };

/**
 * Read the entry behind the response, for the requests after this one. Never rejects: a read that
 * fails leaves what this isolate holds as it is, held again, so the next try is a hold later.
 */
async function refresh(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
  options: LoadOptions,
): Promise<void> {
  try {
    await readGeneration(edge, key, settings, options);
  } catch (error) {
    logWarn('delivery record refresh failed', {
      key: kvGenerationKey(key.scopeId, key.entryId),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * When this isolate found KV without the entry's record, for a read asked to hold absences:
 * `undefined` where none is held, or where the one held no longer stands, which is let go.
 */
function heldAbsence(
  edge: EdgeContext,
  key: GenerationKey,
  recordKey: string,
  options: LoadOptions,
): number | undefined {
  const { memory } = edge.runtime;
  // An absence is held as a record is, however long ago it was found — `peek` answers past the
  // memory's own TTL, which is not the hold — and asked about again past the hold the same way.
  const absentAt =
    options.holdAbsence === true ? memory.absentRecords.peek(recordKey)?.value : undefined;
  if (absentAt === undefined) {
    return undefined;
  }
  // Nor one found before the scope's latest at-once invalidation, or while KV may still have
  // answered with what it held before it (`absencesHeldFrom`): the record it said KV had none of may
  // be there now, and be one the invalidation reached. Absences carry no tags, so every one of the
  // scope goes, and the entry is read as one held nothing of.
  const heldFrom = memory.invalidations.absencesHeldFrom(key.scopeId);
  if (heldFrom !== undefined && absentAt < heldFrom) {
    memory.absentRecords.delete(recordKey);
    return undefined;
  }
  return absentAt;
}

/**
 * What this isolate holds of the entry, answering without a read before the first byte: the
 * record, or — asked to hold absences — that KV had none. Past the hold it is held again before
 * the entry is read behind the response, so one read goes out per hold however many requests
 * arrive while it is out. `undefined` for an entry this isolate holds nothing of, whose record is
 * read before the first byte.
 */
export function heldGeneration(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
  options: LoadOptions = {},
): GenerationLoad | undefined {
  lookAtScopeBehind(edge, key.scopeId);
  transferInvalidations(edge.runtime.memory, edge.app?.deploymentId, key.scopeId);
  if (settings.holdMs === 0) {
    return undefined;
  }
  const { memory } = edge.runtime;
  const now = edge.runtime.now();
  const recordKey = kvGenerationKey(key.scopeId, key.entryId);
  const held = memory.generations.get(recordKey);
  if (held !== undefined) {
    if (now - held.readAt >= settings.holdMs) {
      memory.generations.set(recordKey, { ...held, readAt: now }, held.bytes);
      edge.ctx.waitUntil(refresh(edge, key, settings, options));
    }
    return { kind: 'generation', pack: held.pack, source: 'memory', lookupMs: 0 };
  }
  const absentAt = heldAbsence(edge, key, recordKey, options);
  if (absentAt === undefined) {
    return undefined;
  }
  if (now - absentAt >= settings.holdMs) {
    memory.absentRecords.set(recordKey, now);
    edge.ctx.waitUntil(refresh(edge, key, settings, options));
  }
  return { kind: 'none', lookupMs: 0 };
}

/**
 * A document is served from `pack` asking for its regeneration: once this isolate has held it
 * `STALE_HOLD_MS`, it is held again, and its entry — the one its header names — read behind the
 * response, as one past the whole hold is (`heldGeneration`), with the `options` it was read with.
 * Asked once the request is known to serve the record — a document certain to go out from it
 * (`onServed`), or the foreground regeneration that replaces it (`cache/document.ts`) — and not by
 * what reads it. Nothing where this isolate no longer holds that record — one a read put in place
 * since, or none — nor under a hold of zero, which holds nothing.
 */
export function readServedAgain(
  edge: EdgeContext,
  pack: DecodedGenerationPack,
  settings: RuntimeCacheSettings,
  options: LoadOptions & { readonly servedStale?: boolean } = {},
): void {
  if (settings.holdMs === 0) {
    return;
  }
  const { memory } = edge.runtime;
  const key = { scopeId: pack.header.scopeId, entryId: pack.header.entryId };
  const recordKey = kvGenerationKey(key.scopeId, key.entryId);
  const held = memory.generations.get(recordKey);
  const now = edge.runtime.now();
  if (held?.pack === pack) {
    const cadenceMs = Math.min(settings.holdMs, STALE_HOLD_MS);
    if (options.servedStale === true) readCurrentBehind(edge, pack, settings, cadenceMs);
    if (now - held.readAt >= cadenceMs) {
      memory.generations.set(recordKey, { ...held, readAt: now }, held.bytes);
      edge.ctx.waitUntil(refresh(edge, key, settings, options));
    }
  }
}

/**
 * What the entry's next document would be served from, judged without moving it: the record this
 * isolate holds, however long ago it was read, or else one read now. Nothing is read behind it.
 *
 * A segment prefetch is answered from the build only while the page is the build's. A refresh it
 * set off behind itself could adopt a record rendered since, while the prefetch is still being
 * answered, and the navigation after it would then land on a document its parts did not describe.
 * Judged on what is held, the prefetch agrees with the next document, which is served from that
 * same record first and reads behind its own response. A part answered from a record that asks
 * for its regeneration is read again only once it is answered, as that document is
 * (`readServedAgain`).
 *
 * Asked to hold absences — a member's own record — an absence held answers within the hold, as it
 * answers the member's next document, which is the class shell's then. Past the hold the entry is
 * read now, its absence held again if KV still has none: an absence has no freshness of its own to
 * be judged by later, as a record does, and one judged as held for good would hand the member's
 * parts to the Function in an isolate asked for none of its documents however long ago its record
 * was made. It is held again before the read goes out, as `heldGeneration` holds it, so that the
 * parts arriving while the read is out answer as held rather than each reading the entry: one read
 * per hold. No read is shared between requests, which each wait on their own.
 */
export async function generationAsHeld(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
  options: LoadOptions = {},
): Promise<GenerationLoad> {
  lookAtScopeBehind(edge, key.scopeId);
  if (settings.holdMs !== 0) {
    const recordKey = kvGenerationKey(key.scopeId, key.entryId);
    const held = edge.runtime.memory.generations.get(recordKey);
    if (held !== undefined) {
      return { kind: 'generation', pack: held.pack, source: 'memory', lookupMs: 0 };
    }
    const absentAt = heldAbsence(edge, key, recordKey, options);
    if (absentAt !== undefined) {
      const now = edge.runtime.now();
      if (now - absentAt < settings.holdMs) {
        return { kind: 'none', lookupMs: 0 };
      }
      edge.runtime.memory.absentRecords.set(recordKey, now);
    }
  }
  return readGeneration(edge, key, settings, options);
}

/** The entry's record: what this isolate holds of it, or else a read before the first byte. */
export async function loadGeneration(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
  options: LoadOptions = {},
): Promise<GenerationLoad> {
  const startedAt = edge.runtime.now();
  const held = heldGeneration(edge, key, settings, options);
  if (held !== undefined) {
    return { ...held, lookupMs: edge.runtime.now() - startedAt };
  }
  return readGeneration(edge, key, settings, options);
}
