import { sha256HexSchema } from '@stayingupwind/core/artifact';
import {
  artifactEncodingSchema,
  artifactRoleSchema,
  cachePolicySchema,
  entryDescriptorSchema,
  headerValuesSchema,
  invalidationStateSchema,
  MAX_TAG_LENGTH,
  MAX_TAG_HISTORY,
  MAX_TAGS_PER_CALL,
  MAX_TAGS_PER_ENTRY,
  outputComputeSchema,
  outputResponseSchema,
  tagKindSchema,
  generationTagSchema,
} from '@stayingupwind/core/cache';
import * as z from '@stayingupwind/core/schema';

import {
  attemptErrorSchema,
  attemptReasonSchema,
  cacheEntryStateSchema,
  dependencyCoverageSchema,
  dependencyEvidenceSchema,
  dependencyUsageSchema,
  generationProducerSchema,
  invalidationCauseSchema,
  invalidationMeaningSchema,
  publicCacheGenerationSchema,
  regenerationStateSchema,
} from './entities.ts';

/**
 * The HTTP contract between an application's Worker and the cache gateway.
 *
 * Every route lives under `/v1/scopes/<scopeId>/` and carries the scope's token as a bearer; the
 * gateway answers `{ ok: true, result }` or `{ ok: false, error }`. The Function's cache host
 * (`@stayingupwind/cache`, `function/`) and the gateway import these same schemas, so what one sends
 * is what the other reads. The runtime imports none of them: it hands its writes to the cache host
 * (`CacheHost`), whose own shapes leave out what only the host can say of a write, and the host
 * fills that in before it sends one: how each artifact was stored (`encoding`), and what a
 * generation depends on (`dependencies`, `dependencyCoverage`).
 *
 * Written with core's validator (`@stayingupwind/core/schema`) rather than zod, as `entities.ts` is:
 * the cache host checks every answer against these, and builds them as its module is evaluated,
 * before an application's first answer. What composes them into zod schemas of its own takes them
 * through `toZod`.
 */

export const GATEWAY_API_VERSION = 'v1';
/** The scope a request acts on, repeated in a header so a token is checked against the URL it is used with. */
export const CACHE_SCOPE_HEADER = 'x-arkor-cache-scope';
export const ARTIFACT_ROLE_HEADER = 'x-arkor-artifact-role';
export const ARTIFACT_ENCODING_HEADER = 'x-arkor-artifact-encoding';
export const ARTIFACT_SHA256_HEADER = 'x-arkor-sha256';
export const FENCING_TOKEN_HEADER = 'x-arkor-fencing-token';

const KIB = 1024;
const INLINE_DATA_VALUE_KIB = 512;
/** A data-cache value up to this size travels inline in JSON; a larger one is stored as an artifact. */
export const MAX_INLINE_DATA_VALUE_BYTES = INLINE_DATA_VALUE_KIB * KIB;
const DATA_KEY_KIB = 64;
/**
 * The longest key a data-cache value is stored under, in UTF-16 code units. Next.js's own key for a
 * `use cache` function is its arguments, serialized, so it is as long as they are, and it has no
 * limit of its own; this one is far past any key the handlers are likely to be given, and small
 * beside the value that travels with it. Only its digest is kept.
 */
export const MAX_DATA_KEY_LENGTH = DATA_KEY_KIB * KIB;
/**
 * The longest handler name a data-cache value is recorded under: the kind of `use cache` —
 * `default`, `remote`, or a key of `next.config`'s `cacheHandlers` — which is an identifier. Bounded
 * as a tag is, so that what a request can carry beside its value has a size to be read up to.
 */
export const MAX_DATA_HANDLER_LENGTH = 256;

/**
 * What the gateway answers a request for a route it does not have, a 404 `not_found`: told apart
 * from the `not_found` of something a route looked for — an attempt, an entry — by a client asking
 * a route a gateway from before it may not have (`POST /attempts/:attemptId/artifacts`).
 */
export const NO_SUCH_ENDPOINT = 'no such endpoint';

export function gatewayScopePath(scopeId: string): string {
  return `/${GATEWAY_API_VERSION}/scopes/${encodeURIComponent(scopeId)}`;
}

