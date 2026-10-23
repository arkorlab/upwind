import {
  type DecodedGenerationPack,
  decodeGenerationPack,
  kvGenerationKey,
} from '@stayingupwind/core/cache';
import { TtlCache, withDeadline } from '@stayingupwind/core/util';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import type { EdgeMemory } from '../memory/caches.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { claimBackgroundRecord } from './background-record-budget.ts';
import { isInvalidated } from './condemned.ts';
import { adoptDecoded, copyMaxAgeMs, heldLater, sameGeneration } from './generation-adoption.ts';
import { keepCopyAhead } from './generation-copy.ts';
import type { GenerationKey, Read } from './generation-hold.ts';

const MAX_RECENT_READS = 1024;
const CURRENT_RECORD_READ_MS = 1000;
const MAX_RECORD_MIB = 4;
const KIB = 1024;
const MAX_RECORD_BYTES = MAX_RECORD_MIB * KIB * KIB;
/**
 * When the edge reads for what a regeneration it asked for publishes (`followRegeneration`), from
 * where the Function begins that regeneration: once the resume it rides has ended (`afterBody` in
 * the runtime), or as it answers a detached ask. Its lease, its tags brought up, its render, upload
 * and commit take about 1.3 s for a light page, so the first read comes a little before that, for a
 * lighter page's publish to be found by it; then one every 300 ms, so that a publish is held within
 * that and the read's own round trip — sooner than a visitor reloading the page every half second
 * comes back. None begins past 4 s from where the regeneration began, three times the usual
 * publish — counted from there, not from the ask, which a long resume puts seconds before it: a
 * regeneration that has published nothing by then — one dynamic here, one that failed, one behind a
 * lease held elsewhere — is left to the reads behind the stale requests after it
 * (`readCurrentBehind`).
 */
const FOLLOW_FIRST_MS = 800;
const FOLLOW_EVERY_MS = 300;
const FOLLOW_FOR_MS = 4000;
/** The most reads one follow-up makes: the first, and one every 300 ms after it within 4 s. */
const FOLLOW_READS = 1 + Math.floor((FOLLOW_FOR_MS - FOLLOW_FIRST_MS) / FOLLOW_EVERY_MS);
/**
 * How long a follow-up is kept as under way from its start: past the last moment a read of it may
 * begin, by the deadline that read has.
 */
const FOLLOW_KEPT_MS = FOLLOW_FOR_MS + CURRENT_RECORD_READ_MS;

interface CurrentReads {
  readonly recent: TtlCache<string, number>;
  /** The regeneration followed for each entry, while it is (`followRegeneration`). */
  readonly following: TtlCache<string, Followed>;
}

/**
 * A request gets a runtime of its own, but shares its isolate memory. Keep its cadence with that
 * memory; pending reads share the background-record budget. Fresh delivery has no bookkeeping here.
 */
const reads = new WeakMap<EdgeMemory, CurrentReads>();

type RecordVersion = Pick<DecodedGenerationPack['header'], 'scopeId' | 'entryId' | 'revision'>;

interface CurrentRead {
  readonly target: RecordVersion;
  /**
   * The revision the authority is asked for a record later than: the target's, or one a follow-up's
   * earlier read was answered with (`follow`).
   */
  readonly after: number;
  readonly settings: RuntimeCacheSettings;
  active: boolean;
}

/**
 * What a read leaves the follow-up it is one of (`follow`): `true` where there is nothing more to
 * read for, or the revision its next read asks after (`readCurrent`).
 */
type ReadAnswer = true | number;

/** A regeneration followed: the record it replaces, and when the last read for it may begin. */
interface Followed {
  readonly target: RecordVersion;
  readonly recordKey: string;
  readonly settings: RuntimeCacheSettings;
  readonly until: number;
}

/** A confirmation cannot renew grace for different content at an already-held revision. */
function conflictingHeld(
  edge: EdgeContext,
  recordKey: string,
  pack: DecodedGenerationPack,
): boolean {
  const held = edge.runtime.memory.generations.get(recordKey)?.pack;
  return held?.header.revision === pack.header.revision && !sameGeneration(held, pack);
}

/**
 * The loader's identity, digest, invalidation and revision checks also govern authority bytes. The
 * revision they decode to, held or not; none where they do not decode.
 */
