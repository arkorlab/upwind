import {
  type DecodedGenerationPack,
  decodeGenerationPack,
  kvGenerationKey,
  verifyGenerationPack,
} from '@stayingupwind/core/cache';
import { allowRecoveryScript } from '@stayingupwind/core/request';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';

import { LONGEST_COPY_AGE_MS } from '../memory/invalidations.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { isInvalidated } from './condemned.ts';
import {
  type CopyStamps,
  dropCopyIf,
  dropCopyIfStill,
  keepCopyAhead,
  readCopy,
  type RecordCopy,
  worthKeeping,
} from './generation-copy.ts';

/**
 * The delivery record of an entry: the current generation of a hosted application's route, as
 * the cache authority wrote it to KV. Read the way a shell is read — this data center's copy in the
 * Cache API and KV together, the first with a record answering — by a request whose isolate holds
 * nothing of the entry, and behind the response of one whose hold on it is over (`readGeneration`;
 * what an isolate holds, and how long it serves it for, is `generation-hold.ts`). What the record
 * says of its own freshness is judged by the caller; here it is bytes, decoded and verified, or a
 * reason there are none.
 *
 * KV stays the answer. A copy that answered first is weighed against what KV says when it comes
 * back, behind the response: a record KV has moved on to replaces the copy, in this isolate's
 * memory and in the data center, and a record KV no longer has takes the copy away. What a copy
 * is, and what it is trusted with, is `generation-copy.ts`.
 *
 * A record never gives way to an earlier one, copies kept or not. Records of an entry are ordered
 * by their `revision` — the scope's revision at the record's last change, which only goes up — and
 * requests overlap: KV can be behind in one data center, a copy can be kept before this isolate
 * read further, and one request's answer can come back after another's later one. So an answer
 * behind the record this isolate holds is neither held nor served in its place, and one behind the
 * copy the data center holds now is not kept over it. An answer that there is no record takes away
 * only what its request had seen, since it cannot be ordered against a record another request put
 * in place meanwhile.
 *
 * The copy is read beside KV by a read before the first byte, which it can take the wait for KV
 * off, and by one behind the response alike, which it cannot: that one is the same read, and keeps
 * the copy in line with KV. For an entry KV answered this isolate about within its cache life in
 * the data center (`KV_ANSWER_HELD_MS`), though, KV answers from there as fast as the copy would,
 * and reading the copy beside it would only be work beside the response; it is read then only if KV
 * fails. That life is counted from KV's first answer, not from each: the read after it is made
 * beside the copy again, which is what keeps the copy of a page this isolate serves often from
 * staying behind KV or ageing out.
 */

/** The requested regional-cache TTL; KV distribution itself remains eventually consistent. */
const KV_CACHE_TTL_SECONDS = 30;
const MS_PER_SECOND = 1000;
/**
 * How long KV keeps a record it answered with in a data center (`cacheTtl`): for that long after KV
 * first answered this isolate about an entry, it answers the next read of it from the data center.
 */
export const KV_ANSWER_HELD_MS = KV_CACHE_TTL_SECONDS * MS_PER_SECOND;
const DECODED_METADATA_MULTIPLIER = 4;
const CSP_HEADER = 'content-security-policy';

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

