import type {
  ArtifactRole,
  CachePolicy,
  EntryDescriptor,
  GenerationTag,
  InvalidationState,
  OutputCompute,
  OutputResponse,
} from '@stayingupwind/core/cache';
import type { ScopeRevision } from '@stayingupwind/core/paas';

/**
 * The cache a deployment's Function takes part in, as this runtime speaks to it.
 *
 * The runtime keeps no cache of its own. It derives an entry's identity, judges what it reads
 * against the tags it has synced, renders a generation and says what the generation is made of —
 * and hands every read and every write to a host that stores them. What that host is, where it
 * lives and how it is reached is the host's business: this interface is the whole of what the
 * runtime needs from one, and a deployment whose Function was given no host runs as it did before
 * any cache existed, answering every read a miss.
 *
 * Two things are deliberately not here. **Transport**: a host is handed the Function's environment
 * and finds its own way to whatever stores the entries, so nothing about a URL, a binding or a
 * credential appears in this file. **Bookkeeping the runtime does not read**: a response type
 * below holds the fields the runtime acts on and no others, and a request type omits what the
 * host can supply itself, so that neither side is held to a shape the other invented.
 *
 * An entry is the logical thing a new generation replaces: a route's output, or one value of the
 * data cache. A generation is published through an *attempt* — a lease taken on the entry, so two
 * Functions cannot both publish for it, with a fencing token that says which lease a call belongs
 * to and a heartbeat that says the holder is still working. The host decides how long a lease
 * lasts and what happens to an expired one; the runtime only reports what it did with its own.
 */
export interface CacheHost {
  /**
   * Take the lease on an entry and start an attempt at a new generation, or say that another
   * holder has it. `busy` is not a failure: the other holder is publishing the same thing.
   */
  startAttempt(request: AttemptRequest): Promise<AttemptOutcome>;

  /**
   * Store one body the attempt's generation will be made of. Called once per representation —
   * the document, its RSC payload, each segment — before the commit that names them.
   */
  uploadArtifact(upload: ArtifactUpload): Promise<UploadedArtifact>;

  /** Say the attempt is still going, so the lease is not given to someone else. */
  heartbeat(attemptId: string, fencingToken: number): Promise<void>;

  /** Publish what the attempt rendered as the entry's current generation, or say why not. */
  commit(attemptId: string, request: CommitRequest): Promise<CommitOutcome>;

  /**
   * End the attempt without a generation. `skipped` is an attempt that found nothing new to
   * publish and is not a failure; `failed` says the render did not produce one.
   */
  fail(attemptId: string, request: FailRequest): Promise<void>;

