import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  fromStoredManifest,
  MAX_MANIFEST_BYTES,
  parseProjectManifest,
  type ProjectManifest,
  READ_MANIFEST_SCHEMA_VERSIONS,
} from '@stayingupwind/core/manifest';
import { decodeUtf8, releaseStream } from '@stayingupwind/core/util';
import {
  builtinDeliveryPolicy,
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  deliveryPolicySchema,
  type EdgePointer,
} from '@stayingupwind/host/delivery';
import {
  KV_DEFAULT_POLICY_KEY,
  kvManifestKey,
  kvPolicyKey,
  r2ManifestKey,
} from '@stayingupwind/host/storage';

import type { EdgeBindings } from '../bindings.ts';
import type { EdgeRuntime } from '../edge-runtime.ts';
import type { PolicyStandIn } from '../memory/caches.ts';
import { logWarn } from '../observability/logger.ts';
import { readManifestCopy } from './blobs.ts';
import { boundedLookup, type HoldRefresh, type Lookup, lookup, MISSING } from './storage.ts';

/** Each cold backend gets the same two seconds as an immutable blob or record read. */
const MANIFEST_READ_BUDGET_MS = 2000;

/**
 * The copy of a manifest a deploy keeps in R2, for a read KV could not answer.
 *
 * The pointer and the manifest it names reach a colo's KV independently, so a colo can hold the
 * pointer first, and a colo's KV can fail. Either way the project would be handed to its Worker,
 * which answers its documents but carries none of its `_next/` files: the page would load, and its
 * scripts and styles would not. R2 has the copy — written before the KV entry, and consistent —
 * so the one read this costs falls on a cold isolate whose KV read already missed, and the
 * manifest is then held in memory like any other. Only a copy found changes the answer: otherwise
 * KV's stands, so a KV that could not be read is still reported as one.
 *
 * Read through the blob Worker (`blobs.ts`), whose cache keeps it by its id: a deployment's pointer
 * reaches every data center at once, and those whose KV has not caught up then ask its upper tier,
 * with the misses collapsed into one read of the bucket, rather than each crossing to it.
 */
async function durableManifest(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  manifestId: string,
): Promise<Lookup<ArrayBuffer>> {
  return boundedLookup(
    'manifest-object',
    { manifestId },
    async (active) => {
      // Its own digest check: the blob Worker's copy is only ever the bucket's bytes, or nothing.
      const cached = await readManifestCopy(runtime.blobWorker, manifestId);
      if (!active()) return;
      if (cached !== undefined) {
        return cached;
      }
      const object = await env.ARTIFACTS.get(r2ManifestKey(manifestId));
      if (object === null) {
        return;
      }
      if (!active()) {
        releaseStream(object.body, 'manifest lookup no longer waiting');
        return;
      }
      // No manifest a deploy writes is larger than this (`oversizedManifest`): an object that is
      // is a store's fault, refused on the size it states before its body is read into memory.
      if (object.size > MAX_MANIFEST_BYTES) {
        releaseStream(object.body, 'a manifest object larger than any manifest');
        logWarn('manifest copy is larger than any manifest', { manifestId, bytes: object.size });
        return;
      }
      const bytes = await object.arrayBuffer();
      return active() && (await takenUnder(bytes, manifestId, 'r2')) ? bytes : undefined;
    },
    MANIFEST_READ_BUDGET_MS,
  );
}

/**
 * How long KV may hold a manifest lookup in this colo, for a read that may meet one still
 * propagating: validation's, whose manifest was written a moment before, and any under an id that
 * is no digest. KV caches a miss under the same TTL, so this only has to be short enough that a
 * propagation race resolves itself. KV's minimum is 30.
 */
const MANIFEST_KV_CACHE_TTL_SECONDS = 30;
/**
 * How long KV may hold a live read of a manifest under its digest in this colo, once the pointer
 * that names it has stood `MANIFEST_SETTLE_MS`. Such a manifest never changes. At 30 s, a long-tail
 * project's cold isolate paid the pointer's KV read and then the manifest's, in series, from KV's
 * upper tiers. A day, as the blob Worker keeps a manifest: a host that deletes a project's
 * manifests should wait at least that long after taking its pointer down.
 */