export interface LoadOptions {
  /**
   * Hold a record's absence for the hold as well as its presence. For an entry that may have no
   * record at all — a member's own, beside the class shell's — asking KV on every request would
   * find it absent on every request; held, the absence is asked about once per hold, as a record
   * is.
   */
  readonly holdAbsence?: boolean | undefined;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packBytes(pack: DecodedGenerationPack, recordBytes: number): number {
  const bodyBytes = pack.html.byteLength + (pack.postponed?.byteLength ?? 0);
  // The body views retain the complete record buffer. Budget decoded strings/objects too,
  // including metadata-only records; this arithmetic runs only when a record is read.
  const metadataAllowance = DECODED_METADATA_MULTIPLIER * (recordBytes - bodyBytes);
  return recordBytes + metadataAllowance;
}

/**
 * The CSP source that permits the recovery script. The script is the same for every record, so
 * this isolate digests it once, when the first record with a policy is read.
 */
const recovery: { source: string | undefined } = { source: undefined };

/**
 * The record with its policy permitting the recovery script, as the deployment run records a
 * route's (`allowRecoveryScript`): the edge replays the headers of the generation it serves and
 * appends that script to a document whose resume fails, and a policy restricting inline scripts
 * would block it. Widened here, once per read of the record, rather than on every request that
 * serves it. Only a record with a policy comes here; any other — nearly every one — goes on as it
 * was read, without waiting on anything.
 */
async function withRecoveryPermitted(pack: DecodedGenerationPack): Promise<DecodedGenerationPack> {
  recovery.source ??= await recoveryScriptCspSource();
  const permitted = allowRecoveryScript(pack.header.headers, recovery.source);
  return { ...pack, header: { ...pack.header, headers: { ...permitted } } };
}

async function readRecord(edge: EdgeContext, key: string): Promise<ArrayBuffer | null> {
  return edge.env.CACHE_STATE.get(key, { type: 'arrayBuffer', cacheTtl: KV_CACHE_TTL_SECONDS });
}

/** What KV said: the record's bytes, that it holds none, or nothing at all, because it threw. */
type KvAnswer =
  | { readonly kind: 'bytes'; readonly bytes: ArrayBuffer }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly detail: string };

/** Ask KV for the record. Never rejects: a KV that throws has answered `failed`. */
async function askKv(edge: EdgeContext, recordKey: string): Promise<KvAnswer> {
  try {
    const bytes = await readRecord(edge, recordKey);
    return bytes === null ? { kind: 'none' } : { kind: 'bytes', bytes };
  } catch (error) {
    const detail = errorDetail(error);
    logWarn('delivery record read failed', { key: recordKey, detail });
    return { kind: 'failed', detail };
  }
}

/** Where a record's bytes came from, which decides what they are checked for. */
type Origin =
  | { readonly kind: 'kv' }
  /** This data center's copy, whose stamp says which revision it holds. */
  | { readonly kind: 'copy'; readonly revision: number };

/** A record decoded and held by this isolate, or why it is not held. */
type Adoption =
  | { readonly kind: 'adopted'; readonly pack: DecodedGenerationPack; readonly readAt: number }
  /** The record checked out, at `revision`, and this isolate holds a later one, which it keeps. */
  | {
      readonly kind: 'behind';
      readonly held: HeldGeneration;
      readonly revision: number;
      readonly pack: DecodedGenerationPack;
    }
  | { readonly kind: 'unusable'; readonly reason: 'corrupt' | 'unsupported' };

type Decoded = Extract<ReturnType<typeof decodeGenerationPack>, { kind: 'ok' }>;

/**
 * Whether decoded bytes are the record they are to be served as. Bytes from KV are held to their
 * digests. A copy is bytes an isolate held to them before it kept them, which is why a hit is not
 * hashed again; what is asked of it is only that it is the record of the entry it is kept under, at
 * the revision its stamp says — the stamp is what copies are ordered by.
 */
async function trusted(decoded: Decoded, key: GenerationKey, origin: Origin): Promise<boolean> {
  if (origin.kind === 'copy') {
    const { header } = decoded.pack;
    return (
      header.scopeId === key.scopeId &&
      header.entryId === key.entryId &&
      header.revision === origin.revision
    );
  }
  return verifyGenerationPack(decoded.pack);
}

/** The entry, and the KV key its record is kept under. */
interface RecordName {
  readonly key: GenerationKey;
  readonly recordKey: string;
}