export const gatewayErrorCodeSchema = z.enum([
  'unauthorized',
  'scope_retired',
  'invalid_request',
  'not_found',
  'superseded',
  'lease_expired',
  'stale_dependencies',
  'quota_exceeded',
  'artifact_missing',
  'artifact_mismatch',
  'too_large',
  'internal',
]);
export type GatewayErrorCode = z.infer<typeof gatewayErrorCodeSchema>;

export const gatewayErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: gatewayErrorCodeSchema, message: z.string() }),
});
export type GatewayError = z.infer<typeof gatewayErrorSchema>;

export function gatewayResultSchema<const T extends z.Schema>(
  result: T,
): z.UnionSchema<
  readonly [
    z.ObjectSchema<{ readonly ok: z.ValueSchema<true>; readonly result: T }, 'strip'>,
    typeof gatewayErrorSchema,
  ]
> {
  return z.union([z.object({ ok: z.literal(true), result }), gatewayErrorSchema]);
}

export const observationInputSchema = z.object({
  generationId: z.string().min(1),
  colo: z.string().optional(),
  at: z.number().int(),
});
export type ObservationInput = z.infer<typeof observationInputSchema>;

/** `POST /attempts` */
export const startAttemptRequestSchema = z.object({
  entry: entryDescriptorSchema,
  allowQuery: z.array(z.string()).optional(),
  reason: attemptReasonSchema,
  producer: generationProducerSchema.optional(),
  /** What the edge served when it asked: recorded as an observation, never as state. */
  observation: observationInputSchema.optional(),
  /**
   * The generation the requester judged the entry by, `null` for none: where the entry's current
   * generation is a later one that stands, the answer carries its delivery record (`record`).
   */
  replaces: z.string().min(1).nullable().optional(),
});
export type StartAttemptRequest = z.infer<typeof startAttemptRequestSchema>;

export const currentGenerationSummarySchema = z.object({
  generationId: z.string().min(1),
  seq: z.number().int().positive(),
  cacheTimestamp: z.number().int().nullable(),
  policy: cachePolicySchema,
  condemned: invalidationStateSchema.nullable(),
  /**
   * The status the generation answers with, and where it redirects (`location`, `null` for
   * nowhere): whether a visitor may be answered with it. Absent from an authority that says not.
   */
  status: z.number().int().optional(),
  location: z.string().nullable().optional(),
});
export type CurrentGenerationSummary = z.infer<typeof currentGenerationSummarySchema>;

export const startAttemptResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('leased'),
    attemptId: z.string().min(1),
    entryId: z.string().min(1),
    fencingToken: z.number().int().positive(),
    dependencyRevision: z.number().int().nonnegative(),
    leaseExpiresAt: z.number().int(),
    current: currentGenerationSummarySchema.nullable(),
    /**
     * The delivery record of the generation `current` names, base64, where the request named an
     * earlier one it judged (`replaces`) and this one stands: what the Function answers with rather
     * than a render of its own, where it holds nothing of it yet.
     */
    record: z.string().optional(),
  }),
  z.object({
    kind: z.literal('busy'),
    entryId: z.string().min(1),
    attemptId: z.string().min(1),
    leaseExpiresAt: z.number().int(),
    current: currentGenerationSummarySchema.nullable(),
    /** The record of the generation `current` names, as for a lease handed out. */
    record: z.string().optional(),
  }),
]);
export type StartAttemptResponse = z.infer<typeof startAttemptResponseSchema>;

/** `POST /attempts/:attemptId/heartbeat` */
export const heartbeatRequestSchema = z.object({ fencingToken: z.number().int().positive() });
export const heartbeatResponseSchema = z.object({ leaseExpiresAt: z.number().int() });
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

const BATCHED_ARTIFACT_KIB = 64;
const ARTIFACT_BATCH_KIB = 512;
/**
 * The largest artifact a batch carries (`uploadArtifactsRequestSchema`), how many a batch carries,
 * and how many bytes in all. A batch is an attempt's small outputs in one request — a page's
 * document, payload and segments — which one upload each made a round trip apiece, to the authority
 * and to the blob store, and most of a publish.
 */
