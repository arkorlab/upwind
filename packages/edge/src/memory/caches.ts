import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { TtlCache } from '@stayingupwind/core/util';
import {
  type DeliveryPolicy,
  EDGE_ISOLATE_BUDGET_BYTES,
  type EdgePointer,
  manifestCharge,
} from '@stayingupwind/host/delivery';

import { type HeldGeneration, KV_ANSWER_HELD_MS } from '../cache/generation-loader.ts';
import { REGENERATION_MEMORY_TTL_MS } from '../cache/regenerate.ts';
import { CLAIM_MS } from '../cache/scope-signal.ts';
import { IsolateBudget, SharedByteLru } from './budget.ts';
import { InvalidationMemory } from './invalidations.ts';

const SECOND_MS = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MINUTE_MS = SECONDS_PER_MINUTE * SECOND_MS;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
const POINTER_TTL_SECONDS = 10;
const POINTER_TTL_MS = POINTER_TTL_SECONDS * SECOND_MS;
const POINTER_MAX_ENTRIES = 10_000;
const KIB = 1024;
const MIB = KIB * KIB;
/**
 * Pointers, bounded by what they take rather than by their count alone: a host's pointer may carry
 * fields of its own that grow — the hostnames a project is published under, say
 * (`EdgeMemoryOptions.pointerExtraBytes`) — and is held once for every key it is read under. This
 * is about 6,500 pointers without a policy snapshot, and fewer as they carry more. A compact
 * built-in selection adds 32 bytes; a full custom snapshot is charged for both its raw hint and
 * validated copy, against the same 8 MiB bound.
 */
const POINTER_MEMORY_MIB = 8;
const POINTER_MEMORY_BYTES = POINTER_MEMORY_MIB * MIB;
/**
 * What a pointer takes, as measured: about 1.2 KiB parsed and held, rounded up, and the key added;
 * and whatever the host says its own fields take beside (`EdgeMemoryOptions.pointerExtraBytes`).
 */
const POINTER_BYTES = 1280;
/** The built-in literal holds no parsed copy or per-pointer validation/size memo. */
const POLICY_BUILTIN_BYTES = 32;
/** Conservative retained sizes for a snapshot's objects, properties and strings. */
const POLICY_OBJECT_BYTES = 64;
const POLICY_PROPERTY_BYTES = 32;
const POLICY_STRING_BYTES = 24;
const POLICY_PRIMITIVE_BYTES = 8;
const POLICY_CHARACTER_BYTES = 2;
/** The pointer's raw hint and the separate validated copy (`preview/manifest.ts`). */
const POLICY_COPIES = 2;
/** Both WeakMap entries: the validated policy and the insertion-time size held below. */
const POLICY_MEMO_BYTES = 128;
const POLICY_SOURCE_MAX_BYTES = (POINTER_MEMORY_BYTES - POLICY_MEMO_BYTES) / POLICY_COPIES;

/** Charge an object's slots before keeping its children on the bounded work list. */
function policyObjectBytes(
  value: Record<string, unknown>,
  pending: unknown[],
  heldBytes: number,
): number {
  let bytes = heldBytes + POLICY_OBJECT_BYTES;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    bytes += POLICY_PROPERTY_BYTES + key.length * POLICY_CHARACTER_BYTES;
    if (bytes > POLICY_SOURCE_MAX_BYTES) {
      return Infinity;
    }
    pending.push(value[key]);
  }
  return bytes;
}

/**
 * Bound even a malformed public hint without serializing a second, potentially huge JSON string.
 * Iterative so deeply nested JSON cannot exhaust the call stack; stop once the pointer cannot fit.
 */
function selectedPolicyBytes(snapshot: unknown): number {
  let bytes = 0;
  const pending = [snapshot];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      bytes += POLICY_STRING_BYTES + value.length * POLICY_CHARACTER_BYTES;
    } else if (typeof value === 'object' && value !== null) {
      bytes = policyObjectBytes(value as Record<string, unknown>, pending, bytes);
    } else {
      bytes += POLICY_PRIMITIVE_BYTES;
    }
    if (bytes > POLICY_SOURCE_MAX_BYTES) {
      return Infinity;
    }
  }
  return bytes * POLICY_COPIES + POLICY_MEMO_BYTES;
}

