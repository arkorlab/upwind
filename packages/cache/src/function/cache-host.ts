import { decodeGenerationPack, MAX_TAGS_PER_CALL, tagKindOf } from '@stayingupwind/core/cache';
import { type ScopeRevision, TEST_CLOCK_HEADER } from '@stayingupwind/core/paas';
import { fromBase64 } from '@stayingupwind/core/util';
import {
  CACHE_GATEWAY_URL_BINDING,
  CACHE_INTERNAL_ORIGIN,
  CACHE_READ_GATEWAY_URL_BINDING,
  CACHE_READ_INTERNAL_ORIGIN,
  CACHE_READ_SERVICE_BINDING,
  CACHE_SERVICE_BINDING,
  CACHE_TOKEN_BINDING,
} from '@stayingupwind/host/bindings';
import {
  type CommitArtifact as GatewayCommitArtifact,
  type CommitOutput as GatewayCommitOutput,
  type CommitRequest as GatewayCommitRequest,
  type CurrentGenerationSummary,
  type DataGetResponse,
  type DataSetRequest,
  type InvalidateResponse as GatewayInvalidateResponse,
} from '@stayingupwind/host/cache';
import {
  type ArtifactUpload,
  type AttemptOutcome,
  type AttemptRequest,
  type CacheHost,
  type CacheHostBinding,
  type CacheHostInit,
  type CommitArtifact,
  type CommitOutcome,
  type CommitOutput,
  type CommitRequest,
  type CurrentSummary,
  type DataRead,
  type DataReadRequest,
  type DataWriteRequest,
  type DataWritten,
  type FailRequest,
  type FetchLike,
  type InvalidateOutcome,
  type InvalidateRequest,
  nativeFetch,
  type TagDelta,
  type TagInvalidations,
  type UploadedArtifact,
} from '@stayingupwind/runtime/cache-host';

import { behindResponse, type FunctionCacheNaming } from './artifacts.ts';
import { DataCopies } from './data-copies.ts';
import { Gateway } from './gateway.ts';
import { RecordCopies } from './record-copies.ts';
import { ScopeBeacon } from './scope-beacon.ts';

/**
 * A host's cache, as the runtime of a deployment's Worker is given it.
 *
 * `@stayingupwind/runtime` keeps no cache of its own: it asks a `CacheHost` for every read and
 * every write, and the adapter resolves `arkor:cache-host` to a host's module, which makes its
 * `createCacheHost` here (`cacheHostFor`). So everything about how the cache is reached — which
 * bindings name it, which of them is a service binding and which a URL, the token that opens the
 * deployment's own scope — is here, and none of it is in the runtime.
 *
 * What crosses the interface is what the runtime knows; what this adds is what the gateway
 * requires and the runtime has no opinion about: that a generation was produced by an attempt,
 * that the runtime tracks no dependencies of its own, that every body it uploads is stored as it
 * arrived.
 */

const DEPLOYMENT_ID_BINDING = 'NEXT_DEPLOYMENT_ID';
const TEST_HOOKS_BINDING = 'ARKOR_TEST_HOOKS';

/** The runtime tracks no dependencies of its own; a generation it commits covers all of its own. */
const DEPENDENCIES = [] as const;
const DEPENDENCY_COVERAGE = 'complete';
/** Every body the runtime uploads is stored as it arrived. */
const ARTIFACT_ENCODING = 'identity';