export const MAX_BATCHED_ARTIFACT_BYTES = BATCHED_ARTIFACT_KIB * KIB;
export const MAX_BATCHED_ARTIFACTS = 16;
export const MAX_ARTIFACT_BATCH_BYTES = ARTIFACT_BATCH_KIB * KIB;

/**
 * The longest content type a batch's artifact may name: an upload alone names its own in a header,
 * which the runtime's header limits bound, and one in a batch is bound here instead.
 */
export const MAX_BATCHED_CONTENT_TYPE_LENGTH = 256;

/**
 * What a batch's content type may be made of: what an upload alone could carry in its header, which
 * the edge sets on a response serving the artifact — printable ASCII, a space and a tab, none of
 * which JSON escapes to more than two bytes (`BATCH_BODY_BYTES` counts on it).
 */
const HEADER_VALUE = /^[\t\u{20}-\u{7E}]+$/u;

/** One artifact of a batch: what an upload's headers and path say of it, and its bytes in base64. */
export const batchedArtifactSchema = z.object({
  role: artifactRoleSchema,
  sha256: sha256HexSchema,
  contentType: z.string().min(1).max(MAX_BATCHED_CONTENT_TYPE_LENGTH).regex(HEADER_VALUE),
  bytes: z.string(),
});
export type BatchedArtifact = z.infer<typeof batchedArtifactSchema>;

/**
 * `POST /attempts/:attemptId/artifacts`: several of an attempt's artifacts at once, each taken as
 * `PUT /attempts/:attemptId/artifacts/:sha256` takes one, and answered in their order.
 */
export const uploadArtifactsRequestSchema = z.object({
  fencingToken: z.number().int().positive(),
  artifacts: z.array(batchedArtifactSchema).min(1).max(MAX_BATCHED_ARTIFACTS),
});
export type UploadArtifactsRequest = z.infer<typeof uploadArtifactsRequestSchema>;

/** What a batch's artifact came to: its name, and how many bytes it holds. */
const uploadedArtifactSchema = z.object({
  sha256: sha256HexSchema,
  byteLength: z.number().int().nonnegative(),
});

export const uploadArtifactsResponseSchema = z.object({
  artifacts: z.array(uploadedArtifactSchema),
});
export type UploadArtifactsResponse = z.infer<typeof uploadArtifactsResponseSchema>;

/** An artifact the commit names; each must have been uploaded to the attempt first. */
export const commitArtifactSchema = z.object({
  role: artifactRoleSchema,
  sha256: sha256HexSchema,
  byteLength: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  encoding: artifactEncodingSchema,
});
export type CommitArtifact = z.infer<typeof commitArtifactSchema>;

export const commitOutputSchema = z.object({
  representationKey: z.string().min(1),
  pathname: z.string().nullable(),
  status: z.number().int().nullable(),
  headers: headerValuesSchema,
  compute: outputComputeSchema,
  response: outputResponseSchema,
  htmlSize: z.number().int().nonnegative().nullable(),
  artifacts: z.array(commitArtifactSchema),
});
export type CommitOutput = z.infer<typeof commitOutputSchema>;

const tagValueSchema = z.string().min(1).max(MAX_TAG_LENGTH);
const dependencyTargetInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tag'), value: tagValueSchema }),
  z.object({ kind: z.literal('entry'), entryId: z.string().min(1) }),
]);

export const commitDependencySchema = z.object({
  target: dependencyTargetInputSchema,
  observedRevision: z.number().int().nullable(),
  evidence: dependencyEvidenceSchema,
  usage: dependencyUsageSchema,
});
export type CommitDependency = z.infer<typeof commitDependencySchema>;

const LOWEST_RESPONSE_STATUS = 200;
const HIGHEST_RESPONSE_STATUS = 599;
/**
 * The statuses a `Response` may be made with, which a bundle's prerender is held to as well. A
 * generation is answered with its status, so one committed, or seeded, past these is one no host
 * could ever answer with: it would stand as the entry's current generation and serve nothing.
 */
export const responseStatusSchema = z
  .number()
  .int()
  .min(LOWEST_RESPONSE_STATUS)
  .max(HIGHEST_RESPONSE_STATUS);