function pointerBytesWith(
  extra: ((pointer: EdgePointer) => number) | undefined,
): (held: HeldPointer, key: string) => number {
  // Immutable pointer objects can be reinserted when their TTL is renewed. Charge them without
  // walking the snapshot again, and let the memo go whenever the pointer itself is no longer held.
  const selectedBytes = new WeakMap<EdgePointer, number>();
  return (held, key) => {
    let bytes = POINTER_BYTES + key.length;
    const { pointer } = held;
    if (pointer === null) {
      return bytes;
    }
    if (pointer.selectedPolicy === 'builtin') {
      bytes += POLICY_BUILTIN_BYTES;
    } else if (pointer.selectedPolicy !== undefined) {
      let selected = selectedBytes.get(pointer);
      if (selected === undefined) {
        selected = selectedPolicyBytes(pointer.selectedPolicy);
        selectedBytes.set(pointer, selected);
      }
      bytes += selected;
    }
    return extra === undefined ? bytes : bytes + extra(pointer);
  };
}
/**
 * Keys nothing is published under, held apart from the pointers that are. A key a request names —
 * its hostname, say — is the one thing on this path anyone can make up, and every made-up one costs
 * a read; held among the pointers, a stream of them would push out the projects being served, whose
 * next request would then wait on KV again. Held here, they push out only each other.
 */
const ABSENT_POINTER_MAX_ENTRIES = 2048;
const POLICY_TTL_MS = MINUTE_MS;
const POLICY_MAX_ENTRIES = 1000;
/**
 * How long live traffic keeps what stood in for a policy KV has no document for. Short, because a
 * stand-in is what a policy still propagating looks like, and the policy itself should be served
 * soon after it lands; long enough that the requests of a project whose policy is missing are not
 * each three KV reads in a row.
 */
const POLICY_STAND_IN_SECONDS = 5;
const POLICY_STAND_IN_TTL_MS = POLICY_STAND_IN_SECONDS * SECOND_MS;
/**
 * How long a manifest neither KV nor R2 held is taken for absent.
 *
 * The pointer's own TTL, because the two absences are the same one seen twice: a manifest is read
 * for a pointer, and a pointer this isolate holds for another ten seconds names the manifest it
 * named before. Longer and a manifest still propagating behind its pointer would stay unseen after
 * the pointer that named it had already been refreshed; shorter buys nothing, since no new pointer
 * can arrive within it.
 */
const ABSENT_MANIFEST_TTL_MS = POINTER_TTL_MS;
const ABSENT_MANIFEST_MAX_ENTRIES = 1000;
/**
 * The key is `(projectId, manifestId, pathname)`, so a deployment that fixes the problem gets a new
 * manifest id and a clean entry: a long TTL can never outlive the manifest whose route it condemns.
 * A short one only throttles a permanently broken route, re-serving a recovered document once per
 * TTL in every isolate, rather than stopping it — though the pointer carries the demotion to every
 * isolate within seconds anyway, for as long as the host demotes it.
 */
const SUSPECT_TTL_MS = HOUR_MS;
const SUSPECT_MAX_ENTRIES = 10_000;
/**
 * Shells, delivery records and manifests, held against one budget (`budget.ts`). With the pointers,
 * the member ids and the caches bounded by count below, each full, everything an isolate holds
 * comes to about 70 MiB of its 128 MB, as measured: the rest is the runtime's own, and the bodies
 * in flight.
 */
const ISOLATE_BUDGET_BYTES = EDGE_ISOLATE_BUDGET_BYTES;
/**
 * The most one entry may be charged: half the budget, so that no one record or shell can push out
 * more than half of what everything else holds. A manifest may take the whole budget
 * (`manifestCharge`).
 */
