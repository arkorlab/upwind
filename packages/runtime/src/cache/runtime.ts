import type { DecodedGenerationPack } from '@stayingupwind/core/cache';
import { TtlCache } from '@stayingupwind/core/util';
import { createCacheHost } from 'ppr-cdn:cache-host';

import type { CacheHost, CacheHostLookup, DataRead, FetchLike } from './host.ts';
import { TagState } from './tags.ts';

/**
 * What the Function holds, per isolate, to take part in its deployment's runtime cache: the host
 * that stores the entries, the tags it has synced, and the small memories that keep a hot read
 * from being a round trip on every request.
 *
 * The host comes from `ppr-cdn:cache-host`, which is handed the Function's environment and finds
 * its own way to whatever stores the entries; a build whose host answers nothing leaves the
 * Function as it was before any cache existed. Per isolate, not per request, because an isolate's
 * bindings do not change underneath a deployment.
 */

/** How long an isolate trusts what it read of the cache before it asks again. */
const DEFAULT_HOLD_MS = 5000;
const MEMO_ENTRIES = 512;
const RECORD_MEMO_ENTRIES = 256;
const ARTIFACT_MEMO_ENTRIES = 64;
const KIB = 1024;
const MIB = KIB * KIB;
const PAYLOAD_MEMO_MIB = 8;
const ARTIFACT_MEMO_MIB = 4;
const DATA_STATE_KIB = 128;
const DATA_STATE_BYTES = DATA_STATE_KIB * KIB;
const DATA_STATE_ENTRY_BYTES = 128;
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
   * of its own, whose floor the older write's reply never learns.
   */
  readonly dataWrites: Map<string, DataState>;
  /**
   * Reads in flight, joined by the requests that want the same key meanwhile — for one hold at
   * most, by `startedAt` (`performance.now()`): what a request left out may never settle.
   */
  readonly dataReads: Map<
    string,
    { readonly identity: symbol; readonly promise: Promise<DataMemo>; readonly startedAt: number }
  >;
  /** Delivery records by entry, decoded, for one hold. */
  readonly recordMemo: TtlCache<string, DecodedGenerationPack | null>;
  /** Entries a regeneration was asked for lately; a second ask within the hold is not repeated. */
  readonly regenerationMemo: TtlCache<string, true>;
  /** Artifacts of current generations read for a data route, by id, for one hold. */
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
  /** Writes in flight on the state; while there are any, `dataWrites` holds it. */
  writes: number;
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
  // Asserted at the boundary, as `ppr-cdn:app` is where it is imported: the type the ambient
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
    dataReads: new Map(),
    dataWrites: new Map(),
    dataStates: new TtlCache(Infinity, MEMO_ENTRIES, options.now, {
      maxBytes: DATA_STATE_BYTES,
      sizeOf: (_state, key) => DATA_STATE_ENTRY_BYTES + key.length * UTF16_BYTES,
    }),
    dataMemo: new TtlCache(holdMs, MEMO_ENTRIES, options.now, {
      maxBytes: DATA_MEMO_BYTES,
      sizeOf: (memo, key) => dataBytes(memo) + key.length * UTF16_BYTES,
    }),
    recordMemo: new TtlCache(holdMs, RECORD_MEMO_ENTRIES, options.now, {
      maxBytes: RECORD_MEMO_BYTES,
      sizeOf: (pack, key) => recordBytes(pack) + key.length * UTF16_BYTES,
    }),
    regenerationMemo: new TtlCache(holdMs, MEMO_ENTRIES, options.now),
    artifactMemo: new TtlCache(holdMs, ARTIFACT_MEMO_ENTRIES, options.now, {
      maxBytes: ARTIFACT_MEMO_BYTES,
      sizeOf: (bytes, key) => bytes.buffer.byteLength + key.length * UTF16_BYTES,
    }),
    log,
  };
}