async function adoptCurrentRecord(
  edge: EdgeContext,
  current: CurrentRead,
  bytes: ArrayBuffer,
): Promise<number | undefined> {
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (decoded.kind !== 'ok') return undefined;
  const { revision } = decoded.pack.header;
  if (revision <= current.target.revision) return revision;
  const { scopeId, entryId } = current.target;
  const key = { scopeId, entryId };
  const recordKey = kvGenerationKey(scopeId, entryId);
  const heldAtStart = edge.runtime.memory.generations.get(recordKey);
  const maxAgeMs = copyMaxAgeMs(edge, current.settings);
  const read: Read = {
    key,
    recordKey,
    options: {},
    settings: current.settings,
    startedAt: edge.runtime.now(),
    copies: maxAgeMs > 0,
    heldRevision: heldAtStart?.pack.header.revision,
    heldAtStart,
    adopted: { held: undefined },
  };
  const adopted = await adoptDecoded(edge, read, decoded, {
    origin: { kind: 'authority' },
    byteLength: bytes.byteLength,
    wanted: () => current.active && !conflictingHeld(edge, recordKey, decoded.pack),
  });
  if (adopted.kind === 'adopted' && maxAgeMs > 0) {
    const wanted = (): boolean => {
      return (
        current.active &&
        heldLater(edge, recordKey, revision) === undefined &&
        !isInvalidated(edge.runtime.memory, decoded.pack, edge.app?.deploymentId)
      );
    };
    await keepCopyAhead(edge, recordKey, { bytes, revision }, { maxAgeMs, wanted });
  }
  return revision;
}

/**
 * What a read leaves its follow-up (`follow`). It is over where the isolate holds a record later
 * than the one read for once the read is done — the one the authority answered with, adopted, or
 * one held already, however it came — and where no further read could bring the isolate to hold
 * one. A record past `MAX_RECORD_BYTES` is never held from the authority, and nor, for a page whose
 * records come that large, is the one its regeneration publishes. Bytes that do not decode name no
 * revision to ask after, so a further read would be sent them again; and a pack of a version this
 * edge does not read is what the regeneration publishes too. A later record it decoded and will
 * not hold — refused by the loader's checks, or condemned by an invalidation it knows of — ends
 * nothing: it is no more than what the authority held as the read reached it, and what the
 * regeneration publishes may still come after it. The next read asks after its revision, so the
 * authority sends nothing more until there is something later.
 */
async function readCurrent(
  edge: EdgeContext,
  current: CurrentRead,
  release: () => void,
  latestStart?: number,
): Promise<ReadAnswer> {
  try {
    // Let the synchronous delivery callback return before starting any new authority I/O.
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    // A queued continuation must not begin a new authority read after the follow-up expires.
    if (latestStart !== undefined && edge.runtime.now() > latestStart) return current.after;
    const { target, after } = current;
    const bytes = await edge.host.currentRecord?.(target.scopeId, target.entryId, after);
    // Nothing later, or an answer past the read's deadline, which goes unused (`boundedRead`).
    if (bytes === undefined || !current.active) return after;
    if (bytes.byteLength > MAX_RECORD_BYTES) return true;
    const revision = await adoptCurrentRecord(edge, current, bytes);
    const recordKey = kvGenerationKey(target.scopeId, target.entryId);
    return revision === undefined || heldLater(edge, recordKey, target.revision) !== undefined
      ? true
      : Math.max(after, revision);
  } finally {
    release();
  }
}

/**
 * The read within its deadline: what it answered, or, where it failed or ran out, the revision it
 * asked after, which a follow-up's next read asks after again.
 */
async function boundedRead(
  operation: Promise<ReadAnswer>,
  current: CurrentRead,
  recordKey: string,
): Promise<ReadAnswer> {
  try {
    return await withDeadline(operation, CURRENT_RECORD_READ_MS, 'current delivery record read');
  } catch (error) {
    logWarn('current delivery record refresh failed', {
      key: recordKey,
      detail: error instanceof Error ? error.message : String(error),
    });
    return current.after;
  } finally {
    current.active = false;
  }
}