const MAX_ENTRY_BYTES = ISOLATE_BUDGET_BYTES / 2;
const REGENERATION_MAX_ENTRIES = 10_000;
/**
 * A member's own entry is named by a digest of its pathname, derived once per isolate and kept:
 * the members a deployment serves are as many as the URLs its visitors ask for, so the count is
 * bounded and the oldest go first. An absence is held for the policy's hold, as a record is, and
 * judged against it the way a record's own moment of reading is.
 */
const MEMBER_ENTRY_TTL_MS = HOUR_MS;
const MEMBER_ENTRY_MAX_ENTRIES = 10_000;
/**
 * And by what they take: a member's key holds the pathname the visitor asked for, as long as the
 * visitor makes it. Measured at 246 bytes an entry beyond its key and id, rounded up.
 */
const MEMBER_ENTRY_MEMORY_MIB = 4;
const MEMBER_ENTRY_MEMORY_BYTES = MEMBER_ENTRY_MEMORY_MIB * MIB;
const MEMBER_ENTRY_BYTES = 256;

function memberEntryBytes(entryId: string, key: string): number {
  return MEMBER_ENTRY_BYTES + key.length + entryId.length;
}
const ABSENT_RECORD_MAX_ENTRIES = 10_000;
const KV_ANSWERED_MAX_ENTRIES = 10_000;
/**
 * How long this isolate trusts what the middleware last did with a document's pathname, and how
 * many it keeps (`hosted-document.ts`). A minute: a middleware's decision can turn on what a request
 * carries, so it is a prediction, relearned often; the entries are a pathname and a route each.
 */
const REWRITE_SEEN_TTL_MS = MINUTE_MS;
const REWRITE_SEEN_MAX_ENTRIES = 2048;

/**
 * How long an asset candidate the asset strategy refused is remembered, and how many are
 * (`handlers/asset-answer.ts`). A minute: the upstream may come to answer the file in a way that is
 * kept, which an admission makes known at once and the end of this makes known in any case.
 */
const REFUSED_ASSET_TTL_MS = MINUTE_MS;
const REFUSED_ASSET_MAX_ENTRIES = 1024;

/**
 * What the middleware did with a document's pathname when it last ran for it here: the route it
 * rewrote the request onto, which the edge serves, or no route the edge serves at all.
 */
export type RewriteSeen =
  | { readonly kind: 'served'; readonly route: string; readonly pathname: string }
  | { readonly kind: 'unserved' };

/**
 * What a policy id KV holds no document under resolved to: the built-in the id names, or what stood
 * in for it — the default KV names (`default-pointer`), or else the built-in default.
 */
export interface PolicyStandIn {
  readonly policy: DeliveryPolicy;
  readonly source: 'default-pointer' | 'builtin';
}

/**
 * A pointer as this isolate holds it: what KV answered — or that it held none — and when. Held as
 * the host's kind of pointer read it (`PointerKind`), which is the edge's with fields of its own.
 */
export interface HeldPointer<P extends EdgePointer = EdgePointer> {
  readonly pointer: P | null;
  /**
   * When KV answered. A pointer is served past its TTL while KV is read behind the answer, so this
   * — not when it was last served — is how old the deployment a request was answered with may be
   * (`StalePointerRead.ageMs`, told to the kind's observer).
   */
  readonly readAt: number;
}