/**
 * A header a response can be made with, as a bundle's prerender is held to as well: a name that is
 * a token (RFC 9110), and a value `Headers` takes — no NUL, CR or LF, and no character a single
 * byte cannot carry. `Headers` throws on any other wherever the generation is served.
 */
const RESPONSE_HEADER_NAME = /^[!#$%&'*+\-.^`|~\w]+$/u;
const RESPONSE_HEADER_VALUE = /^[^\0\n\r\u{100}-\u{10FFFF}]*$/u;

/** The headers a generation is answered with: each one a response can be made with. */
export const responseHeadersSchema = z.record(
  z.string().regex(RESPONSE_HEADER_NAME, 'must be a header name'),
  z.string().regex(RESPONSE_HEADER_VALUE, 'must be a value a header can carry'),
);

export const commitGenerationSchema = z.object({
  cacheTimestamp: z.number().int(),
  producedAt: z.number().int(),
  policy: cachePolicySchema,
  status: responseStatusSchema,
  /** The headers the generation is answered with, already filtered (`generationResponseHeaders`). */
  headers: responseHeadersSchema,
  tags: z.array(generationTagSchema).max(MAX_TAGS_PER_ENTRY),
  outputs: z.array(commitOutputSchema).min(1),
  dependencies: z.array(commitDependencySchema),
  dependencyCoverage: dependencyCoverageSchema,
  producer: generationProducerSchema.optional(),
});
export type CommitGeneration = z.infer<typeof commitGenerationSchema>;

/**
 * What a render's view of the tags held of each of the generation's tags, by value: the revision of
 * the scope through which every read the render made under the tag was judged against its
 * invalidations — the view's own revision of a tag no read was made under — and nothing of a tag it
 * held nothing of. Of no more tags than a generation carries.
 */
const heldTagRevisionsSchema = z
  .record(tagValueSchema, z.number().int().nonnegative())
  .refine((held) => Object.keys(held).length <= MAX_TAGS_PER_ENTRY, {
    message: `A commit may say what its view held of at most ${MAX_TAGS_PER_ENTRY} tags`,
  });

/** `POST /attempts/:attemptId/commit` */
export const commitRequestSchema = z.object({
  fencingToken: z.number().int().positive(),
  /** The tag revision the renderer had synced when it read its inputs. */
  observedTagRevision: z.number().int().nonnegative(),
  /**
   * What the renderer's view held of each of the generation's tags (`heldTagRevisionsSchema`): an
   * invalidation of a tag at or before both what this says of it and `observedTagRevision` is one
   * the render's reads under the tag were judged against. Absent from a runtime from before it,
   * whose commit is judged as one whose view held no tag: `observedTagRevision` says what the view
   * was brought up to, not what it kept of each tag — it lets a tag go past so many, and judges a
   * read under it by a copy of the tags that may be behind.
   */
  heldTagRevisions: heldTagRevisionsSchema.optional(),
  generation: commitGenerationSchema,
});
export type CommitRequest = z.infer<typeof commitRequestSchema>;

export const commitResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('published'),
    generationId: z.string().min(1),
    seq: z.number().int().positive(),
    revision: z.number().int().positive(),
    /** Present when an invalidation after the lease made it stale on arrival. */
    condemned: invalidationStateSchema.nullable(),
    /**
     * The entry's delivery record as KV holds it for the generation the commit published, base64,
     * where it is small enough to be handed back — written by the commit's own settle or another's:
     * the Function keeps it in its data center, where KV's cache goes on answering with the
     * generation it replaced. Absent where a later change left it behind or another generation
     * stands, and from a gateway that hands none back.
     */
    record: z.string().optional(),
    /**
     * Where no record is handed back, the revision the entry's record stands at, written or on its
     * way: the Function lets go of a copy of an earlier record — an earlier generation's, or this
     * one's from before a change that rewrote it — and keeps one of it or later, which another
     * commit may have handed back meanwhile. Absent beside a record, which says its own, and from a
     * gateway that says none.
     */
    recordRevision: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('superseded'), reason: z.string() }),
  z.object({ kind: z.literal('lease-expired') }),
  z.object({ kind: z.literal('stale-dependencies'), invalidationRevision: z.number().int() }),
]);
export type CommitResponse = z.infer<typeof commitResponseSchema>;