const DIGEST_MANIFEST_KV_CACHE_TTL_SECONDS = 86_400;
/**
 * How long a live read of a manifest waits on KV alone before the durable copy is asked beside it.
 * Cloudflare puts KV's cold reads at about 50 ms at p95 and 250 ms at p99 (changelog, 2025-08-22):
 * a read still out after 50 ms is in that tail, where the blob Worker's copy — its data center's
 * tier, or the upper one — answers a manifest any data center has read in a few milliseconds. Only
 * an isolate that holds no copy of the manifest reads it at all, so a warm request never waits on
 * this, and a read that is past the mark costs one more request.
 */
const MANIFEST_HEDGE_MS = 50;
const POLICY_KV_CACHE_TTL_SECONDS = 60;
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
/**
 * How long the pointer naming a manifest must have stood before a live read of it asks KV for the
 * day. KV caches a miss for as long as it was asked to keep the answer, and a manifest is written
 * only moments before validation proves it and the pointer goes out, so a colo whose copy of KV had
 * not caught up when the pointer's first requests arrived would answer every cold isolate there a
 * miss for a day, each then asking the durable copy. KV makes a write visible everywhere within
 * about a minute; five leave room for its tail. Until then a live read asks for the short TTL, and
 * a miss it meets is gone again in half a minute.
 */
const MANIFEST_SETTLE_MINUTES = 5;
const MANIFEST_SETTLE_MS = MANIFEST_SETTLE_MINUTES * MINUTE_MS;
/**
 * How long a manifest that did not parse is taken for absent. Its id names its content, so bytes
 * that do not parse under it never will — and asking both stores again once a pointer's life, as
 * an absence is asked, would only read and refuse the same bytes every ten seconds. A deployment
 * that fixes it publishes another id. An hour, as a suspect manifest is held: long enough that the
 * bytes are not read again and again, and not so long that one reading is held for good.
 */
const INVALID_MANIFEST_HOLD_MS = MINUTES_PER_HOUR * MINUTE_MS;
const SHA256_HEX = /^[\da-f]{64}$/u;

export interface ManifestOptions {
  /**
   * Whether an absence may be held for the hold, as a presence is.
   *
   * Live traffic holds it: a project whose manifest is not there asks both stores again for every
   * request otherwise. Validation does not, and must not — its manifest is written a moment before
   * the run asks for it, and a colo that saw the absence first would answer `missing` for the
   * whole hold and fail a deployment that is only propagating. The saving is a live path's; the
   * run makes a handful of requests. Nor does the read ahead of a refreshed pointer
   * (`pointer.ts`): the absence it found would be held against the requests after it.
   */
  readonly holdAbsence?: boolean | undefined;
  /**
   * Whether this is live traffic's read rather than validation's, which is what KV's day-long TTL
   * and the hedge with the durable copy are for (`readCopies`). Absent, as `holdAbsence`: the read
   * ahead of a refreshed pointer is the one live read that holds no absence.
   */
  readonly live?: boolean | undefined;
  /**
   * When the pointer that names the manifest was written (`updatedAt`). A live read asks KV to keep
   * the answer a day only once that is `MANIFEST_SETTLE_MS` ago; without it, it asks for the short
   * TTL.
   */
  readonly namedSince?: string | undefined;
  /**
   * Where the read of the store that lost the race is kept running once the answer no longer waits
   * on it. Live traffic passes `ctx.waitUntil`: a request that ends first would cancel it, and KV's
   * read is what fills the data center's KV cache, which the next isolate to miss asks first.
   */
  readonly keep?: HoldRefresh | undefined;
}

/**
 * A manifest just parsed, held for the requests after it. One past everything an isolate holds
 * (`manifestCharge`) is not: parsed anew for every request, it would cost each the parse and the
 * heap the budget refused, so it is held as absent, as one that does not parse is, and the bytes
 * are read again once the hold is up. A deploy refuses such a manifest before it is written
 * (`oversizedManifest`, `@stayingupwind/deploy/manifest`); one written all the same is missing to
 * validation too, which holds no absence, rather than proved as it is: live traffic would pass
 * every request of it through without it, its `_next/` files among them, which its Workers do not
 * carry.
 */