/** Per-isolate caches. Pointers expire quickly; manifests and shells are immutable by content id. */
export interface EdgeMemory {
  /** What the shells, the delivery records and the manifests are held against, together. */
  readonly budget: IsolateBudget;
  readonly pointers: TtlCache<string, HeldPointer>;
  /** Pointer keys KV held nothing, or nothing valid, under; see `ABSENT_POINTER_MAX_ENTRIES`. */
  readonly absentPointers: TtlCache<string, true>;
  /** Charged for the JSON each was parsed from and for the entries it lists (`manifestCharge`). */
  readonly manifests: SharedByteLru<ProjectManifest>;
  /** Manifest ids neither store held, or that did not parse; kept so neither is asked again at once. */
  readonly absentManifests: TtlCache<string, true>;
  readonly policies: TtlCache<string, DeliveryPolicy>;
  /**
   * What live traffic resolved an id with no document to, by the id: never taken for a document of
   * the id's own, and dropped the moment KV has one (`getPolicy`).
   */
  readonly policyStandIns: TtlCache<string, PolicyStandIn>;
  readonly shells: SharedByteLru<Uint8Array>;
  readonly suspects: TtlCache<string, true>;
  /** Delivery records by KV key, with when they were read; judged against the policy's hold. */
  readonly generations: SharedByteLru<HeldGeneration>;
  /** When this isolate last asked for an entry's regeneration; judged against the policy's cooldown. */
  readonly regenerations: TtlCache<string, number>;
  /**
   * When this isolate last found KV without a record, by KV key; judged against the policy's hold,
   * and held past this memory's own TTL as a record is (`generation-hold.ts`).
   */
  readonly absentRecords: TtlCache<string, number>;
  /**
   * What the deployments it serves invalidated at once, by scope, as their Functions' responses
   * said (`invalidations.ts`): what condemns a record wherever it is read from next
   * (`cache/condemned.ts`).
   */
  readonly invalidations: InvalidationMemory;
  /**
   * Where each scope it serves stands, as this isolate last found it (`cache/scope-signal.ts`):
   * what the Functions it hands a request to are told (`SCOPE_REVISION_HEADER`).
   */
  readonly scopes: TtlCache<string, KnownScope>;
  /**
   * Scopes whose question to the authority another isolate of the data center has claimed, and when
   * its claim lapses (`cache/scope-signal.ts`): this isolate asks none meanwhile.
   */
  readonly claimedElsewhere: TtlCache<string, number>;
  /**
   * Entries KV answered this isolate about — a record or its absence — within KV's own cache life
   * in this data center (`KV_ANSWER_HELD_MS`), by KV key. KV answers the next read of one from the
   * data center, as fast as its copy in the Cache API would, so no copy is read beside it.
   */
  readonly kvAnswered: TtlCache<string, true>;
  /** The entry ids of members this isolate has derived, by scope, route and pathname. */
  readonly memberEntries: TtlCache<string, string>;
  /** What the middleware last did with a document's pathname, by manifest and pathname. */
  readonly rewritesSeen: TtlCache<string, RewriteSeen>;
  /** Asset URLs whose anonymous fetch the asset strategy refused, by manifest and URL. */
  readonly refusedAssets: TtlCache<string, true>;
}

/** Where a scope stands, as an isolate last found it, and when it looked, on its own clock. */
export interface KnownScope {
  readonly revision: number;
  readonly invalidatedAt: number | null;
  readonly checkedAt: number;
}

/** How long an isolate keeps where a scope stood, and for how many scopes at most. */
const SCOPES_TTL_MS = HOUR_MS;
const SCOPES_MAX_ENTRIES = 4096;

/** What a host adds to what the edge holds of its own. */
export interface EdgeMemoryOptions {
  /**
   * What a pointer of the host's takes beyond the edge's own fields, in bytes: a host whose pointers
   * list more — hostnames, say — has that charged against the pointers' bound, which is what keeps a
   * pointer that lists a hundred of them from being held ten thousand times over.
   */
  readonly pointerExtraBytes?: ((pointer: EdgePointer) => number) | undefined;
}