/** `POST /attempts/:attemptId/fail`: the attempt ended without a generation. */
export const failRequestSchema = z.object({
  fencingToken: z.number().int().positive(),
  /** `skipped` is an attempt that found nothing new to publish; it is not counted as a failure. */
  outcome: z.enum(['failed', 'skipped']),
  error: attemptErrorSchema.optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type FailRequest = z.infer<typeof failRequestSchema>;

export const failResponseSchema = z.object({
  regeneration: regenerationStateSchema,
  nextRetryAt: z.number().int().nullable(),
});
export type FailResponse = z.infer<typeof failResponseSchema>;

/** `POST /entries/resolve`: the current generation of an entry, with no side effect. */
export const resolveRequestSchema = z.object({ entry: entryDescriptorSchema });
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

export const resolveResponseSchema = z.object({
  entryId: z.string().min(1),
  state: cacheEntryStateSchema.nullable(),
  current: publicCacheGenerationSchema.nullable(),
  revision: z.number().int().nonnegative(),
});
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;

/** `GET /generations/:generationId` */
export const generationResponseSchema = z.object({ generation: publicCacheGenerationSchema });

/** What the data cache keeps beside a value: the `CacheEntry` fields of Next.js's handler contract. */
const DATA_USE_CACHE_KIND = 'data:use-cache';

/**
 * Whether a data entry names a handler as its kind has one: a `use cache` entry is kept under the
 * handler that made it (`default`, `remote`, one of `cacheHandlers`), which is part of what names
 * the entry, and a `fetch` entry under none. Omitted from a `use cache` entry, every handler's
 * values would be one namespace; named on a `fetch` entry, it would be one no runtime reads.
 */
function namesItsHandler(entry: {
  readonly kind: string;
  readonly handler?: string | undefined;
}): boolean {
  return (entry.kind === DATA_USE_CACHE_KIND) === (entry.handler !== undefined);
}
const HANDLER_OF_KIND = {
  message: 'a use-cache entry names its handler, and a fetch entry none',
  path: ['handler'],
} as const;

export const dataEntryMetadataSchema = z
  .object({
    kind: z.enum(['data:fetch', DATA_USE_CACHE_KIND]),
    handler: z.string().min(1).max(MAX_DATA_HANDLER_LENGTH).optional(),
    // A use-cache entry accumulates multiple cacheTag calls, nested dependencies and the
    // automatic D1 tag. Next's per-call bound is only the bound of a fetch entry's tags.
    tags: z.array(tagValueSchema).max(MAX_TAGS_PER_ENTRY),
    stale: z.number().nonnegative(),
    timestamp: z.number().int(),
    expire: z.number().nonnegative(),
    revalidate: z.number().nonnegative(),
    dependencyCoverage: dependencyCoverageSchema,
  })
  .refine((entry) => entry.kind === DATA_USE_CACHE_KIND || entry.tags.length <= MAX_TAGS_PER_CALL, {
    message: `A fetch entry may carry at most ${MAX_TAGS_PER_CALL} tags`,
    path: ['tags'],
  })
  .refine(namesItsHandler, HANDLER_OF_KIND);
export type DataEntryMetadata = z.infer<typeof dataEntryMetadataSchema>;

/**
 * `PUT /data`: the value travels as base64 inside the JSON; the gateway moves a large one to
 * storage. The body is JSON as `JSON.stringify` writes it, which escapes nothing in base64, and the
 * gateway reads no further than the largest such body can need: one that escapes what needs no
 * escape — `\/` for each slash of the base64 — can be refused as too large though its value fits.
 */
const MAX_WRITER_LENGTH = 64;

export const dataSetRequestSchema = z.object({
  key: z.string().min(1).max(MAX_DATA_KEY_LENGTH),
  entry: dataEntryMetadataSchema,
  valueBase64: z.string(),
  /**
   * Where the write stands among the writes its writer sent: the writer, one isolate of the
   * application's Function, and a count it raises with each write. Writes of a key can cross on
   * their way here, and a writer's later write is kept over its earlier one, whichever arrives last.
   */
  order: z
    .object({
      writer: z.string().min(1).max(MAX_WRITER_LENGTH),
      seq: z.number().int().positive(),
    })
    .optional(),
});
export type DataSetRequest = z.infer<typeof dataSetRequestSchema>;

export const dataSetResponseSchema = z.object({
  entryId: z.string().min(1),
  generationId: z.string().min(1),
  revision: z.number().int().positive(),
  /**
   * Set when an invalidation has touched the generation the write left current — since, when the
   * write was that generation already, or before it arrived, when the value was made before the
   * invalidation: what a read of the entry would say too.
   */
  invalidation: invalidationStateSchema.optional(),
  /**
   * Set when the entry has a later write of this one's writer (`order`), or has had this very write
   * already — the same writer and count, its request sent again after its answer was lost —
   * whatever came between: nothing was written, and the generation named is the one that later
   * write, or the first arrival of this one, made.
   */
  superseded: z.literal(true).optional(),
});

export type DataSetResponse = z.infer<typeof dataSetResponseSchema>;

/**
 * `POST /data/get` (the key is a body, never a path: it is Next.js's, and may be long), answered
 * from KV; and `POST /data/current`, the same question answered by the authority itself, with the
 * value the key holds now — what a read of KV may not have for half a minute in a data center that
 * read the key before.
 *
 * Held to the bounds a write is: no value is ever stored under a longer key or handler, so a read
 * of one has nothing to find, and is refused as a write of it is. A runtime's cache handler takes a
 * read that fails for a miss, which is what a read of such a key always was.
 */
export const dataGetRequestSchema = z
  .object({
    key: z.string().min(1).max(MAX_DATA_KEY_LENGTH),
    kind: z.enum(['data:fetch', DATA_USE_CACHE_KIND]),
    handler: z.string().min(1).max(MAX_DATA_HANDLER_LENGTH).optional(),
  })
  .refine(namesItsHandler, HANDLER_OF_KIND);
export type DataGetRequest = z.infer<typeof dataGetRequestSchema>;

/**
 * `POST /data/current`: what `POST /data/get` asks, and the revision of the value the asker holds,
 * where it holds one (`than`). Only a value later than that is answered: where the key holds none,
 * the authority answers as for a key that holds nothing (404), reading nothing of the value.
 */
export const currentDataRequestSchema = dataGetRequestSchema.extend({
  than: z.number().int().nonnegative().optional(),
});
export type CurrentDataRequest = z.infer<typeof currentDataRequestSchema>;

const dataValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), base64: z.string() }),
  z.object({ kind: z.literal('ref'), artifactId: z.string().min(1) }),
]);