function heldOrAnswered(
  runtime: EdgeRuntime,
  parsed: {
    readonly manifestId: string;
    readonly manifest: ProjectManifest;
    readonly bytes: number;
  },
  holdAbsence: boolean,
): Lookup<ProjectManifest> {
  const { manifestId, manifest, bytes } = parsed;
  if (runtime.memory.manifests.set(manifestId, manifest, bytes)) {
    return { kind: 'found', value: manifest };
  }
  logWarn('manifest too large to hold', { manifestId, bytes });
  if (holdAbsence) {
    runtime.memory.absentManifests.set(manifestId, true);
  }
  return MISSING;
}

/**
 * Whether stored bytes may be taken for the manifest under the id they are stored under.
 *
 * The id a deploy names a manifest by is the SHA-256 of its canonical JSON (`computeManifestId`),
 * and what it stores in both places is that JSON (`serializeManifest`), written from a manifest its
 * schema had parsed: the same bytes, as they have been since manifests were first named by their
 * digest. Bytes that are not what such an id names are a store's fault, not the manifest's, and say
 * nothing — the other store is read — rather than going through the schema, which could take them
 * for a valid manifest of another deployment and hold it under this one's id. An id that is no
 * digest (only tests write one) vouches for nothing, and its bytes are read through the whole
 * schema.
 */
async function takenUnder(
  bytes: ArrayBuffer,
  manifestId: string,
  store: 'kv' | 'r2',
): Promise<boolean> {
  if (!SHA256_HEX.test(manifestId) || (await sha256Hex(new Uint8Array(bytes))) === manifestId) {
    return true;
  }
  logWarn('manifest copy is not what its id names', { manifestId, store });
  return false;
}

/** The one default the schema fills in that a manifest from before its field may not carry. */
interface StoredImages {
  dangerouslyAllowLocalIP?: boolean;
}

/**
 * The versions a manifest is read at: this edge's own, and each one a manifest still serving may
 * have been published at (`READ_MANIFEST_SCHEMA_VERSIONS`). The schema reads the same ones.
 */
const READ_VERSIONS: ReadonlySet<unknown> = new Set<unknown>(READ_MANIFEST_SCHEMA_VERSIONS);

/**
 * A manifest its digest vouches for, read without the schema.
 *
 * Validating a large one costs the isolate that reads it first 8–10 ms of CPU (some 180 KiB of
 * JSON): a Worker may not generate code, so the schema is walked field by field, and it is walked
 * on the path of a first byte. The digest is proof enough that these are the bytes the schema
 * already passed where they were written; and a writer of a version wrote nothing its readers
 * refuse (`MANIFEST_SCHEMA_VERSION`), so what is left to check is the version — one the schema
 * reads (`READ_VERSIONS`), or every manifest published before a bump would be missing to an edge
 * that has it. The schema transforms nothing and fills one default, which is filled here the same
 * way; what a stored manifest names by its place in its tables is put back first, as the schema's
 * reading puts it back (`fromStoredManifest`).
 */
function vouchedManifest(text: string): ProjectManifest {
  const parsed: unknown = fromStoredManifest(JSON.parse(text));
  const version =
    typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed
      ? parsed.schemaVersion
      : undefined;
  if (!READ_VERSIONS.has(version)) {
    throw new Error(
      `not a manifest of a schema version this edge reads (${[...READ_VERSIONS].join(', ')})`,
    );
  }
  const images = (parsed as { readonly images?: StoredImages }).images;
  if (images !== undefined) {
    images.dangerouslyAllowLocalIP ??= false;
  }
  return parsed as ProjectManifest;
}

/**
 * Parse stored bytes and hold the manifest; `missing` when they do not parse, which is held as an
 * absence for as long as a manifest that never becomes valid is worth holding (`INVALID_…`).
 *
 * Whichever store answered, bytes under a digest have been checked against it by now
 * (`takenUnder`). Those under an id that is no digest — no manifest a deploy writes — are read
 * through the whole schema, as they always were.
 */