/** A read in flight, and what it is for. */
interface Read extends RecordName {
  readonly options: LoadOptions;
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

/**
 * The record this isolate holds of the entry, past its hold or not, when it is later than one at
 * `revision`: an earlier answer neither answers in its place nor is held over it.
 */
function heldLater(
  edge: EdgeContext,
  recordKey: string,
  revision: number,
): HeldGeneration | undefined {
  const held = edge.runtime.memory.generations.get(recordKey);
  return held !== undefined && held.pack.header.revision > revision ? held : undefined;
}

/**
 * Hold a decoded record: checked for what its origin has to prove, its policy widened for the
 * recovery script, and set in this isolate's memory in place of whatever was there — unless what
 * is there is later, which is weighed after the last wait here, so that another request's record
 * held meanwhile counts.
 */
async function adoptDecoded(
  edge: EdgeContext,
  read: Read,
  decoded: Decoded,
  from: { readonly origin: Origin; readonly byteLength: number },
): Promise<Adoption> {
  if (!(await trusted(decoded, read.key, from.origin))) {
    logWarn(
      from.origin.kind === 'kv'
        ? 'delivery record does not match its digests'
        : 'record copy is not the record its stamps say',
      { key: read.recordKey },
    );
    return { kind: 'unusable', reason: 'corrupt' };
  }
  const pack =
    decoded.pack.header.headers[CSP_HEADER] === undefined
      ? decoded.pack
      : await withRecoveryPermitted(decoded.pack);
  const { revision } = pack.header;
  const later = heldLater(edge, read.recordKey, revision);
  if (later !== undefined) {
    return { kind: 'behind', held: later, revision, pack };
  }
  const readAt = edge.runtime.now();
  // There is a record, condemned or not: an absence held of it no longer stands.
  edge.runtime.memory.absentRecords.delete(read.recordKey);
  if (isInvalidated(edge.runtime.memory, pack)) {
    // Answered, not held: a record held is served past its hold however long ago it was read, and an
    // invalidation reached this one (`isInvalidated`) — a read that set out before it was taken in,
    // or one KV or the copy answered from before it. Nothing is put in place, so `read.adopted`
    // names nothing: it is what this read put in memory, for `forgetSeen` to take back.
    return { kind: 'adopted', pack, readAt };
  }
  const bytes = packBytes(pack, from.byteLength);
  const held = { pack, readAt, bytes };
  edge.runtime.memory.generations.set(read.recordKey, held, bytes);
  read.adopted.held = held;
  return { kind: 'adopted', pack, readAt };
}

async function adopt(
  edge: EdgeContext,
  read: Read,
  bytes: ArrayBuffer,
  origin: Origin,
): Promise<Adoption> {
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (decoded.kind !== 'ok') {
    logWarn('delivery record unusable', {
      key: read.recordKey,
      kind: decoded.kind,
      origin: origin.kind,
    });
    return { kind: 'unusable', reason: decoded.kind };
  }
  return adoptDecoded(edge, read, decoded, { origin, byteLength: bytes.byteLength });
}

/**
 * What the edge held of the entry before any of this: the record this isolate last read, past its
 * hold or not, which a failed read offers for what it is worth.
 */
function lastHeld(edge: EdgeContext, recordKey: string): DecodedGenerationPack | undefined {
  return edge.runtime.memory.generations.get(recordKey)?.pack;
}

/** Revisions start at zero, so this is below any a request can have seen. */
const NOTHING_SEEN = -1;

/**
 * The latest revision a request had seen of the entry before KV answered it: the record its
 * isolate held when it began, and the copy it read. An answer that there is no record — or none
 * the edge can read — speaks for no more than that. A record another request put in place since
 * may be later than that answer or earlier; it is left for the next read of KV to settle.
 * `NOTHING_SEEN` for a request that had seen neither (`dropSeen`).
 */
function seenBy(read: Read, copy: CopyStamps | undefined): number {
  return Math.max(read.heldRevision ?? NOTHING_SEEN, copy?.revision ?? NOTHING_SEEN);
}

/**
 * Forget the record this isolate holds of the entry, for a KV that bears none out: KV holds none —
 * an absence held, when the read asks for that — or holds one the edge cannot read. Not one later
 * than what the request had seen (`seenBy`), which is kept, absence and all.
 */
function forgetSeen(edge: EdgeContext, read: Read, seen: number, absent: boolean): void {
  const held = edge.runtime.memory.generations.get(read.recordKey);
  // Nor one another read put in place after this one began, the same revision included: under a
  // hold of zero every request reads, and one that read the record again while this was out knows
  // later than this answer does what KV holds. One this read put in place itself, from the data
  // center's copy, is this read's to take back.
  // By the pack: a renewal of the hold (`generation-hold.ts`) holds the same one again, and has
  // read nothing, where every read decodes its own.
  const putSince = held?.pack !== read.heldAtStart?.pack && held?.pack !== read.adopted.held?.pack;
  if (held !== undefined && (putSince || held.pack.header.revision > seen)) {
    return;
  }
  edge.runtime.memory.generations.delete(read.recordKey);
  if (absent && read.options.holdAbsence === true && absenceHoldable(edge, read)) {
    edge.runtime.memory.absentRecords.set(read.recordKey, edge.runtime.now());
  }
}

/**
 * Whether an absence the read found may be held: it set out once KV can no longer answer with what
 * it held before the scope's latest at-once invalidation (`absencesHeldFrom`, `condemned.ts`). One
 * that set out before the invalidation, or soon after it, may have been told there was no record
 * where the invalidation reached one.
 */
function absenceHoldable(edge: EdgeContext, read: Read): boolean {
  const heldFrom = edge.runtime.memory.invalidations.absencesHeldFrom(read.key.scopeId);
  return heldFrom === undefined || read.startedAt >= heldFrom;
}

/** A record held to its digests: fit to serve, to hold, and to keep as a copy. */
interface Verified {
  readonly bytes: ArrayBuffer;
  readonly revision: number;
  /** What the bytes decode to, for what this isolate knows of it beside its revision. */
  readonly pack: DecodedGenerationPack;
}

/** What KV's answer came to: what is served, and KV's record, when it checked out. */
interface KvRead {
  readonly load: GenerationLoad;
  readonly verified: Verified | undefined;
}

/** A record this isolate holds, answering in place of an earlier one KV or the copy brought. */
function heldLoad(held: HeldGeneration, lookupMs: number, afterKv: boolean): GenerationLoad {
  const load = { kind: 'generation', pack: held.pack, source: 'memory', lookupMs } as const;
  return afterKv ? { ...load, afterKv } : load;
}

/**
 * KV's answer, served as it always has been. A record KV holds none of, or none the edge can read,
 * is forgotten by this isolate too — the one its request had seen, and nothing another request put
 * in place meanwhile (`forgetSeen`): a record held is served past its hold (`generation-hold.ts`),
 * and one KV no longer bears out would otherwise be served for good. A record behind the one this
 * isolate holds — KV behind in this data center, or another request's later answer put in place
 * first — answers with the later one instead.
 */
async function readKv(edge: EdgeContext, read: Read, answer: KvAnswer): Promise<KvRead> {
  const since = (): number => edge.runtime.now() - read.startedAt;
  switch (answer.kind) {
    case 'failed': {
      const held = lastHeld(edge, read.recordKey);
      const load = { kind: 'unavailable', detail: answer.detail, held, lookupMs: since() } as const;
      return { load, verified: undefined };
    }
    case 'none': {
      forgetSeen(edge, read, seenBy(read, undefined), true);
      return { load: { kind: 'none', lookupMs: since() }, verified: undefined };
    }
    case 'bytes': {
      return readKvRecord(edge, read, answer.bytes);
    }
  }
}

async function readKvRecord(edge: EdgeContext, read: Read, bytes: ArrayBuffer): Promise<KvRead> {
  const adopted = await adopt(edge, read, bytes, { kind: 'kv' });
  switch (adopted.kind) {
    case 'unusable': {
      forgetSeen(edge, read, seenBy(read, undefined), false);
      const lookupMs = edge.runtime.now() - read.startedAt;
      return { load: { kind: 'unusable', reason: adopted.reason, lookupMs }, verified: undefined };
    }
    case 'behind': {
      const load = heldLoad(adopted.held, edge.runtime.now() - read.startedAt, true);
      return { load, verified: { bytes, revision: adopted.revision, pack: adopted.pack } };
    }
    case 'adopted': {
      const load: GenerationLoad = {
        kind: 'generation',
        pack: adopted.pack,
        source: 'kv',
        readBytes: bytes.byteLength,
        lookupMs: adopted.readAt - read.startedAt,
      };
      const { pack } = adopted;
      return { load, verified: { bytes, revision: pack.header.revision, pack } };
    }
  }
}

/**
 * How old this data center's copy of a record may be and still answer; zero when no copy is read
 * or kept at all — the policy keeps none, the project has turned them off, or the request is a
 * validation, which reads no record and must leave nothing behind for live traffic to be served.
 * Never past `LONGEST_COPY_AGE_MS`, whatever the policy asks: an at-once invalidation is kept only
 * so long past that (`memory/invalidations.ts`), and a copy from before one must not outlive it.
 */
function copyMaxAgeMs(edge: EdgeContext, settings: RuntimeCacheSettings): number {
  const asked = edge.cacheApi && !edge.validated ? (settings.cacheApiMaxAgeMs ?? 0) : 0;
  return Math.min(asked, LONGEST_COPY_AGE_MS);
}

/** A read with copies kept: KV's read under way, and how old a copy may be and still answer. */
interface BesideRead extends Read {
  readonly kv: Promise<KvAnswer>;
  readonly maxAgeMs: number;
}

/** A read of KV and of this data center's copy together, both already under way. */
interface CopiedRead extends BesideRead {
  readonly copy: Promise<RecordCopy | undefined>;
}

/**
 * Keep a record as the data center's copy, unless this isolate holds a later one or was told of an
 * invalidation that reaches it (`isInvalidated`, `condemned.ts`): a copy is never made of a record
 * the isolate already knows to be behind, or invalidated — at once, or with a window, which leaves
 * it to the Function — that other isolates would serve, for as long as the copy's life, however
 * soon KV shows what replaced it. It is judged when the copy is kept, after the read, and again
 * after each wait of the keeping (`keepCopyAhead`): what invalidates it may arrive while any of
 * them is out.
 */
async function keepLatest(edge: EdgeContext, read: BesideRead, record: Verified): Promise<void> {
  const untouched = (): boolean => !isInvalidated(edge.runtime.memory, record.pack);
  if (heldLater(edge, read.recordKey, record.revision) === undefined && untouched()) {
    await keepCopyAhead(edge, read.recordKey, record, {
      maxAgeMs: read.maxAgeMs,
      wanted: untouched,
    });
  }
}

/**
 * Take the copy away for a KV that bears no record out, unless the copy there now is later than
 * what the request had seen (`seenBy`): of a later revision, or of the same one kept again since
 * the request began — by another request whose read of KV confirmed it, which may be the later of
 * the two answers. A request that had seen nothing — its isolate held no record of the entry and it
 * read no copy, as a read of KV alone does once the record has left the isolate's memory — takes
 * away the copy that was there when it began, whatever its revision: the answer came after it, and a
 * copy of a record KV no longer bears out would answer the isolates that have not asked. One kept
 * since is left, as it is by a request that had seen something.
 */
async function dropSeen(edge: EdgeContext, read: BesideRead, seen: number): Promise<void> {
  const seenCopy = (now: CopyStamps): boolean => {
    return seen === NOTHING_SEEN
      ? now.keptAt <= read.startedAt
      : now.revision < seen || (now.revision === seen && now.keptAt <= read.startedAt);
  };
  await dropCopyIf(edge, read.recordKey, read.maxAgeMs, seenCopy);
}

/**
 * Hold a copy later than what KV answered — KV behind in this data center — so that this isolate
 * answers with it from now on rather than with KV's earlier record. One that cannot be held is
 * taken away.
 */
async function holdCopy(edge: EdgeContext, read: CopiedRead, copy: RecordCopy): Promise<void> {
  const adopted = await adopt(edge, read, copy.bytes, { kind: 'copy', revision: copy.revision });
  if (adopted.kind === 'unusable') {
    await dropCopyIfStill(edge, read.recordKey, read.maxAgeMs, copy);
  }
}

/**
 * Bring this data center's copy, and the record this isolate holds, in line with what KV answered
 * to a request it served, behind the response: KV's record kept when the copy is missing or
 * behind, a copy ahead of it held in its place, and the copy taken away when KV holds no record or
 * one the edge cannot read. A KV that failed says nothing to align with. A copy the request could
 * not serve is taken away first, in the same turn, so nothing kept after it goes with it.
 */
async function settleCopy(
  edge: EdgeContext,
  read: CopiedRead,
  kv: { readonly answer: KvAnswer; readonly verified: Verified | undefined },
  unusable: RecordCopy | undefined,
): Promise<void> {
  if (unusable !== undefined) {
    await dropCopyIfStill(edge, read.recordKey, read.maxAgeMs, unusable);
  }
  if (kv.answer.kind === 'failed') {
    return;
  }
  const copy = unusable === undefined ? await read.copy : undefined;
  const { verified } = kv;
  if (verified === undefined) {
    await dropSeen(edge, read, seenBy(read, copy));
    return;
  }
  if (copy !== undefined && copy.revision > verified.revision) {
    await holdCopy(edge, read, copy);
    return;
  }
  if (worthKeeping(edge, copy, verified.revision, read.maxAgeMs)) {
    await keepLatest(edge, read, verified);
  }
}

/** KV's answer served, and the data center's copy brought in line with it behind the response. */
async function answerFromKv(
  edge: EdgeContext,
  read: CopiedRead,
  answer: KvAnswer,
  unusable: RecordCopy | undefined,
): Promise<GenerationLoad> {
  const { load, verified } = await readKv(edge, read, answer);
  edge.ctx.waitUntil(settleCopy(edge, read, { answer, verified }, unusable));
  return load;
}

/** What came of the copy a request read: served, or one that could not be. */
type CopyOutcome =
  | { readonly kind: 'served'; readonly load: GenerationLoad }
  | { readonly kind: 'unusable' };

/**
 * The copy served: decoded, checked to be the entry's record at the revision it says, and held by
 * this isolate as a record read from KV would be — unless this isolate holds a later record, which
 * answers instead.
 */
async function fromCopy(
  edge: EdgeContext,
  read: CopiedRead,
  copy: RecordCopy,
): Promise<CopyOutcome> {
  const adopted = await adopt(edge, read, copy.bytes, { kind: 'copy', revision: copy.revision });
  switch (adopted.kind) {
    case 'unusable': {
      return { kind: 'unusable' };
    }
    case 'behind': {
      const lookupMs = edge.runtime.now() - read.startedAt;
      return { kind: 'served', load: heldLoad(adopted.held, lookupMs, false) };
    }
    case 'adopted': {
      const lookupMs = adopted.readAt - read.startedAt;
      const load = {
        kind: 'generation',
        pack: adopted.pack,
        source: 'cache-api',
        lookupMs,
      } as const;
      return { kind: 'served', load };
    }
  }
}

/** KV's record, weighed against the copy that answered before it came back. */
async function confirmWith(
  edge: EdgeContext,
  read: CopiedRead,
  copy: RecordCopy,
  bytes: ArrayBuffer,
): Promise<void> {
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (decoded.kind !== 'ok') {
    logWarn('delivery record unusable', { key: read.recordKey, kind: decoded.kind, origin: 'kv' });
    forgetSeen(edge, read, seenBy(read, copy), false);
    await dropSeen(edge, read, seenBy(read, copy));
    return;
  }
  const { revision } = decoded.pack.header;
  if (revision === copy.revision) {
    // Kept again from the copy's own bytes: the same record as KV's, and the ones an isolate held
    // to their digests before it kept them, where KV's were only decoded here for their revision.
    if (worthKeeping(edge, copy, revision, read.maxAgeMs)) {
      await keepLatest(edge, read, { bytes: copy.bytes, revision, pack: decoded.pack });
    }
    return;
  }
  if (revision < copy.revision) {
    // KV behind in this data center: the copy saw further, and nothing changes.
    return;
  }
  const from = { origin: { kind: 'kv' }, byteLength: bytes.byteLength } as const;
  const adopted = await adoptDecoded(edge, read, decoded, from);
  if (adopted.kind === 'unusable') {
    forgetSeen(edge, read, seenBy(read, copy), false);
    await dropSeen(edge, read, seenBy(read, copy));
    return;
  }
  await keepLatest(edge, read, { bytes, revision, pack: decoded.pack });
}

/**
 * KV's answer to a request the copy answered, weighed behind the response. The same record leaves
 * everything as it is, the copy kept again once it is far enough into its age; a later one replaces
 * the copy in this isolate's memory and in the data center, unless a later one still was held or
 * kept meanwhile; an earlier one is KV behind here, and changes nothing; none, or one the edge
 * cannot read, takes the copy away in both — the copy the request served, and nothing later put in
 * place meanwhile. A KV that failed leaves the copy answering, which is what it is for while KV
 * cannot be read.
 */
async function confirmCopy(edge: EdgeContext, read: CopiedRead, copy: RecordCopy): Promise<void> {
  const answer = await read.kv;
  switch (answer.kind) {
    case 'failed': {
      return;
    }
    case 'none': {
      forgetSeen(edge, read, seenBy(read, copy), true);
      await dropSeen(edge, read, seenBy(read, copy));
      return;
    }
    case 'bytes': {
      await confirmWith(edge, read, copy, answer.bytes);
    }
  }
}

async function kvFirst(kv: Promise<KvAnswer>): Promise<{ readonly kv: KvAnswer }> {
  return { kv: await kv };
}

async function copyFirst(
  copy: Promise<RecordCopy | undefined>,
): Promise<{ readonly copy: RecordCopy | undefined }> {
  return { copy: await copy };
}

/**
 * The record from whichever of the two has it first.
 *
 * A copy in hand answers at once, and KV's answer is weighed against it behind the response. No
 * copy — none, too old, or one that cannot be served — leaves KV to answer as it always has. KV
 * answering first is served as it always has been too, unless this isolate holds a later record,
 * and a copy that turns out to be later than KV's is held for the requests after this one. A KV
 * that failed waits for the copy, which is then the only record there is.
 */
async function loadBeside(edge: EdgeContext, read: CopiedRead): Promise<GenerationLoad> {
  const first = await Promise.race([kvFirst(read.kv), copyFirst(read.copy)]);
  if ('copy' in first) {
    const { copy } = first;
    const outcome = copy === undefined ? undefined : await fromCopy(edge, read, copy);
    if (copy !== undefined && outcome?.kind === 'served') {
      edge.ctx.waitUntil(confirmCopy(edge, read, copy));
      return outcome.load;
    }
    return answerFromKv(edge, read, await read.kv, outcome?.kind === 'unusable' ? copy : undefined);
  }
  if (first.kv.kind === 'failed') {
    const copy = await read.copy;
    const outcome = copy === undefined ? undefined : await fromCopy(edge, read, copy);
    if (outcome?.kind === 'served') {
      return outcome.load;
    }
    return answerFromKv(edge, read, first.kv, outcome?.kind === 'unusable' ? copy : undefined);
  }
  return answerFromKv(edge, read, first.kv, undefined);
}

/**
 * KV's answer, noted when it is one and none is noted yet: for KV's cache life from here, it
 * answers this isolate about the entry from the data center (`KV_ANSWER_HELD_MS`). The answers
 * within that life do not extend it, so the read after it is made beside the copy again — once,
 * however often the page is asked for here — and weighed against KV as every such read is, which
 * keeps the copy of a page this isolate serves often in line with KV and within its age for the
 * isolates that have not asked.
 */
async function noted(
  edge: EdgeContext,
  recordKey: string,
  kv: Promise<KvAnswer>,
): Promise<KvAnswer> {
  const answer = await kv;
  const { kvAnswered } = edge.runtime.memory;
  if (answer.kind !== 'failed' && kvAnswered.get(recordKey) === undefined) {
    kvAnswered.set(recordKey, true);
  }
  return answer;
}

/**
 * KV alone, for an entry KV answered this isolate about within its cache life in the data center:
 * KV answers from there as fast as the copy would. A KV that holds no record, or none the edge can
 * read, takes away a copy of one this isolate had seen — or, holding none, the copy there when the
 * read began — as beside the copy; a record later than the one this isolate held is kept as the
 * copy behind the response, as beside it, so that an isolate that has not asked is not answered
 * with the earlier one until the next read beside the copy. A KV that fails is read beside the
 * copy after all, which is then the only record there is.
 */
async function loadAfterKv(edge: EdgeContext, read: BesideRead): Promise<GenerationLoad> {
  const answer = await read.kv;
  if (answer.kind === 'failed') {
    return loadBeside(edge, { ...read, copy: readCopy(edge, read.recordKey, read.maxAgeMs) });
  }
  const { load, verified } = await readKv(edge, read, answer);
  if (verified === undefined) {
    edge.ctx.waitUntil(dropSeen(edge, read, seenBy(read, undefined)));
  } else if (verified.revision > (read.heldRevision ?? NOTHING_SEEN)) {
    edge.ctx.waitUntil(keepLatest(edge, read, verified));
  }
  return load;
}

/**
 * Read the entry's record: before the first byte for a request whose isolate holds nothing of it,
 * and behind the response for one that found its hold over (`generation-hold.ts`), whose record —
 * served, and held again — is the one the read is weighed against (`heldRevision`).
 */
export async function readGeneration(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
  options: LoadOptions = {},
): Promise<GenerationLoad> {
  const startedAt = edge.runtime.now();
  const recordKey = kvGenerationKey(key.scopeId, key.entryId);
  const kv = askKv(edge, recordKey);
  const maxAgeMs = copyMaxAgeMs(edge, settings);
  const heldAtStart = edge.runtime.memory.generations.get(recordKey);
  const heldRevision = heldAtStart?.pack.header.revision;
  const asked = {
    key,
    recordKey,
    options,
    startedAt,
    heldRevision,
    heldAtStart,
    adopted: { held: undefined },
  };
  if (maxAgeMs === 0) {
    const read: Read = { ...asked, copies: false };
    return (await readKv(edge, read, await kv)).load;
  }
  const answeredLately = edge.runtime.memory.kvAnswered.get(recordKey) !== undefined;
  const read = { ...asked, copies: true, maxAgeMs };
  const beside = { ...read, kv: noted(edge, recordKey, kv) };
  if (answeredLately) {
    return loadAfterKv(edge, beside);
  }
  // Both at once, as a shell's are read: waiting on the Cache API before asking KV would be
  // first-byte in every data center that holds no copy, and waiting on KV with a copy in hand is
  // the wait the copy is there to take away.
  return loadBeside(edge, { ...beside, copy: readCopy(edge, recordKey, maxAgeMs) });
}