export const dataGetResponseSchema = z.object({
  entryId: z.string().min(1),
  generationId: z.string().min(1),
  dependencyRevision: z.number().int().nonnegative(),
  entry: dataEntryMetadataSchema,
  value: dataValueSchema,
  /** Set once an invalidation touched the entry; what the tag delta will say too. */
  invalidation: invalidationStateSchema.optional(),
});
export type DataGetResponse = z.infer<typeof dataGetResponseSchema>;

/** `GET /tags/delta?since=<revision>` */
const tagHistoryMarkSchema = z.object({
  revision: z.number().int().positive(),
  staleAt: z.number().int(),
  hardExpireAt: z.number().int().nullable(),
});

export const tagDeltaEntrySchema = z.object({
  tagId: z.string().min(1),
  kind: tagKindSchema,
  /** A tag an invalidation named, which no request names longer; a runtime keys a cache on it. */
  value: tagValueSchema,
  revision: z.number().int().positive(),
  staleAt: z.number().int(),
  hardExpireAt: z.number().int().nullable(),
  meaning: invalidationMeaningSchema,
  /** Bounded earlier deadlines that still apply to older values. Absent on older hosts. */
  history: z.array(tagHistoryMarkSchema).max(MAX_TAG_HISTORY).optional(),
});
export type TagDeltaEntry = z.infer<typeof tagDeltaEntrySchema>;

/**
 * Where a scope's tags stand: the revision of its latest invalidation, and when that invalidation
 * took effect — `0` and `null` for a scope none of whose tags was ever invalidated.
 */
