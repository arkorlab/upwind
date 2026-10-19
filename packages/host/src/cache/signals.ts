import { MAX_TAG_LENGTH } from '@stayingupwind/core/cache';

import type { TagDeltaEntry } from './gateway-contract.ts';

/**
 * What an edge in front of a host's Functions is told of a scope when it asks the authority over a
 * service binding (`CacheSignals`): where the scope stands, the invalidations a data center's reads
 * may still be behind on, and whether the host tells the edge's copies of this when the scope
 * moves. The edge judges what it serves against the invalidations, and tells the Functions behind
 * it where the scope stands (`SCOPE_REVISION_HEADER`).
 */
export interface ScopeSignals {
  /** The revision of the scope's latest invalidation; 0 for none. */
  readonly revision: number;
  /** When that invalidation took effect (unix ms); `null` for none. */
  readonly invalidatedAt: number | null;
  /**
   * The invalidations past the revision the edge named that took effect within
   * `RECENT_INVALIDATIONS_MS`, oldest first, `MAX_RECENT_INVALIDATIONS` at the most.
   */
  readonly tags: readonly TagDeltaEntry[];
  /** Set where more were made than the answer holds: every tagged record before `revision` goes. */
  readonly truncated: boolean;
  /**
   * Whether the host tells the edge's copies of this when the scope moves — purges them, say: a
   * copy is then kept for long, and asked again only once it is gone. Unset, the edge asks again
   * every moment, which asks nothing of the account it runs on.
   */
  readonly announced: boolean;
}

const MS_PER_MINUTE = 60_000;
const RECENT_INVALIDATION_MINUTES = 60;

/**
 * How far back an edge is told of a scope's invalidations: as long as what it reads may still be
 * from before one — a record from KV for minutes, a data center's copy of one for fifty at the most
 * — and as long as an edge keeps what it was told. One that took effect earlier is in what it reads
 * anyway.
 */
export const RECENT_INVALIDATIONS_MS = RECENT_INVALIDATION_MINUTES * MS_PER_MINUTE;

/** The most invalidations an edge is told of at once; past it, `truncated`. */
export const MAX_RECENT_INVALIDATIONS = 64;

/** What JSON writes one character as at its longest: `\u0000`. */
const JSON_BYTES_PER_CHARACTER = 6;
/** Room for the rest of an invalidation's record, its tag's id and its moments among them. */
const RECORD_ROOM_BYTES = 512;
/** Room for where the scope stands, beside the records. */
const ANSWER_ROOM_BYTES = 1024;

/**
 * The longest an answer comes to as JSON, the form an edge keeps a copy of it in:
 * `MAX_RECENT_INVALIDATIONS` records, each of a tag as long as a tag may be in the characters JSON
 * writes longest, and where the scope stands. A tag of ordinary characters comes to a fraction of
 * it; one of control characters comes to six bytes each, and 64 of them to some 100 KiB. A copy read
 * back to no more than this is never too long for an answer the authority gave.
 */
export const MAX_SIGNALS_BYTES =
  MAX_RECENT_INVALIDATIONS * (MAX_TAG_LENGTH * JSON_BYTES_PER_CHARACTER + RECORD_ROOM_BYTES) +
  ANSWER_ROOM_BYTES;
