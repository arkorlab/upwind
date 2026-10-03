import type { DecodedGenerationPack } from '@stayingupwind/core/cache';
import { TtlCache } from '@stayingupwind/core/util';
import { createCacheHost } from 'arkor:cache-host';

import type { CacheHost, CacheHostLookup, DataRead, FetchLike } from './host.ts';
import { TagState } from './tags.ts';

/**
 * What the Function holds, per isolate, to take part in its deployment's runtime cache: the host
 * that stores the entries, the tags it has synced, and the small memories that keep a hot read
 * from being a round trip on every request.
 *
 * The host comes from `arkor:cache-host`, which is handed the Function's environment and finds
 * its own way to whatever stores the entries; a build whose host answers nothing leaves the
 * Function as it was before any cache existed. Per isolate, not per request, because an isolate's
 * bindings do not change underneath a deployment.
 */

/** How long an isolate trusts what it read of the cache before it asks again. */
const DEFAULT_HOLD_MS = 5000;
const MEMO_ENTRIES = 512;
const RECORD_MEMO_ENTRIES = 256;
const ARTIFACT_MEMO_ENTRIES = 64;
const ENTRY_ID_ENTRIES = 1024;
const KIB = 1024;
const MIB = KIB * KIB;
const PAYLOAD_MEMO_MIB = 8;
const ARTIFACT_MEMO_MIB = 4;
const DATA_STATE_KIB = 128;
const DATA_STATE_BYTES = DATA_STATE_KIB * KIB;
const DATA_STATE_ENTRY_BYTES = 128;
const ENTRY_IDS_KIB = 256;
const ENTRY_IDS_BYTES = ENTRY_IDS_KIB * KIB;
/** Leave the rest of a Function's 128 MB for Next.js, rendering and concurrent requests. */
const DATA_MEMO_BYTES = PAYLOAD_MEMO_MIB * MIB;
const RECORD_MEMO_BYTES = PAYLOAD_MEMO_MIB * MIB;
const ARTIFACT_MEMO_BYTES = ARTIFACT_MEMO_MIB * MIB;
const UTF16_BYTES = 2;

export interface CacheRuntime {
  readonly scopeId: string;
  readonly host: CacheHost;
  readonly tags: TagState;
  readonly holdMs: number;
  /** The clock the request acts at, where the host lets a request name one. */
  readonly clockOf: (request: Request) => number | undefined;
  /** Regional reads for one hold; locally written values until expiry, within the byte budget. */
  readonly dataMemo: TtlCache<string, DataMemo>;
  /** Mutation epochs and observed revisions survive payload eviction, within their own budget. */
  readonly dataStates: TtlCache<string, DataState>;
  /**
   * The states a write is still in flight on, out of that budget's reach until the last of those
   * writes answers: a state evicted meanwhile would let a later write of the key start on a state
   * of its own, whose floor the older write's reply never learns. Held no longer than a write can
   * be in flight, nor for more keys than a budget of their own (`data.ts`): a write whose request
   * ended under it never answers.
   */
  readonly dataWrites: Map<string, DataHold>;
  /**
   * The entry id each entry a request named derives to, by the entry's kind, route and pathname:
   * two SHA-256 digests a request for it would otherwise make (`deriveEntry`) before its record
   * can be looked up. An id never changes for the scope, so it is kept until the budget needs the
   * room; the pathnames are the visitors', so the budget is in bytes as well as entries.
   */
  readonly entryIds: TtlCache<string, string>;
  /** Delivery records by entry, decoded, for one hold. */
  readonly recordMemo: TtlCache<string, DecodedGenerationPack | null>;
  /**
   * The reads of delivery records in flight, one per entry, which every request that wants the
   * record while it runs shares (`cache/current.ts`): kept for a hold at most, and within a budget
   * of their own, whether or not the host ever answers them (`sweepReads`).
   */
  readonly recordReads: Map<string, RecordRead>;
  /** Entries a regeneration was asked for lately; a second ask within the hold is not repeated. */
  readonly regenerationMemo: TtlCache<string, true>;
  /**
   * Artifacts of current generations, by id, read for an output other than the record's own. An
   * artifact is named by its content and never rewritten, so what an id read once says it says for
   * good: kept until the budget needs the room rather than for a hold, after which every request
   * that found the record again read the same bytes again, a round trip to the host each time.
   */
  readonly artifactMemo: TtlCache<string, Uint8Array>;
  readonly log: (message: string, fields?: Record<string, string | number>) => void;
}