export const tagRevisionSchema = z.object({
  revision: z.number().int().nonnegative(),
  invalidatedAt: z.number().int().nullable(),
});
export type TagRevision = z.infer<typeof tagRevisionSchema>;

/**
 * The most tags a page of the delta holds: the most a reader may ask a page for (`limit`). A page
 * ends where a revision does, and a revision that holds more tags than the page was asked for is
 * sent whole; but the tags of one revision are those one invalidation named, `MAX_TAGS_PER_CALL`
 * at the most, fewer than these. Past them, the rest is the next page's (`truncated`).
 */
export const MAX_DELTA_PAGE_TAGS = 1000;

export const tagsDeltaResponseSchema = z.object({
  /** The scope's revision the delta was read at: the next `since`. */
  revision: z.number().int().nonnegative(),
  /** The oldest revision still answerable; a `since` below it means a full resync. */
  floor: z.number().int().nonnegative(),
  truncated: z.boolean(),
  tags: z.array(tagDeltaEntrySchema).max(MAX_DELTA_PAGE_TAGS),
  /** Where the scope's tags stand as the delta was read; absent from an authority that says not. */
  latest: tagRevisionSchema.optional(),
});
export type TagsDeltaResponse = z.infer<typeof tagsDeltaResponseSchema>;

/**
 * Whether a delta asked for from `since` moves its reader on. A page that is not the last is read on
 * from its `revision`, so one whose revision does not pass `since` would be asked for again, and
 * answered the same, for as long as its reader went on asking. The shape cannot say so, as it does
 * not know `since`; whatever asks for a delta asks this of each page.
 */
export function deltaMovesOn(
  since: number,
  delta: Pick<TagsDeltaResponse, 'revision' | 'truncated'>,
): boolean {
  return !delta.truncated || delta.revision > since;
}

/** Regional reads are bounded independently of the number of tags in a deployment. */
export const tagsGetRequestSchema = z.object({
  tags: z.array(tagValueSchema).max(MAX_TAGS_PER_CALL),
});
/** At most a record for each tag the read named, so no more than a read may name. */
export const tagsGetResponseSchema = z.object({
  tags: z.array(tagDeltaEntrySchema).max(MAX_TAGS_PER_CALL),
});
export type TagsGetResponse = z.infer<typeof tagsGetResponseSchema>;

/** `POST /invalidations` */
const invalidateTagSchema = z.object({
  value: tagValueSchema,
  kind: tagKindSchema.optional(),
});

export const invalidateRequestSchema = z.object({
  tags: z.array(invalidateTagSchema).min(1).max(MAX_TAGS_PER_CALL),
  /**
   * Seconds the stale content may still be served; absent or zero means at once. Whole or not, as
   * a `cacheLife` profile gives them and Next.js takes them: the authority keeps the deadline to
   * the millisecond.
   */
  expire: z.number().nonnegative().optional(),
  cause: invalidationCauseSchema,
  /**
   * More requests of the same invalidation follow — one with more tags than a request carries, sent
   * a chunk at a time: the authority tells the host of each behind its answer, and waits for the
   * host's telling on the last alone. Absent, as from a Worker that sends none, each waits.
   */
  more: z.boolean().optional(),
});
export type InvalidateRequest = z.infer<typeof invalidateRequestSchema>;

const invalidationResultSchema = z.object({
  invalidationId: z.string().min(1),
  tagId: z.string().min(1),
  value: z.string().min(1),
  staleAt: z.number().int(),
  hardExpireAt: z.number().int().nullable(),
  meaning: invalidationMeaningSchema,
  /** Earlier deadlines the invalidating isolate may never have synced. */
  history: z.array(tagHistoryMarkSchema).max(MAX_TAG_HISTORY).optional(),
});

export const invalidateResponseSchema = z.object({
  revision: z.number().int().positive(),
  /** A result for each tag the invalidation named, so no more than an invalidation may name. */
  invalidations: z.array(invalidationResultSchema).max(MAX_TAGS_PER_CALL),
  affectedEntryIds: z.array(z.string().min(1)),
});
export type InvalidateResponse = z.infer<typeof invalidateResponseSchema>;