function readsOf(edge: EdgeContext, cadenceMs: number): CurrentReads {
  let state = reads.get(edge.runtime.memory);
  if (state === undefined) {
    state = {
      recent: new TtlCache(cadenceMs, MAX_RECENT_READS, edge.runtime.now),
      following: new TtlCache(FOLLOW_KEPT_MS, MAX_RECENT_READS, edge.runtime.now),
    };
    reads.set(edge.runtime.memory, state);
  }
  return state;
}

/** How often an entry's record is read behind stale requests: each second, or each shorter hold. */
function cadenceOf(settings: RuntimeCacheSettings): number {
  return Math.min(settings.holdMs, CURRENT_RECORD_READ_MS);
}

/** Whether a read of the authority may go out behind this request at all. */
function readsCurrent(edge: EdgeContext, settings: RuntimeCacheSettings): boolean {
  return edge.host.currentRecord !== undefined && !edge.validated && settings.holdMs !== 0;
}

/**
 * One read of the entry's record, holding one of the isolate's background slots while it is out
 * and no longer (`claimBackgroundRecord`): `undefined` where none is free, or where a read of the
 * entry is out already. Reads behind stale requests are not made within `cadenceMs` of it. It asks
 * for a record later than `asked.after`: the target's revision, or a later one a follow-up's
 * earlier read was answered with (`follow`).
 */
function startRead(
  edge: EdgeContext,
  asked: Omit<CurrentRead, 'active'>,
  cadenceMs: number,
  latestStart?: number,
): Promise<ReadAnswer> | undefined {
  // A delayed timer must not claim a slot or record a cadence after the follow-up expires.
  if (latestStart !== undefined && edge.runtime.now() > latestStart) return undefined;
  const { target } = asked;
  const recordKey = kvGenerationKey(target.scopeId, target.entryId);
  const release = claimBackgroundRecord(edge.runtime, recordKey);
  if (release === undefined) return undefined;
  readsOf(edge, cadenceMs).recent.set(recordKey, target.revision, cadenceMs);
  const current: CurrentRead = { ...asked, active: true };
  return boundedRead(readCurrent(edge, current, release, latestStart), current, recordKey);
}

/**
 * Ask behind a served build or stale record. Regional KV can still answer absent or with A after
 * the authority holds B: its current record, verified by the loader, lets later requests use B
 * without making this response wait or lowering the regional cache's TTL.
 *
 * The deadline bounds the whole operation, including validation and keeping the copy. Its fence
 * forbids adoption after the deadline. An RPC cannot be cancelled through this host contract, so
 * its pending slot stays occupied until it settles: a host that never answers cannot accumulate
 * unlimited calls or late buffers. It leaves normal KV refreshes working throughout.
 */
function requestCurrentBehind(
  edge: EdgeContext,
  target: RecordVersion,
  settings: RuntimeCacheSettings,
  cadenceMs: number,
): void {
  if (!readsCurrent(edge, settings)) {
    return;
  }
  const { scopeId, entryId, revision } = target;
  const recordKey = kvGenerationKey(scopeId, entryId);
  const state = readsOf(edge, cadenceMs);
  // Nor while the regeneration this isolate asked for of that record is followed: its reads are the
  // ones timed to find what it publishes (`followRegeneration`).
  if (
    state.recent.get(recordKey) === revision ||
    state.following.get(recordKey)?.target.revision === revision
  ) {
    return;
  }
  const read = startRead(edge, { target, after: revision, settings }, cadenceMs);
  if (read !== undefined) edge.ctx.waitUntil(read);
}

/** Refresh only behind a stale generation; normal fresh delivery asks no authority. */
export function readCurrentBehind(
  edge: EdgeContext,
  pack: DecodedGenerationPack,
  settings: RuntimeCacheSettings,
  cadenceMs: number,
): void {
  requestCurrentBehind(edge, pack.header, settings, cadenceMs);
}

/** Wait behind the response, holding no background slot meanwhile. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read for the regeneration's publish until the isolate holds a later record than the one it
 * replaces, however it came, the authority answers with a later one no further read could bring
 * the isolate to hold, the follow-up of a later record's regeneration takes its place
 * (`followRegeneration`), or the follow-up's time is up. A later record the isolate decoded and
 * will not hold ends nothing, and is not sent again: the reads after it ask after its revision
 * (`readCurrent`). A read the budget refuses is not waited for: that turn passes, and the next
 * comes an interval on.
 */