function parseStored(
  runtime: EdgeRuntime,
  manifestId: string,
  bytes: ArrayBuffer,
  holdAbsence: boolean,
): Lookup<ProjectManifest> {
  try {
    // Read as bytes and decoded here, as a read as text is decoded in the binding: it is held at
    // what a deploy's limit counts, its bytes rather than its characters.
    const text = decodeUtf8(new Uint8Array(bytes));
    const manifest = SHA256_HEX.test(manifestId)
      ? vouchedManifest(text)
      : parseProjectManifest(text);
    return heldOrAnswered(runtime, { manifestId, manifest, bytes: bytes.byteLength }, holdAbsence);
  } catch (error) {
    // A data fact like a missing key (nothing to retry), not a storage failure — so it is held as
    // one, and the bytes are not read and parsed again for every request meanwhile.
    logWarn('invalid manifest', {
      manifestId,
      detail: error instanceof Error ? error.message : String(error),
    });
    if (holdAbsence) {
      runtime.memory.absentManifests.set(manifestId, true, INVALID_MANIFEST_HOLD_MS);
    }
    return MISSING;
  }
}

/** The manifest this isolate holds, as a lookup's answer. */
function held(runtime: EdgeRuntime, manifestId: string): Lookup<ProjectManifest> | undefined {
  const value = runtime.memory.manifests.get(manifestId);
  return value === undefined ? undefined : { kind: 'found', value };
}

/**
 * Held only where both stores said there is none. A store that threw said nothing — it is an
 * infrastructure fact, asked again at once (`storage.ts`) — and the answer cannot tell the two
 * apart, because R2's failure leaves KV's answer standing rather than replacing it. Held on that,
 * a colo whose R2 blinked would keep the project's `_next/` files unreachable for the whole hold.
 * The hold is the pointer's, so a manifest still propagating behind its pointer is found as soon
 * as the pointer this isolate holds is refreshed.
 */
function holdIfAbsent(
  runtime: EdgeRuntime,
  manifestId: string,
  answers: { readonly kv: Lookup<unknown>; readonly r2: Lookup<unknown> | undefined },
): void {
  if (answers.kv.kind === 'missing' && answers.r2?.kind === 'missing') {
    runtime.memory.absentManifests.set(manifestId, true);
  }
}

/** KV's copy of a manifest; one that is not what its digest names is taken for none. */
async function kvManifest(
  env: EdgeBindings,
  manifestId: string,
  cacheTtl: number,
): Promise<Lookup<ArrayBuffer>> {
  // The digest is taken inside the lookup, as the durable copy's is: a check that cannot be made
  // is the store's failure, said as one, and never a rejection the race between the stores would
  // carry to the request (`readCopies`).
  return boundedLookup(
    'manifest',
    { manifestId },
    async (active) => {
      const stored = await env.EDGE_STATE.get(kvManifestKey(manifestId), {
        type: 'arrayBuffer',
        cacheTtl,
      });
      return stored !== null && active() && (await takenUnder(stored, manifestId, 'kv'))
        ? stored
        : undefined;
    },
    MANIFEST_READ_BUDGET_MS,
  );
}

/** What the two stores answered: `kv` is left out only when the durable copy won the race. */
interface StoredCopies {
  readonly kv: Lookup<ArrayBuffer> | undefined;
  /** Left out when it was not asked: KV had the manifest before the mark. */
  readonly durable: Lookup<ArrayBuffer> | undefined;
}

const PAST_THE_MARK = Symbol('past the mark');