/** A data-cache answer as the memo keeps it: the metadata and the bytes, or that there was none. */
export type DataMemo =
  | { readonly kind: 'found'; readonly response: DataRead; readonly bytes: Uint8Array }
  | { readonly kind: 'missing' };

export interface DataState {
  epoch: number;
  revision: number;
  /**
   * Reads of the key that have found a value, whether or not `dataMemo` could keep it: a miss
   * answered after another read found the value is not remembered, even when the value itself
   * was too large to be.
   */
  finds: number;
}

/** A state held out of the LRU's reach for the writes in flight on it (`dataWrites`). */
export interface DataHold {
  /** The key the state is of: a hold let go of as lost fences its reads and forgets its memo. */
  readonly key: string;
  readonly state: DataState;
  /** Writes in flight under the hold. */
  writes: number;
  /** When the latest of them began. */
  since: number;
}

/** A read of an entry's delivery record in flight: when it began, and what it will say. */
export interface RecordRead {
  readonly startedAt: number;
  readonly pack: Promise<DecodedGenerationPack | null>;
}

export interface CacheRuntimeOptions {
  readonly env: Record<string, unknown> | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly now: () => number;
  readonly holdMs?: number | undefined;
}

function dataBytes(memo: DataMemo): number {
  return memo.kind === 'missing'
    ? 0
    : memo.bytes.buffer.byteLength + JSON.stringify(memo.response).length * UTF16_BYTES;
}

function recordBytes(pack: DecodedGenerationPack | null): number {
  if (pack === null) {
    return 0;
  }
  // Decoded views normally share the pack's buffer. Charge its full allocation, once.
  const state = pack.postponed;
  return (
    pack.html.buffer.byteLength +
    (state === undefined || state.buffer === pack.html.buffer ? 0 : state.buffer.byteLength) +
    JSON.stringify(pack.header).length * UTF16_BYTES
  );
}

function log(message: string, fields: Record<string, string | number> = {}): void {
  // The Function's own log; nothing else records what its cache did.
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: 'warn', msg: `next-runtime: ${message}`, ...fields }));
}

/**
 * The runtime for these bindings, or `undefined` when they reach no cache.
 *
 * What counts as reaching one is the host's to decide — which bindings it needs and what it does
 * without them — so this asks it and believes the answer.
 */
export function createCacheRuntime(options: CacheRuntimeOptions): CacheRuntime | undefined {
  // Asserted at the boundary, as `arkor:app` is where it is imported: the type the ambient
  // declaration names resolves for `tsc` and not for the type-aware lint's own program, and
  // without this every field read off it would be an `any` from there on.
  const binding = createCacheHost({
    env: options.env,
    fetchImpl: options.fetchImpl,
  }) as CacheHostLookup;
  if (binding === undefined) {
    return undefined;
  }
  const { clockOf, host, scopeId } = binding;
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  return {
    scopeId,
    host,
    clockOf,
    tags: new TagState({
      holdMs,
      log: (message, detail) => {
        log(message, { detail });
      },
    }),
    holdMs,
    dataWrites: new Map(),
    dataStates: new TtlCache(Infinity, MEMO_ENTRIES, options.now, {
      maxBytes: DATA_STATE_BYTES,
      sizeOf: (_state, key) => DATA_STATE_ENTRY_BYTES + key.length * UTF16_BYTES,
    }),
    dataMemo: new TtlCache(holdMs, MEMO_ENTRIES, options.now, {
      maxBytes: DATA_MEMO_BYTES,
      sizeOf: (memo, key) => dataBytes(memo) + key.length * UTF16_BYTES,
    }),
    entryIds: new TtlCache(Infinity, ENTRY_ID_ENTRIES, options.now, {
      maxBytes: ENTRY_IDS_BYTES,
      sizeOf: (entryId, key) => (entryId.length + key.length) * UTF16_BYTES,
    }),
    recordMemo: new TtlCache(holdMs, RECORD_MEMO_ENTRIES, options.now, {
      maxBytes: RECORD_MEMO_BYTES,
      sizeOf: (pack, key) => recordBytes(pack) + key.length * UTF16_BYTES,
    }),
    recordReads: new Map(),
    regenerationMemo: new TtlCache(holdMs, MEMO_ENTRIES, options.now),
    artifactMemo: new TtlCache(Infinity, ARTIFACT_MEMO_ENTRIES, options.now, {
      maxBytes: ARTIFACT_MEMO_BYTES,
      sizeOf: (bytes, key) => bytes.buffer.byteLength + key.length * UTF16_BYTES,
    }),
    log,
  };
}