  /**
   * The delivery record of an entry's current generation — the bytes the edge would serve — or
   * nothing when the entry has no generation. The runtime reads this when it answers a document
   * itself, so that what it serves is what the edge would have served. A read the runtime has given
   * up on is called off through `signal`.
   */
  readRecord(entryId: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;

  /**
   * The delivery record of a generation of the entry later than the one at `than` (its `seq`; 0
   * where the runtime holds none), where the host keeps one nearer than `readRecord` reaches — a
   * copy, in the Function's own data center, of a generation one of its isolates published — or
   * nothing. A host whose reads are cached can answer `readRecord` with the generation a later one
   * replaced, or with none, for as long as its cache keeps that answer; the runtime asks this only
   * of an entry it found so, missing or no longer fresh, and never of one it is about to serve
   * fresh. Optional: a host that keeps no such copy is read through `readRecord` alone.
   */
  readNewerRecord?(entryId: string, than: number): Promise<Uint8Array | undefined>;

  /** The bytes of an artifact by id: a value too large to have travelled inline. */
  readArtifact(artifactId: string): Promise<Uint8Array | undefined>;

  /**
   * One value of the data cache, or nothing when the host holds none under that key. A host that
   * keeps values nearer than its read (`getNewerData`) answers a miss from them here: a value
   * later than none needs weighing against nothing, and the runtime asks nothing more of a miss.
   */
  getData(request: DataReadRequest): Promise<DataRead | undefined>;

  /**
   * A value of the key written later than the one at `than` (its `dependencyRevision`), where the
   * host keeps one nearer than `getData` reaches, or nothing: what `readNewerRecord` is to a
   * record. Asked only of a value the runtime found stale or expired — a miss is `getData`'s to
   * answer from the same. Optional.
   */
  getNewerData?(request: DataReadRequest, than: number): Promise<DataRead | undefined>;

  /** Store one value of the data cache. */
  setData(request: DataWriteRequest): Promise<DataWritten>;

  /** The invalidations recorded against these tags, whatever their age. */
  getTags(tags: readonly string[]): Promise<TagInvalidations>;

  /**
   * Every invalidation recorded since `since`, and the revision to ask from next time. A
   * truncated answer is asked again from the revision it reached.
   */
  tagsDelta(since: number): Promise<TagDelta>;

  /** Record an invalidation against these tags, and say what it made of each. */
  invalidate(request: InvalidateRequest): Promise<InvalidateOutcome>;

  /**
   * Where the scope's tags stand, as the host knows it nearby and at once: the revision of the
   * latest invalidation, and when it was recorded — or nothing it can say without a wait. Asked at
   * the start of a request that came without `SCOPE_REVISION_HEADER`, so a host that can say sooner
   * than its reads of the tags reflect an invalidation lets a Function behind it catch up before
   * the request is judged (`catchUpWithScope`). Optional: without it, an isolate hears of another's
   * invalidation through its reads, as before. Never rejects.
   */
  scopeRevision?(): Promise<ScopeRevision | undefined>;
}

/**
 * A call the host refused, as the runtime reports it.
 *
 * `code` is the host's own word for the refusal and is only ever logged: nothing the runtime does
 * next depends on which refusal it was, so no set of codes is agreed here.
 */
export class CacheHostError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: CacheHostErrorOptions) {
    super(message, options);
    this.name = 'CacheHostError';
    this.code = options.code;
    this.status = options.status;
  }
}

export interface CacheHostErrorOptions extends ErrorOptions {
  readonly code: string;
  readonly status: number;
}

/**
 * Why an attempt is being made: what the runtime found when it decided to regenerate. Carried to
 * the host, which records it; nothing it answers depends on which of them it was.
 */
export type AttemptReason = 'stale' | 'expired' | 'miss' | 'invalidated' | 'manual';

/** What the edge served when it asked for a regeneration: recorded, never acted on. */
export interface ServedObservation {
  readonly generationId: string;
  readonly colo?: string | undefined;
  readonly at: number;
}

export interface AttemptRequest {
  readonly entry: EntryDescriptor;
  readonly reason: AttemptReason;
  readonly observation?: ServedObservation | undefined;
}

/**
 * The entry's current generation as the host sums it up when it answers for a lease: enough to tell
 * whether it is the generation the runtime judged, and whether it may still be served.
 */
export interface CurrentSummary {
  readonly generationId: string;
  readonly seq: number;
  readonly cacheTimestamp: number | null;
  readonly policy: CachePolicy;
  /** Set once an invalidation condemned it. */
  readonly condemned: InvalidationState | null;
  /**
   * The status it answers with, and the `location` it redirects to, `null` for none: what says
   * whether a visitor may be answered with it (`servable`). Absent from a host that does not say,
   * and then nothing is taken to supersede the generation a request judged.
   */
  readonly status?: number | undefined;
  readonly location?: string | null | undefined;
}

/** The lease, or the word that another holder has it; either way the entry's id is known. */
export type AttemptOutcome =
  | {
      readonly kind: 'leased';
      readonly attemptId: string;
      readonly entryId: string;
      /** Says which lease a later call belongs to; the host refuses one from an older lease. */
      readonly fencingToken: number;
      /** When the lease lapses unless a heartbeat renews it, by the host's clock. */
      readonly leaseExpiresAt: number;
      /**
       * The entry's generation as it stands, `null` for none; absent from a host that does not
       * say. A runtime that judged an earlier one gives the lease back (`regenerate`).
       */
      readonly current?: CurrentSummary | null | undefined;
    }
  | { readonly kind: 'busy'; readonly current?: CurrentSummary | null | undefined };