async function follow(
  edge: EdgeContext,
  followed: Followed,
  following: CurrentReads['following'],
): Promise<void> {
  const { target, recordKey, settings, until } = followed;
  let wait = FOLLOW_FIRST_MS;
  // What each read asks after: the record replaced, or the latest later one it would not hold.
  let after = target.revision;
  for (let read = 0; read < FOLLOW_READS && edge.runtime.now() + wait <= until; read += 1) {
    await pause(wait);
    wait = FOLLOW_EVERY_MS;
    // Its place taken, it reads no more, whatever is held: the entry's reads are the later one's.
    if (following.get(recordKey) !== followed) return;
    if (heldLater(edge, recordKey, target.revision) !== undefined) return;
    const reading = startRead(edge, { target, after, settings }, cadenceOf(settings), until);
    const answer = reading === undefined ? after : await reading;
    if (answer === true) return;
    after = answer;
  }
}

/**
 * The regeneration a request asked for of the record `pack`, which it served stale, has begun: the
 * runtime said it accepted it (`regenerationAccepted`), and begins it once the resume it rides has
 * ended, or as it answers a detached ask. What it publishes would otherwise reach this isolate only
 * behind a later request served stale, a second apart at the most — the request that sets off that
 * read is served the record it replaces, and only the one after it the new one. So the authority is
 * read behind the response, from a little before the publish usually lands and at a short interval
 * (`FOLLOW_FIRST_MS`), until what it publishes is adopted — through the loader's own checks of
 * identity, digests, revision and invalidations (`adoptCurrentRecord`) — or the isolate holds a
 * later record however it came: `FOLLOW_READS` reads at the most, none begun past `FOLLOW_FOR_MS`
 * from now, where the regeneration has begun.
 *
 * Each read holds one of the isolate's background slots while it is out, and none is held between
 * reads: the follow-up leaves them to every other read while it waits. One at a time for an entry
 * in an isolate, as the asks are, once per cooldown — the latest record's: the regeneration of a
 * later record than the one followed takes its place, as the one under way would see that record
 * held and stop, and nothing would read for what the later one publishes. Nothing for a validation,
 * for a host whose records reach the edge only through KV, or under a hold of zero.
 */
export function followRegeneration(
  edge: EdgeContext,
  pack: DecodedGenerationPack,
  settings: RuntimeCacheSettings,
): void {
  if (!readsCurrent(edge, settings)) {
    return;
  }
  const target = pack.header;
  const recordKey = kvGenerationKey(target.scopeId, target.entryId);
  const state = readsOf(edge, cadenceOf(settings));
  // A regeneration asked again of the record followed, or of an earlier one, leaves the follow-up
  // under way to read for it. One of a later record takes that one's place, and the one replaced
  // reads no more from its next turn (`follow`).
  const earlier = state.following.get(recordKey);
  if (earlier !== undefined && earlier.target.revision >= target.revision) {
    return;
  }
  const until = edge.runtime.now() + FOLLOW_FOR_MS;
  const followed: Followed = { target, recordKey, settings, until };
  state.following.set(recordKey, followed);
  edge.ctx.waitUntil(
    (async (): Promise<void> => {
      try {
        await follow(edge, followed, state.following);
      } finally {
        if (state.following.get(recordKey) === followed) state.following.delete(recordKey);
      }
    })(),
  );
}

/**
 * Regional KV can cache an absence while the authority already holds the build's seed or a newer
 * generation. A successfully served build shell asks behind its response, without waiting for a
 * record or pretending the immutable shell is one. Later requests use the verified authority bytes.
 */
export function readAbsentRecordBehind(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
): void {
  if (edge.runtime.memory.generations.get(kvGenerationKey(key.scopeId, key.entryId)) !== undefined)
    return;
  requestCurrentBehind(edge, { ...key, revision: 0 }, settings, cadenceOf(settings));
}

/** A negative KV refresh confirms the still-graced authority record, including an unchanged one. */
export function confirmHeldRecordBehind(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
): void {
  requestCurrentBehind(edge, { ...key, revision: 0 }, settings, cadenceOf(settings));
}
