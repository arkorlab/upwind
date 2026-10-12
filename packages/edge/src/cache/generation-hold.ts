import { type DecodedGenerationPack, kvGenerationKey } from '@stayingupwind/core/cache';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { regeneratedWhenServed } from './decision.ts';
import {
  type GenerationKey,
  type GenerationLoad,
  type LoadOptions,
  readGeneration,
} from './generation-loader.ts';

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
 * requests after it should find, a second later rather than five. One that asks for none — of
 * another status, which is handed on, or whose freshness cannot be told, or served to a `HEAD` —
 * keeps the whole hold.
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

/**
 * How long `pack` is held at `now` for the request `edge` serves: `STALE_HOLD_MS` while serving it
 * asks for its regeneration (`regeneratedWhenServed`) — never for a `HEAD`, which asks for none —
 * and the policy's hold otherwise.
 */
function holdOf(
  edge: EdgeContext,
  pack: DecodedGenerationPack,
  now: number,
  settings: RuntimeCacheSettings,
): number {
  return edge.headOnly !== true && regeneratedWhenServed(pack, now)
    ? Math.min(settings.holdMs, STALE_HOLD_MS)
    : settings.holdMs;
}

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
  if (settings.holdMs === 0) {
    return undefined;
  }
  const { memory } = edge.runtime;
  const now = edge.runtime.now();
  const recordKey = kvGenerationKey(key.scopeId, key.entryId);
  const held = memory.generations.get(recordKey);
  if (held !== undefined) {
    if (now - held.readAt >= holdOf(edge, held.pack, now, settings)) {
      memory.generations.set(recordKey, { ...held, readAt: now }, held.bytes);
      edge.ctx.waitUntil(refresh(edge, key, settings, options));
    }
    return { kind: 'generation', pack: held.pack, source: 'memory', lookupMs: 0 };
  }
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
  if (now - absentAt >= settings.holdMs) {
    memory.absentRecords.set(recordKey, now);
    edge.ctx.waitUntil(refresh(edge, key, settings, options));
  }
  return { kind: 'none', lookupMs: 0 };
}

/**
 * What the entry's next document would be served from, judged without moving it: the record this
 * isolate holds, however long ago it was read, or else one read now. Nothing is read behind it.
 *
 * A segment prefetch is answered from the build only while the page is the build's. A refresh it
 * set off behind itself could adopt a record rendered since, while the prefetch is still being
 * answered, and the navigation after it would then land on a document its parts did not describe.
 * Judged on what is held, the prefetch agrees with the next document, which is served from that
 * same record first and reads behind its own response.
 */
export async function generationAsHeld(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
): Promise<GenerationLoad> {
  if (settings.holdMs !== 0) {
    const held = edge.runtime.memory.generations.get(kvGenerationKey(key.scopeId, key.entryId));
    if (held !== undefined) {
      return { kind: 'generation', pack: held.pack, source: 'memory', lookupMs: 0 };
    }
  }
  return readGeneration(edge, key, settings);
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