export interface ArtifactUpload {
  readonly attemptId: string;
  readonly fencingToken: number;
  readonly role: ArtifactRole;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface UploadedArtifact {
  readonly sha256: string;
  readonly byteLength: number;
}

/** One stored body of a generation, as the commit names it. */
export interface CommitArtifact {
  readonly role: ArtifactRole;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: string;
}

/**
 * One thing a generation can be asked for: the document itself, its RSC payload, a segment, a
 * Pages Router page's data. `representationKey` is what a reader asks by.
 *
 * `compute` and `response` are what the render made of it — a shell that stopped at a postponed
 * boundary is `resuming` and `initial`, a render that finished is `static` and `complete` — and
 * they are here because only the runtime knows which it produced.
 */
export interface CommitOutput {
  readonly representationKey: string;
  readonly pathname: string | null;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly compute: OutputCompute;
  readonly response: OutputResponse;
  /** The document's size, or `null` where the output is not a document. */
  readonly htmlSize: number | null;
  readonly artifacts: readonly CommitArtifact[];
}

export interface CommitGeneration {
  /** The instant the generation's freshness is measured from. */
  readonly cacheTimestamp: number;
  readonly producedAt: number;
  readonly policy: CachePolicy;
  readonly status: number;
  /** The headers the generation is answered with, already filtered. */
  readonly headers: Readonly<Record<string, string>>;
  readonly tags: readonly GenerationTag[];
  readonly outputs: readonly CommitOutput[];
  /** Why the attempt ran; carried so the host can record what produced the generation. */
  readonly reason: AttemptReason;
}

export interface CommitRequest {
  readonly fencingToken: number;
  /** The tag revision the render had synced when it read its inputs. */
  readonly observedTagRevision: number;
  readonly generation: CommitGeneration;
}

/**
 * What the commit did. `refused` carries the host's word for why, which is logged and returned;
 * the runtime keeps the entry it had either way.
 */
export type CommitOutcome =
  | {
      readonly kind: 'published';
      readonly generationId: string;
      /**
       * The delivery record the host wrote for the generation, where it hands it back: what the
       * isolate that published it answers the entry's next request from, rather than a read that
       * may still find the generation it replaced (`readRecord`).
       */
      readonly record?: Uint8Array | undefined;
    }
  | { readonly kind: 'refused'; readonly reason: string };

export interface FailRequest {
  readonly fencingToken: number;
  readonly outcome: 'failed' | 'skipped';
  readonly error?: { readonly code: string; readonly message: string } | undefined;
}

/** The `CacheEntry` fields of Next.js's cache-handler contract, as the data cache keeps them. */
export interface DataEntryMetadata {
  readonly kind: 'data:fetch' | 'data:use-cache';
  /** The kind of `use cache` the value belongs to; absent for the fetch cache. */
  readonly handler?: string | undefined;
  readonly tags: readonly string[];
  readonly stale: number;
  readonly timestamp: number;
  readonly expire: number;
  readonly revalidate: number;
}

export interface DataReadRequest {
  readonly key: string;
  readonly kind: DataEntryMetadata['kind'];
  readonly handler?: string | undefined;
}

/** A value inline, or the id of the artifact holding one too large to travel inline. */
export type DataValue =
  | { readonly kind: 'inline'; readonly base64: string }
  | { readonly kind: 'ref'; readonly artifactId: string };

export interface DataRead {
  readonly entryId: string;
  readonly generationId: string;
  /** The revision the value was read at: the floor a later read of it may not fall below. */
  readonly dependencyRevision: number;
  readonly entry: DataEntryMetadata;
  readonly value: DataValue;
  /** Set once an invalidation has touched the entry; what the tag delta will say too. */
  readonly invalidation?: InvalidationState | undefined;
}

export interface DataWriteRequest {
  readonly key: string;
  readonly entry: DataEntryMetadata;
  readonly valueBase64: string;
  /**
   * Where the write stands among the writes this isolate sent: an id the isolate drew for itself,
   * and a count it raises with each write. Writes of a key can cross on their way to the host — one
   * held up behind its upload, or sent once its writer would wait no longer for the one before it
   * — and the host keeps a writer's later write over its earlier one, whichever lands last
   * (`DataWritten.superseded`).
   */
  readonly order?: { readonly writer: string; readonly seq: number } | undefined;
}

export interface DataWritten {
  readonly entryId: string;
  readonly generationId: string;
  readonly revision: number;
  /**
   * Set when the write landed on the entry's current generation and an invalidation had touched
   * it since: what a read of the entry would say too, so the value is remembered as stale rather
   * than as freshly written.
   */
  readonly invalidation?: InvalidationState | undefined;
  /**
   * Set when the entry already held a value its writer sent after this one (`order`), which the
   * host kept: nothing was written, and the generation named is that value's. The writer then does
   * not remember what it wrote as the entry's.
   */
  readonly superseded?: true | undefined;
}

/**
 * A tag's latest invalidation: from when what carries the tag is stale, and until when it may
 * still be served — `null` for a deadline the invalidation did not set.
 */
export interface TagInvalidation {
  readonly value: string;
  readonly staleAt: number;
  readonly hardExpireAt: number | null;
}

export interface TagInvalidations {
  readonly tags: readonly TagInvalidation[];
}

export interface TagDelta extends TagInvalidations {
  /** The revision the delta was read at: the next `since`. */
  readonly revision: number;
  /** Set when more remains past what this answer holds. */
  readonly truncated: boolean;
}

export interface InvalidateRequest {
  readonly tags: readonly string[];
  /** Seconds the stale content may still be served; absent means at once. */
  readonly expire?: number | undefined;
  /** Which of Next.js's APIs asked, for the record the host keeps. */
  readonly api: 'revalidateTag' | 'updateTag';
}

export interface InvalidateOutcome {
  readonly invalidations: readonly TagInvalidation[];
  /**
   * The revision of the scope the host recorded the invalidation at, where it keeps one: every record
   * it wrote before is at a lower revision, and one written after at a higher. Absent from a host
   * that keeps no revisions.
   */
  readonly revision?: number | undefined;
}

/** How a host is reached; the runtime holds one per isolate. */
export interface CacheHostBinding {
  readonly host: CacheHost;
  /**
   * The scope an entry's id is derived within, so the same URL in two deployments is two
   * entries and neither can read the other's.
   */
  readonly scopeId: string;
  /**
   * The clock this request acts at, where the host's configuration lets a request name one —
   * a test moving time without waiting. Nothing else may name a clock, so a host that honours
   * none answers `undefined` and every decision follows the wall clock.
   */
  readonly clockOf: (request: Request) => number | undefined;
}

/**
 * What a host module answers: how the cache is reached, or nothing when these bindings reach
 * none. Named rather than written as a union at the ambient declaration of `arkor:cache-host`,
 * where a union of a type that module cannot resolve reads as `any`.
 */
export type CacheHostLookup = CacheHostBinding | undefined;

export type FetchLike = (request: Request) => Promise<Response>;

/**
 * What a host is given beside the interface it implements.
 *
 * `nativeFetch` is the platform's own `fetch`, and a host that goes out over one must use it:
 * the global is replaced by the time the application renders, and a call made through the
 * replacement from inside a prerender is dynamic I/O that hangs until the prerender aborts. It is
 * captured where its ordering is guaranteed — this module is evaluated before any of Next.js —
 * rather than in each host.
 *
 * `requestClock` is the clock the request was given, for a host that records or forwards it.
 */
export { nativeFetch } from './native.ts';
export { requestClock } from './clock.ts';

export interface CacheHostInit {
  /** The Function's own environment, unread by the runtime and passed through as it arrived. */
  readonly env: Record<string, unknown> | undefined;
  /**
   * Stands in for the way *out*, and for nothing else: what a test or a local bench puts in
   * place of `fetch`. A host reached through a binding is not reached this way.
   */
  readonly fetchImpl?: FetchLike | undefined;
}