function stringBinding(env: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = env?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * How one of the two gateways is reached: over a service binding, or out to a URL.
 *
 * `fetchImpl` is always the one that carries this gateway's requests, never left out to be
 * inherited. The read gateway is a different Worker from the authority — unplaced, where the
 * authority may be placed far from the caller — and a read that fell back to the authority's
 * transport would arrive at the authority carrying the read gateway's URL in its path, which every
 * route there matches on. It would be answered, correctly, from the wrong continent.
 */
interface Transport {
  readonly url: string;
  readonly fetchImpl: FetchLike;
}

/** Which gateway a transport is being chosen for: the two binding names and the stand-in origin. */
interface GatewayNames {
  readonly service: string;
  readonly url: string;
  readonly internalOrigin: string;
}

const WRITE_GATEWAY: GatewayNames = {
  service: CACHE_SERVICE_BINDING,
  url: CACHE_GATEWAY_URL_BINDING,
  internalOrigin: CACHE_INTERNAL_ORIGIN,
};

const READ_GATEWAY: GatewayNames = {
  service: CACHE_READ_SERVICE_BINDING,
  url: CACHE_READ_GATEWAY_URL_BINDING,
  internalOrigin: CACHE_READ_INTERNAL_ORIGIN,
};

/**
 * A gateway's transport: the service binding when the deployment was given one, the URL when it
 * was given that, and nothing when it was given neither.
 *
 * One or the other: the binding wherever the deployment was given one, and the URL only where it
 * was given none. So a Worker bound to a gateway never goes out over the internet to look for it
 * by a public name, which may answer nothing at all.
 *
 * `override` stands in for the way *out* and for nothing else — it is what a test or a benchmark
 * harness puts in place of `fetch`. A binding is not a way out: it is a handle to a named Worker,
 * and one that was replaced by an override would be a gateway the caller believes it is bound to
 * and is not.
 */
function transportFor(
  env: Record<string, unknown> | undefined,
  names: GatewayNames,
  override: FetchLike | undefined,
): Transport | undefined {
  const service = env?.[names.service];
  if (typeof service === 'object' && service !== null) {
    const binding = service as { fetch: (request: Request) => Promise<Response> };
    return { url: names.internalOrigin, fetchImpl: (request) => binding.fetch(request) };
  }
  const url = stringBinding(env, names.url);
  return url === undefined
    ? undefined
    : { url, fetchImpl: override ?? ((request) => nativeFetch(request)) };
}

/** No request may name a clock: what every deployment but a test configuration answers. */
function noClock(): number | undefined {
  return undefined;
}

/** The clock the request claims, where a test configuration is allowed to hand it one. */
function claimedClock(request: Request): number | undefined {
  const claimed = Number(request.headers.get(TEST_CLOCK_HEADER));
  return Number.isSafeInteger(claimed) && claimed > 0 ? claimed : undefined;
}

/**
 * How this deployment's requests are clocked: the wall clock, unless the deployment carries the
 * test hooks binding, and then whatever a request names.
 */
function clockReader(
  env: Record<string, unknown> | undefined,
): (request: Request) => number | undefined {
  return stringBinding(env, TEST_HOOKS_BINDING) === '1' ? claimedClock : noClock;
}

/** One stored body as the gateway names it: the runtime's own fields, plus how it was stored. */
function committedArtifact(artifact: CommitArtifact): GatewayCommitArtifact {
  return { ...artifact, encoding: ARTIFACT_ENCODING };
}

/** One output as the gateway names it: the runtime's own fields, with its artifacts mapped. */
function committedOutput(output: CommitOutput): GatewayCommitOutput {
  return { ...output, artifacts: output.artifacts.map((artifact) => committedArtifact(artifact)) };
}

/** The entry's current generation as the gateway sums it up, as the runtime reads it. */
function currentOf(current: CurrentGenerationSummary | null): CurrentSummary | null {
  return current === null
    ? null
    : {
        generationId: current.generationId,
        seq: current.seq,
        cacheTimestamp: current.cacheTimestamp,
        policy: current.policy,
        condemned: current.condemned,
        ...(current.status !== undefined && { status: current.status }),
        ...(current.location !== undefined && { location: current.location }),
      };
}

/**
 * What the commit says of the render's view of the tags: the revision it was brought up to, and what
 * it held of each of the generation's tags, where the runtime says (`heldTagRevisions`). A runtime
 * from before that says nothing of it, and the authority judges its commit as one whose view held
 * no tag. Read through a shape of this host's own, which the runtime it is built beside matches
 * whether it says it or not.
 */
function viewOf(request: {
  readonly observedTagRevision: number;
  readonly heldTagRevisions?: Readonly<Record<string, number>> | undefined;
}): Pick<GatewayCommitRequest, 'observedTagRevision' | 'heldTagRevisions'> {
  return {
    observedTagRevision: request.observedTagRevision,
    ...(request.heldTagRevisions !== undefined && { heldTagRevisions: request.heldTagRevisions }),
  };
}

/**
 * The record a published commit was answered with, decoded from its base64 with the entry and the
 * generation it is of — which its settle may have written for a generation later than the commit's
 * own; `undefined` where the gateway handed none back, or bytes that are no record.
 */
function publishedRecord(base64: string | undefined):
  | {
      readonly bytes: Uint8Array;
      readonly entryId: string;
      readonly seq: number;
      readonly revision: number;
    }
  | undefined {
  if (base64 === undefined) {
    return undefined;
  }
  try {
    const bytes = fromBase64(base64);
    const decoded = decodeGenerationPack(bytes);
    if (decoded.kind !== 'ok') {
      return undefined;
    }
    const { entryId, seq, revision } = decoded.pack.header;
    return { bytes, entryId, seq, revision };
  } catch {
    return undefined;
  }
}

/**
 * How many leases a host remembers the entry of, for a commit that hands back no record; past it,
 * the oldest is let go of with its entry's copy (`#remember`).
 */
const MAX_LEASES_REMEMBERED = 256;

/** What a host remembers of a lease: its entry, and the generation that stood when it was granted. */
interface LeaseHeld {
  readonly entryId: string;
  readonly seq: number;
}

/** The data center's copies this host keeps, where the Worker has a Cache API. */
interface Copies {
  /** Of the values this Function wrote to the data cache. */
  readonly data: DataCopies | undefined;
  /** Of the delivery records its commits wrote. */
  readonly records: RecordCopies | undefined;
  /** Of where the scope's tags stand, where the host asks for one (`CacheHostOptions`). */
  readonly beacon: ScopeBeacon | undefined;
}

/**
 * The value the authority holds now (`currentData`), where it is later than `than`: asked past it,
 * so the authority reads nothing of a value that is not, and checked here against an authority from
 * before it was asked so.
 */
async function currentLaterThan(
  gateway: Gateway,
  request: DataReadRequest,
  than: number,
): Promise<DataGetResponse | undefined> {
  const current = await gateway.currentData({ ...request, than });
  return current !== undefined && current.dependencyRevision > than ? current : undefined;
}

/**
 * Keep the later value the authority answers (`currentData`) as the data center's copy once it
 * comes; nothing where it brings none or fails, which the runtime is told of through what
 * `getNewerData` answers.
 */
async function keptOnceAnswered(
  copies: DataCopies,
  request: DataReadRequest,
  answer: Promise<DataGetResponse | undefined>,
): Promise<void> {
  let current: DataGetResponse | undefined;
  try {
    current = await answer;
  } catch {
    return;
  }
  if (current !== undefined) {
    await copies.keepCurrent(request, current);
  }
}

/**
 * The gateway behind the interface the runtime asks through, and the data center's copies of the
 * values this Function wrote and of the records its commits wrote (`Copies`).
 */
class GatewayHost implements CacheHost {
  readonly #gateway: Gateway;
  readonly #copies: DataCopies | undefined;
  readonly #records: RecordCopies | undefined;
  readonly #beacon: ScopeBeacon | undefined;
  /**
   * The entry each lease of this isolate's still out was for, and the generation that stood when it
   * was granted, by attempt, oldest first: what a commit that hands back no record lets the data
   * center's copy of go. A lease leaves it once it has ended — committed, refused or failed — so
   * that the bound lets go only of leases long out.
   */
  readonly #leased = new Map<string, LeaseHeld>();

  constructor(gateway: Gateway, copies: Copies) {
    this.#gateway = gateway;
    this.#copies = copies.data;
    this.#records = copies.records;
    this.#beacon = copies.beacon;
  }

  /**
   * Remember the entry a lease is for. Past the bound the oldest is let go of, though it may still be
   * out, and its entry's copy with it, behind the response: once its commit is answered with no
   * record, nothing would say which entry's copy to let go of. As for a commit whose answer never
   * came (`#committed`), the copy of what stood when it was granted goes, or of anything earlier.
   */
  #remember(attemptId: string, held: LeaseHeld): void {
    this.#leased.set(attemptId, held);
    for (const [oldest, lease] of this.#leased) {
      if (this.#leased.size <= MAX_LEASES_REMEMBERED) {
        break;
      }
      this.#leased.delete(oldest);
      const letGo = this.#records?.drop(lease.entryId, { seq: lease.seq + 1, revision: 0 });
      if (letGo !== undefined) {
        behindResponse(letGo);
      }
    }
  }

  /**
   * One request of an invalidation to the authority: `tags`, as many as a request carries at the
   * most, with the moment the runtime put the invalidation in force, which the authority records it
   * at (`inForceAt`), and — where `more` of its chunks follow — a word that they do.
   */
  #invalidateChunk(
    request: InvalidateRequest,
    tags: readonly string[],
    more = false,
  ): Promise<GatewayInvalidateResponse> {
    return this.#gateway.invalidate({
      tags: tags.map((value) => ({ value })),
      ...(request.expire !== undefined && { expire: request.expire }),
      cause: { source: 'app-worker', api: request.api },
      // When the runtime put it in force, which the authority records it at: each chunk the same.
      ...(request.inForceAt !== undefined && { inForceAt: request.inForceAt }),
      ...(more && { more }),
    });
  }

  /** Next groups all pending tags by profile; the authority bounds each request, not the group. */
  async #invalidateChunks(
    request: InvalidateRequest,
    tags: readonly string[],
  ): Promise<GatewayInvalidateResponse> {
    let revision = 0;
    const invalidations: GatewayInvalidateResponse['invalidations'] = [];
    const affectedEntryIds = new Set<string>();
    for (let offset = 0; offset < tags.length; offset += MAX_TAGS_PER_CALL) {
      // One authority write at a time bounds fanout and preserves write ordering; each but the last
      // says more follow, so that the response waits for the host's telling once (`more`).
      const outcome = await this.#invalidateChunk(
        request,
        tags.slice(offset, offset + MAX_TAGS_PER_CALL),
        offset + MAX_TAGS_PER_CALL < tags.length,
      );
      // The latest bound conservatively fences every hard-invalidated tag. A lower bound could
      // allow a generation written between these requests to escape a later invalidation.
      revision = Math.max(revision, outcome.revision);
      invalidations.push(...outcome.invalidations);
      for (const entryId of outcome.affectedEntryIds) affectedEntryIds.add(entryId);
    }
    // A failed chunk throws instead of claiming every tag was recorded. The runtime retains
    // its local marks and logs the failure without replaying the application's SQL.
    return { revision, invalidations, affectedEntryIds: [...affectedEntryIds] };
  }

  /**
   * The gateway's answer to a commit. One that never came leaves the commit's outcome unknown: it
   * may have published a generation later than the one that stood when the lease was granted, and a
   * copy of that one, or an earlier, goes.
   */
  async #committed(
    attemptId: string,
    lease: LeaseHeld | undefined,
    request: Parameters<Gateway['commit']>[1],
  ): Promise<Awaited<ReturnType<Gateway['commit']>>> {
    try {
      return await this.#gateway.commit(attemptId, request);
    } catch (error) {
      if (lease !== undefined) {
        await this.#records?.drop(lease.entryId, { seq: lease.seq + 1, revision: 0 });
      }
      throw error;
    }
  }

  async startAttempt(request: AttemptRequest): Promise<AttemptOutcome> {
    const answer = await this.#gateway.startAttempt({
      entry: request.entry,
      reason: request.reason,
      // The gateway records what produced a generation; for the runtime that is always an attempt.
      producer: { kind: 'attempt', reason: request.reason },
      ...(request.observation !== undefined && { observation: request.observation }),
      ...(request.replaces !== undefined && { replaces: request.replaces }),
    });
    if (answer.kind === 'leased') {
      this.#remember(answer.attemptId, { entryId: answer.entryId, seq: answer.current?.seq ?? 0 });
    }
    // The record of a later generation than the one judged, where the gateway handed it back: the
    // runtime answers from it, checking it as it checks any record.
    const record = publishedRecord(answer.record)?.bytes;
    return answer.kind === 'leased'
      ? {
          kind: 'leased',
          attemptId: answer.attemptId,
          entryId: answer.entryId,
          fencingToken: answer.fencingToken,
          leaseExpiresAt: answer.leaseExpiresAt,
          current: currentOf(answer.current),
          ...(record !== undefined && { record }),
        }
      : {
          kind: 'busy',
          current: currentOf(answer.current),
          attemptId: answer.attemptId,
          leaseExpiresAt: answer.leaseExpiresAt,
          ...(record !== undefined && { record }),
        };
  }

  uploadArtifact(upload: ArtifactUpload): Promise<UploadedArtifact> {
    return this.#gateway.uploadArtifact(upload);
  }

  uploadArtifacts(uploads: readonly ArtifactUpload[]): Promise<readonly UploadedArtifact[]> {
    return this.#gateway.uploadArtifacts(uploads);
  }

  async heartbeat(attemptId: string, fencingToken: number): Promise<void> {
    await this.#gateway.heartbeat(attemptId, fencingToken);
  }

  async commit(attemptId: string, request: CommitRequest): Promise<CommitOutcome> {
    const { generation } = request;
    const lease = this.#leased.get(attemptId);
    this.#leased.delete(attemptId);
    const committed = await this.#committed(attemptId, lease, {
      fencingToken: request.fencingToken,
      ...viewOf(request),
      generation: {
        cacheTimestamp: generation.cacheTimestamp,
        producedAt: generation.producedAt,
        policy: generation.policy,
        status: generation.status,
        headers: generation.headers,
        tags: [...generation.tags],
        outputs: generation.outputs.map((output) => committedOutput(output)),
        dependencies: [...DEPENDENCIES],
        dependencyCoverage: DEPENDENCY_COVERAGE,
        producer: { kind: 'attempt', reason: generation.reason },
      },
    });
    if (committed.kind !== 'published') {
      // Which refusal it was is the gateway's word, and is logged rather than acted on.
      return { kind: 'refused', reason: committed.kind };
    }
    const record = publishedRecord(committed.record);
    const entryId = record?.entryId ?? lease?.entryId;
    if (record === undefined) {
      // A copy of an earlier generation than this one would answer a read KV is behind on although
      // the authority holds this one, and a copy of this one may hold its record from before a
      // change that has rewritten it since — an invalidation's, which is why no record came back:
      // both go, up to the revision the authority says the record stands at. A copy of that
      // record, or a later one, which another commit may have handed back meanwhile, stays; where
      // the authority says none, every copy of this generation goes.
      if (entryId !== undefined) {
        const than =
          committed.recordRevision === undefined
            ? { seq: committed.seq + 1, revision: 0 }
            : { seq: committed.seq, revision: committed.recordRevision };
        await this.#records?.drop(entryId, than);
      }
      return { kind: 'published', generationId: committed.generationId };
    }
    await this.#records?.keep(record.entryId, record.bytes, record);
    return { kind: 'published', generationId: committed.generationId, record: record.bytes };
  }

  async fail(attemptId: string, request: FailRequest): Promise<void> {
    // A lease given up publishes nothing, whatever the gateway answers.
    this.#leased.delete(attemptId);
    await this.#gateway.fail(attemptId, {
      fencingToken: request.fencingToken,
      outcome: request.outcome,
      // The gateway records whatever word the runtime gave the failure; it enumerates none.
      ...(request.error !== undefined && { error: request.error }),
    });
  }

  readRecord(entryId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    return this.#gateway.readRecord(entryId, signal);
  }

  /** The data center's copy of a record a commit of this Function wrote, where it is later. */
  async readNewerRecord(entryId: string, than: number): Promise<Uint8Array | undefined> {
    return await this.#records?.find(entryId, than);
  }

  readArtifact(artifactId: string): Promise<Uint8Array | undefined> {
    return this.#gateway.readArtifact(artifactId);
  }

  /** The value KV answers with, or where it has none, the data center's copy of one written. */
  async getData(request: DataReadRequest): Promise<DataRead | undefined> {
    const answer = await this.#gateway.getData(request);
    return answer ?? (await this.#copies?.find(request));
  }

  /**
   * A value of the key later than `than`: the data center's copy of one written here or kept by an
   * isolate before, or, where it holds none later, the value the authority holds now
   * (`currentData`), kept as the data center's copy behind the answer for the isolates after this
   * one. Asked only of a value the runtime read stale or expired, whose wait it bounds: KV answers
   * here with what it read for half a minute, so a value another data center has written since is
   * read nowhere here but from the authority, and each isolate here would compute it again — and
   * differently. An answer that comes after the runtime stopped waiting is kept all the same. A
   * copy the runtime then finds no better than stale — written here before an invalidation it knows
   * of — it asks past (`laterIfAny`), and the authority answers that.
   */
  async getNewerData(request: DataReadRequest, than: number): Promise<DataRead | undefined> {
    const copy = await this.#copies?.find(request);
    if (copy !== undefined && copy.dependencyRevision > than) {
      return copy;
    }
    const later = currentLaterThan(this.#gateway, request, than);
    const copies = this.#copies;
    if (copies !== undefined) {
      // Kept going from the moment it is asked, not from its answer: the runtime waits for that
      // only so long, and the response it is under can end first.
      behindResponse(keptOnceAnswered(copies, request, later));
    }
    return later;
  }

  /** The write, once the authority has taken it, kept in the data center as well. */
  async setData(request: DataWriteRequest): Promise<DataWritten> {
    const sent: DataSetRequest = {
      key: request.key,
      entry: {
        ...request.entry,
        tags: [...request.entry.tags],
        dependencyCoverage: DEPENDENCY_COVERAGE,
      },
      valueBase64: request.valueBase64,
      ...(request.order !== undefined && { order: request.order }),
    };
    const written = await this.#gateway.setData(sent);
    await this.#copies?.keep(sent, written);
    return written;
  }

  getTags(tags: readonly string[]): Promise<TagInvalidations> {
    return this.#gateway.getTags(tags);
  }

  /**
   * The runtime's tags are Next.js's. The authority's delta holds the edge's as well, and a
   * platform-delivery tag may carry the same value as one of them: it expires no value of the data
   * cache, so it is left out here, the revision moving past it all the same.
   */
  async tagsDelta(since: number): Promise<TagDelta> {
    const delta = await this.#gateway.tagsDelta(since);
    return { ...delta, tags: delta.tags.filter((tag) => tag.kind === tagKindOf(tag.value)) };
  }

  /** Where the scope's tags stand, as the data center's copy says (`ScopeBeacon`), if one is kept. */
  async scopeRevision(): Promise<ScopeRevision | undefined> {
    return await this.#beacon?.read();
  }

  invalidate(request: InvalidateRequest): Promise<InvalidateOutcome> {
    const tags = [...new Set(request.tags)];
    if (tags.length <= MAX_TAGS_PER_CALL) return this.#invalidateChunk(request, tags);
    return this.#invalidateChunks(request, tags);
  }
}

/**
 * A host's `createCacheHost`, under the names it keeps the artifacts' copies by: the cache these
 * bindings reach, or nothing when they name none — a deployment given no cache, which the runtime
 * then runs without.
 *
 * The write gateway, the scope's token and the deployment id are all required: the token opens one
 * scope and no other, and the id *is* the scope. The read gateway is optional, and reads go to the
 * authority when there is none.
 */
export function cacheHostFor(
  naming: FunctionCacheNaming,
  options: CacheHostOptions = {},
): (init: CacheHostInit) => CacheHostBinding | undefined {
  return (init) => createCacheHost(naming, init, options);
}

/** What a host decides beside its names. */
export interface CacheHostOptions {
  /**
   * Whether the Function keeps its data center's copy of where its scope's tags stand, asked of
   * the authority again every moment it has traffic (`ScopeBeacon`): for a host with nothing in
   * front of its Functions that says it on every request (`SCOPE_REVISION_HEADER`). Off unless
   * asked for, since it is a question to the authority from every data center a deployment is
   * served from, every moment.
   */
  readonly scopeBeacon?: boolean | undefined;
}

function createCacheHost(
  naming: FunctionCacheNaming,
  init: CacheHostInit,
  options: CacheHostOptions,
): CacheHostBinding | undefined {
  const write = transportFor(init.env, WRITE_GATEWAY, init.fetchImpl);
  const token = stringBinding(init.env, CACHE_TOKEN_BINDING);
  const scopeId = stringBinding(init.env, DEPLOYMENT_ID_BINDING);
  if (write === undefined || token === undefined || scopeId === undefined) {
    return undefined;
  }
  const read = transportFor(init.env, READ_GATEWAY, init.fetchImpl);
  const gateway = new Gateway({
    naming,
    gatewayUrl: write.url,
    readGatewayUrl: read?.url,
    scopeId,
    token,
    fetchImpl: write.fetchImpl,
    readFetchImpl: read?.fetchImpl,
  });
  return {
    host: new GatewayHost(gateway, {
      data: DataCopies.of(naming, { scopeId, token }, gateway.reading),
      records: RecordCopies.of(naming, { scopeId, token }, gateway.reading),
      beacon:
        options.scopeBeacon === true
          ? ScopeBeacon.of(naming, { scopeId, token }, () => gateway.tagRevision())
          : undefined,
    }),
    scopeId,
    clockOf: clockReader(init.env),
  };
}