/** A mark `ms` from now that the caller clears once it has what it waited for. */
function markAfter(ms: number): {
  readonly passed: Promise<typeof PAST_THE_MARK>;
  readonly clear: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<typeof PAST_THE_MARK>((resolve) => {
    timer = setTimeout(() => {
      resolve(PAST_THE_MARK);
    }, ms);
  });
  return {
    passed,
    clear: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

/** A read's end, whatever it came to: neither store's read rejects. */
async function ended(read: Promise<unknown>): Promise<void> {
  await read;
}

/** A store's answer, said to be that store's, for the race between them. */
async function answerFrom<F extends 'kv' | 'durable'>(
  from: F,
  read: Promise<Lookup<ArrayBuffer>>,
): Promise<{ readonly from: F; readonly answer: Lookup<ArrayBuffer> }> {
  return { from, answer: await read };
}

/**
 * KV's copy, and the durable one when KV has none or is slow.
 *
 * A live read gives KV `MANIFEST_HEDGE_MS` alone. Past that, the durable copy is asked beside it,
 * and the first answer with the manifest's bytes is taken: the other runs on, kept past the
 * request's end where the caller says how (`ManifestOptions.keep`), and nothing waits for it.
 * Either store answering without the manifest leaves the other's answer to decide. Validation asks
 * KV and waits, then the durable copy when KV has none, as it always did: what it proves is the
 * stored manifest, and it makes a handful of requests.
 */
async function readCopies(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  manifestId: string,
  read: {
    readonly live: boolean;
    readonly settled: boolean;
    readonly keep: HoldRefresh | undefined;
  },
): Promise<StoredCopies> {
  const { live } = read;
  const cacheTtl =
    live && read.settled && SHA256_HEX.test(manifestId)
      ? DIGEST_MANIFEST_KV_CACHE_TTL_SECONDS
      : MANIFEST_KV_CACHE_TTL_SECONDS;
  const kv = kvManifest(env, manifestId, cacheTtl);
  const mark = live ? markAfter(MANIFEST_HEDGE_MS) : undefined;
  const early = await (mark === undefined ? kv : Promise.race([kv, mark.passed]));
  mark?.clear();
  if (early !== PAST_THE_MARK) {
    return {
      kv: early,
      durable: early.kind === 'found' ? undefined : await durableManifest(env, runtime, manifestId),
    };
  }
  const durable = durableManifest(env, runtime, manifestId);
  const first = await Promise.race([answerFrom('kv', kv), answerFrom('durable', durable)]);
  if (first.answer.kind === 'found') {
    read.keep?.(ended(first.from === 'kv' ? durable : kv));
    return first.from === 'kv'
      ? { kv: first.answer, durable: undefined }
      : { kv: undefined, durable: first.answer };
  }
  const [fromKv, fromDurable] = await Promise.all([kv, durable]);
  return { kv: fromKv, durable: fromDurable };
}

export async function getManifest(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  manifestId: string,
  options: ManifestOptions = {},
): Promise<Lookup<ProjectManifest>> {
  const holdAbsence = options.holdAbsence ?? true;
  const cached = held(runtime, manifestId);
  if (cached !== undefined) {
    return cached;
  }
  // A manifest neither store has is one this isolate was told about a moment ago; without this it
  // would ask both again for every request, and a deployment whose manifest never arrived costs
  // two round trips a request for as long as its pointer stands.
  if (holdAbsence && runtime.memory.absentManifests.get(manifestId) !== undefined) {
    return MISSING;
  }
  const settled =
    options.namedSince !== undefined &&
    // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
    runtime.now() - Date.parse(options.namedSince) >= MANIFEST_SETTLE_MS;
  const copies = await readCopies(env, runtime, manifestId, {
    live: options.live ?? holdAbsence,
    settled,
    keep: options.keep,
  });
  // Every request that missed together waited on its own reads; the first back parses, and the
  // rest find what it parsed rather than parsing it again.
  const meanwhile = held(runtime, manifestId);
  if (meanwhile !== undefined) {
    return meanwhile;
  }
  const raw = copies.durable?.kind === 'found' ? copies.durable : (copies.kv ?? MISSING);
  if (raw.kind !== 'found') {
    if (holdAbsence) {
      holdIfAbsent(runtime, manifestId, { kv: raw, r2: copies.durable });
    }
    return raw;
  }
  return parseStored(runtime, manifestId, raw.value, holdAbsence);
}

async function readPolicy(env: EdgeBindings, policyId: string): Promise<Lookup<DeliveryPolicy>> {
  const raw = await lookup('policy', { policyId }, async () => {
    const stored: unknown = await env.EDGE_STATE.get(kvPolicyKey(policyId), {
      type: 'json',
      cacheTtl: POLICY_KV_CACHE_TTL_SECONDS,
    });
    return stored ?? undefined;
  });
  if (raw.kind !== 'found') {
    return raw;
  }
  const parsed = deliveryPolicySchema.safeParse(raw.value);
  if (!parsed.success) {
    logWarn('invalid delivery policy', { policyId });
    return MISSING;
  }
  // A document is kept under the id it names (`kvPolicyKey`): one under another's key is a store's
  // fault, and taken for none, rather than served as the policy asked for under its own name.
  if (parsed.data.id !== policyId) {
    logWarn('delivery policy names another id', { policyId, named: parsed.data.id });
    return MISSING;
  }
  return { kind: 'found', value: parsed.data };
}

async function readDefaultPolicyId(env: EdgeBindings): Promise<Lookup<string>> {
  return lookup('default policy id', {}, async () => {
    const raw: unknown = await env.EDGE_STATE.get(KV_DEFAULT_POLICY_KEY, {
      type: 'json',
      cacheTtl: POLICY_KV_CACHE_TTL_SECONDS,
    });
    const policyId =
      raw === null || typeof raw !== 'object'
        ? undefined
        : (raw as { policyId?: unknown }).policyId;
    return typeof policyId === 'string' && policyId !== '' ? policyId : undefined;
  });
}

/** Whether the policy served is the one that was asked for, or a stand-in. */
type PolicySource = 'exact' | PolicyStandIn['source'];

/**
 * A policy is never `missing`: an unknown id resolves to a stand-in (`source` says which). A KV
 * failure is `unavailable`, so the caller decides whether a stand-in is acceptable for its request.
 */
export type PolicyLookup =
  | { readonly kind: 'found'; readonly policy: DeliveryPolicy; readonly source: PolicySource }
  | { readonly kind: 'unavailable' };

type StandInLookup =
  | (PolicyStandIn & { readonly kind: 'found' })
  | { readonly kind: 'unavailable' };

/** What stands in for an id with no document: the built-in it names, or the default. */
async function standInFor(env: EdgeBindings, policyId: string): Promise<StandInLookup> {
  // A built-in id — the default policy, or one retired — names that policy itself, document or
  // none: not a stand-in for it, and not whatever default the operator names for the others.
  const builtin = builtinDeliveryPolicy(policyId);
  if (builtin !== undefined) {
    return { kind: 'found', policy: builtin, source: 'builtin' };
  }
  const defaultId = await readDefaultPolicyId(env);
  if (defaultId.kind === 'unavailable') {
    return defaultId;
  }
  const fallback = defaultId.kind === 'found' ? await readPolicy(env, defaultId.value) : MISSING;
  if (fallback.kind === 'unavailable') {
    return fallback;
  }
  logWarn('delivery policy missing, using a stand-in', {
    policyId,
    defaultId: defaultId.kind === 'found' ? defaultId.value : undefined,
  });
  return fallback.kind === 'found'
    ? { kind: 'found', policy: fallback.value, source: 'default-pointer' }
    : { kind: 'found', policy: DEFAULT_DELIVERY_POLICY, source: 'builtin' };
}

/**
 * Read the policy an id names, and what stands in for it when there is no document.
 *
 * `holdStandIn`: live traffic's. A stand-in it resolved is held under the id for a few seconds,
 * apart from the policies (`EdgeMemory.policyStandIns`), so that every request of a project whose
 * policy is missing does not pay up to three KV reads in a row again — the id's, the default
 * pointer's, the default's. Validation holds none and reads none held: its candidate policy was
 * written a moment before the run asks for it, and must be found the moment it is there.
 */
async function resolvePolicyFromKv(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  policyId: string,
  holdStandIn: boolean,
): Promise<PolicyLookup> {
  const direct = await readPolicy(env, policyId);
  if (direct.kind === 'unavailable') {
    return direct;
  }
  if (direct.kind === 'found') {
    runtime.memory.policies.set(policyId, direct.value);
    runtime.memory.policyStandIns.delete(policyId);
    return { kind: 'found', policy: direct.value, source: 'exact' };
  }
  const standIn = await standInFor(env, policyId);
  if (holdStandIn && standIn.kind === 'found') {
    runtime.memory.policyStandIns.set(policyId, { policy: standIn.policy, source: standIn.source });
  }
  return standIn;
}

async function refreshExactPolicy(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  policyId: string,
): Promise<void> {
  const direct = await readPolicy(env, policyId);
  if (direct.kind === 'found') {
    runtime.memory.policies.set(policyId, direct.value);
    return;
  }
  if (direct.kind === 'missing') {
    runtime.memory.policies.delete(policyId);
  }
}

async function refreshStandIn(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  policyId: string,
): Promise<void> {
  await resolvePolicyFromKv(env, runtime, policyId, true);
}

/**
 * The stand-in live traffic resolved for an id within the last few seconds, if any. One past its
 * hold is served again while it is resolved anew behind the response, as an expired policy is: it
 * is held again first, so one resolution goes out per hold, not one per request while it is out.
 */
function heldStandIn(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  policyId: string,
  holdRefresh: HoldRefresh,
): PolicyLookup | undefined {
  const standIn = runtime.memory.policyStandIns.peek(policyId);
  if (standIn === undefined) {
    return undefined;
  }
  if (standIn.stale) {
    runtime.memory.policyStandIns.set(policyId, standIn.value);
    holdRefresh(refreshStandIn(env, runtime, policyId));
  }
  return { kind: 'found', policy: standIn.value.policy, source: standIn.value.source };
}

/**
 * Policy lookup: memory → KV `policy:<id>` → the built-in the id names → KV default pointer →
 * the built-in default.
 *
 * Only an exact hit is memoised as the policy. A stand-in is a symptom of KV propagation lag, and
 * caching it under the requested id would keep serving the wrong policy for the whole TTL after KV
 * caught up; a failed read is not cached either, so the next request retries KV. What live traffic
 * does hold is the stand-in itself, for a few seconds and under a cache of its own
 * (`resolvePolicyFromKv`), and an exact read replaces it the moment KV has the document.
 *
 * An expired isolate entry is still that policy. When `holdRefresh` is provided — live traffic —
 * it is served immediately and KV runs in the background, so a hot shell is not first-byte behind
 * a 60 s TTL.
 */
export async function getPolicy(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  policyId: string,
  holdRefresh?: HoldRefresh,
): Promise<PolicyLookup> {
  const cached = runtime.memory.policies.peek(policyId);
  if (cached === undefined) {
    const standIn =
      holdRefresh === undefined ? undefined : heldStandIn(env, runtime, policyId, holdRefresh);
    return standIn ?? resolvePolicyFromKv(env, runtime, policyId, holdRefresh !== undefined);
  }
  if (!cached.stale) {
    return { kind: 'found', policy: cached.value, source: 'exact' };
  }
  if (holdRefresh !== undefined) {
    // Held again first, as a pointer is: one refresh per TTL, not one per request while it is out.
    runtime.memory.policies.set(policyId, cached.value);
    holdRefresh(refreshExactPolicy(env, runtime, policyId));
    return { kind: 'found', policy: cached.value, source: 'exact' };
  }
  return resolvePolicyFromKv(env, runtime, policyId, false);
}

/** Parsed once per immutable pointer object; never installed in the shared policy-id cache. */
const selectedPolicies = new WeakMap<EdgePointer, DeliveryPolicy | null>();

/** The exact policy copied by the publisher, or no usable hint. */
function selectedPolicy(pointer: EdgePointer): DeliveryPolicy | undefined {
  if (pointer.selectedPolicy === undefined) {
    return undefined;
  }
  if (pointer.selectedPolicy === 'builtin') {
    return builtinDeliveryPolicy(pointer.policyId);
  }
  const cached = selectedPolicies.get(pointer);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const parsed = deliveryPolicySchema.safeParse(pointer.selectedPolicy);
  const policy = parsed.success && parsed.data.id === pointer.policyId ? parsed.data : null;
  selectedPolicies.set(pointer, policy);
  return policy ?? undefined;
}

/**
 * Live traffic's selected policy: a publisher's exact snapshot, or the existing lookup. Policy
 * specs never change under an id; only the pointer's selection moves. A snapshot belongs to this
 * pointer alone, so an unrelated pointer or validation still resolves its own policy from KV.
 */
export function getPolicyForPointer(
  env: EdgeBindings,
  runtime: EdgeRuntime,
  pointer: EdgePointer,
  holdRefresh?: HoldRefresh,
): Promise<PolicyLookup> {
  const policy = selectedPolicy(pointer);
  return policy === undefined
    ? getPolicy(env, runtime, pointer.policyId, holdRefresh)
    : Promise.resolve({ kind: 'found', policy, source: 'exact' });
}