export function createEdgeMemory(now: () => number, options: EdgeMemoryOptions = {}): EdgeMemory {
  const budget = new IsolateBudget(ISOLATE_BUDGET_BYTES, MAX_ENTRY_BYTES);
  const scopes = new TtlCache<string, KnownScope>(SCOPES_TTL_MS, SCOPES_MAX_ENTRIES, now);
  return {
    budget,
    pointers: new TtlCache(POINTER_TTL_MS, POINTER_MAX_ENTRIES, now, {
      maxBytes: POINTER_MEMORY_BYTES,
      sizeOf: pointerBytesWith(options.pointerExtraBytes),
    }),
    absentPointers: new TtlCache(POINTER_TTL_MS, ABSENT_POINTER_MAX_ENTRIES, now),
    manifests: new SharedByteLru(budget, manifestCharge, ISOLATE_BUDGET_BYTES),
    absentManifests: new TtlCache(ABSENT_MANIFEST_TTL_MS, ABSENT_MANIFEST_MAX_ENTRIES, now),
    policies: new TtlCache(POLICY_TTL_MS, POLICY_MAX_ENTRIES, now),
    policyStandIns: new TtlCache(POLICY_STAND_IN_TTL_MS, POLICY_MAX_ENTRIES, now),
    shells: new SharedByteLru(budget),
    suspects: new TtlCache(SUSPECT_TTL_MS, SUSPECT_MAX_ENTRIES, now),
    generations: new SharedByteLru(budget),
    regenerations: new TtlCache(REGENERATION_MEMORY_TTL_MS, REGENERATION_MAX_ENTRIES, now),
    absentRecords: new TtlCache(REGENERATION_MEMORY_TTL_MS, ABSENT_RECORD_MAX_ENTRIES, now),
    // A scope whose invalidations were forgotten for want of room is no longer known to stand where
    // it was found, so the next answer about it is taken in whole (`takeIn`, in
    // `cache/scope-signal.ts`).
    invalidations: new InvalidationMemory(now, undefined, (scopeId) => {
      scopes.delete(scopeId);
    }),
    scopes,
    claimedElsewhere: new TtlCache(CLAIM_MS, SCOPES_MAX_ENTRIES, now),
    kvAnswered: new TtlCache(KV_ANSWER_HELD_MS, KV_ANSWERED_MAX_ENTRIES, now),
    memberEntries: new TtlCache(MEMBER_ENTRY_TTL_MS, MEMBER_ENTRY_MAX_ENTRIES, now, {
      maxBytes: MEMBER_ENTRY_MEMORY_BYTES,
      sizeOf: memberEntryBytes,
    }),
    rewritesSeen: new TtlCache(REWRITE_SEEN_TTL_MS, REWRITE_SEEN_MAX_ENTRIES, now),
    refusedAssets: new TtlCache(REFUSED_ASSET_TTL_MS, REFUSED_ASSET_MAX_ENTRIES, now),
  };
}

/**
 * Names a member's derived entry id in this isolate's memory. The scope and the route go by their
 * lengths: either may hold a colon — a scope id is any string the manifest names, a route any path —
 * and joined bare, two members of different scopes or routes could share a key, the one read
 * under the other's id and found missing.
 */
export function memberEntryKey(scopeId: string, route: string, pathname: string): string {
  return `${String(scopeId.length)}:${scopeId}:${String(route.length)}:${route}:${pathname}`;
}

/** The key a document's rewrite is remembered under: the manifest names what the middleware is. */
export function rewriteSeenKey(manifestId: string, pathname: string): string {
  return `${manifestId}:${pathname}`;
}

/**
 * The key a refused asset is remembered under: the manifest, the hostname the fetch was made for,
 * the tag of the headers it forwarded, and the path and query it asked.
 */
export function refusedAssetKey(
  manifestId: string,
  host: string,
  variant: string,
  url: string,
): string {
  return `${manifestId}:${host}:${variant}:${url}`;
}

/**
 * The key a route is condemned under within this isolate (`suspects`), until the pointer arrives
 * with it demoted. A continuation that sets a cookie, sends a header the shell cannot carry, or
 * sends nothing at all makes that route unsuitable for splicing; the other isolates cannot read this
 * restriction, and learn of the route from the pointer they read.
 */
export function routeSuspectKey(projectId: string, manifestId: string, pathname: string): string {
  return `${projectId}:${manifestId}:${pathname}`;
}
