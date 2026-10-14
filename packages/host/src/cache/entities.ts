import { sha256HexSchema } from '@stayingupwind/core/artifact';
import { deploymentIdSchema } from '@stayingupwind/core/bundle';
import {
  cacheEntryKindSchema,
  cachePolicySchema,
  generationSourceKindSchema,
  generationTagSchema,
  invalidationStateSchema,
  KEY_SCHEMA_VERSION,
  keyDescriptorSchema,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_ENTRY,
  outputSnapshotSchema,
  publicOutputSnapshot,
  publicOutputSnapshotSchema,
  tagKindSchema,
} from '@stayingupwind/core/cache';
import * as z from '@stayingupwind/core/schema';

import { SIGNABLE_SCOPE_ID } from './token.ts';

/**
 * The cache's own model, as every Worker and any index of its history see it.
 *
 * Four things are kept apart on purpose. Publication (which generation is current) is an entry's
 * state, updated on its own; a generation is an immutable snapshot of one render; validity is never
 * stored, only derived from a generation's timing, the invalidations recorded against it and the
 * clock (`freshness.ts`); storage says whether the bytes are still there. Every record carries a
 * `schemaVersion`, and a reader that meets a version it does not know says so rather than guessing.
 *
 * Written with core's validator (`@stayingupwind/core/schema`), for the reason `gateway-contract.ts`
 * gives of its own.
 */

export const ENTITY_SCHEMA_VERSION = 1;
export const ATTEMPT_ID_PREFIX = 'att';
export const INVALIDATION_ID_PREFIX = 'inv';

export const cacheEnvironmentSchema = z.enum(['production', 'preview']);
export type CacheEnvironment = z.infer<typeof cacheEnvironmentSchema>;

export const cacheScopeStatusSchema = z.enum(['active', 'retired']);
export type CacheScopeStatus = z.infer<typeof cacheScopeStatusSchema>;

/** The boundary of authorization, keys, storage and invalidation: one deployment, for now. */
export const cacheScopeSchema = z.object({
  /** Signed into the token that opens the scope, so it carries neither of a token's separators. */
  scopeId: z.string().min(1).regex(SIGNABLE_SCOPE_ID, 'a scope id may carry neither . nor |'),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: cacheEnvironmentSchema,
  deploymentId: deploymentIdSchema,
  keySchemaVersion: z.literal(KEY_SCHEMA_VERSION),
  buildId: z.string().min(1),
  status: cacheScopeStatusSchema,
  seededAt: z.number().int(),
  schemaVersion: z.literal(ENTITY_SCHEMA_VERSION),
});
export type CacheScope = z.infer<typeof cacheScopeSchema>;

export const cacheEntrySchema = z.object({
  entryId: z.string().min(1),
  scopeId: z.string().min(1),
  kind: cacheEntryKindSchema,
  route: z.string().nullable(),
  pathname: z.string().nullable(),
  cacheKeyDigest: sha256HexSchema,
  /** The prerender group this entry's outputs came from, when the build made it. */
  groupInstanceId: z.string().nullable(),
  keyDescriptor: keyDescriptorSchema,
  handler: z.string().nullable(),
  createdAt: z.number().int(),
  createdRevision: z.number().int().nonnegative(),
  schemaVersion: z.literal(ENTITY_SCHEMA_VERSION),
});
export type CacheEntry = z.infer<typeof cacheEntrySchema>;

export const publicationStateSchema = z.enum(['candidate', 'published', 'superseded', 'retired']);
export type PublicationState = z.infer<typeof publicationStateSchema>;

export const storageStateSchema = z.enum([
  'present',
  'missing',
  'pruned',
  'corrupt',
  'unavailable',
]);
export type StorageState = z.infer<typeof storageStateSchema>;

export const regenerationStateSchema = z.enum(['idle', 'queued', 'running', 'failed']);
export type RegenerationState = z.infer<typeof regenerationStateSchema>;

/** How much of what a generation read was recorded; `unrecorded` is never "no dependencies". */
export const dependencyCoverageSchema = z.enum(['complete', 'partial', 'unrecorded']);
export type DependencyCoverage = z.infer<typeof dependencyCoverageSchema>;

export const generationProducerSchema = z.object({
  kind: z.enum(['build', 'attempt']),
  reason: z.string().optional(),
  colo: z.string().optional(),
});
export type GenerationProducer = z.infer<typeof generationProducerSchema>;

const generationBaseSchema = z.object({
  generationId: z.string().min(1),
  entryId: z.string().min(1),
  scopeId: z.string().min(1),
  seq: z.number().int().positive(),
  source: generationSourceKindSchema,
  attemptId: z.string().nullable(),
  cacheTimestamp: z.number().int().nullable(),
  producedAt: z.number().int().nullable(),
  policy: cachePolicySchema,
  status: z.number().int(),
  tags: z.array(generationTagSchema).max(MAX_TAGS_PER_ENTRY),
  dependencyCoverage: dependencyCoverageSchema,
  /** The scope revision the generation's inputs were read at; invalidations past it condemn it. */
  dependencyRevision: z.number().int().nonnegative(),
  publication: publicationStateSchema,
  publishedRevision: z.number().int().nullable(),
  supersededRevision: z.number().int().nullable(),
  /** Set by the authority when an invalidation after `dependencyRevision` touched its tags. */
  condemned: invalidationStateSchema.nullable(),
  storage: storageStateSchema,
  prunedAt: z.number().int().nullable(),
  bodyBytes: z.number().int().nonnegative(),
  producer: generationProducerSchema.nullable(),
  schemaVersion: z.literal(ENTITY_SCHEMA_VERSION),
});

/** One render's outputs, published as a whole: the shell, its state and its related outputs. */
export const cacheGenerationSchema = generationBaseSchema.extend({
  outputs: z.array(outputSnapshotSchema),
});
export type CacheGeneration = z.infer<typeof cacheGenerationSchema>;

export const publicCacheGenerationSchema = generationBaseSchema.extend({
  outputs: z.array(publicOutputSnapshotSchema),
});
export type PublicCacheGeneration = z.infer<typeof publicCacheGenerationSchema>;

/** The same generation without its storage keys: the form that may leave a Worker. */
export function publicCacheGeneration(generation: CacheGeneration): PublicCacheGeneration {
  return {
    ...generation,
    outputs: generation.outputs.map((output) => publicOutputSnapshot(output)),
  };
}

export const entryPublicationSchema = z.enum(['none', 'published', 'retired']);
export type EntryPublication = z.infer<typeof entryPublicationSchema>;

export const cacheEntryStateSchema = z.object({
  entryId: z.string().min(1),
  /** The scope revision at which this state was last committed. */
  revision: z.number().int().nonnegative(),
  currentGenerationId: z.string().nullable(),
  publication: entryPublicationSchema,
  regeneration: regenerationStateSchema,
  regenerationAttemptId: z.string().nullable(),
  failedCount: z.number().int().nonnegative(),
  nextRetryAt: z.number().int().nullable(),
  /** Set when an immediate invalidation stopped the current generation being served. */
  tombstoneRevision: z.number().int().nullable(),
  /** The revision the delivery record (KV) was last written at; below `revision` until repaired. */
  kvRevision: z.number().int().nonnegative(),
  committedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
export type CacheEntryState = z.infer<typeof cacheEntryStateSchema>;

export const cacheTagSchema = z.object({
  tagId: z.string().min(1),
  scopeId: z.string().min(1),
  kind: tagKindSchema,
  value: z.string().min(1).max(MAX_TAG_LENGTH),
  /** The revision of the last invalidation that named it; 0 when never invalidated. */
  revision: z.number().int().nonnegative(),
  staleAt: z.number().int().nullable(),
  hardExpireAt: z.number().int().nullable(),
});
export type CacheTag = z.infer<typeof cacheTagSchema>;

export const dependencyTargetSchema = z.object({
  kind: z.enum(['tag', 'entry']),
  id: z.string().min(1),
});
export type DependencyTarget = z.infer<typeof dependencyTargetSchema>;

/**
 * How a dependency is known: written on the generation's output (`recorded-tags`), a cache read
 * observed while it rendered (`observed-read`), or only that two things carry the same tag
 * (`shared-tag`) — which is no proof that one read the other.
 */
export const dependencyEvidenceSchema = z.enum(['recorded-tags', 'observed-read', 'shared-tag']);
export type DependencyEvidence = z.infer<typeof dependencyEvidenceSchema>;

/** Where the dependency is used: in the shell, or only in a dynamic hole that the shell does not wait for. */
export const dependencyUsageSchema = z.enum(['shell', 'dynamic-hole', 'unknown']);
export type DependencyUsage = z.infer<typeof dependencyUsageSchema>;

export const cacheDependencySchema = z.object({
  ownerGenerationId: z.string().min(1),
  target: dependencyTargetSchema,
  observedRevision: z.number().int().nullable(),
  evidence: dependencyEvidenceSchema,
  usage: dependencyUsageSchema,
});
export type CacheDependency = z.infer<typeof cacheDependencySchema>;

/** What an invalidation was observed to mean; the API that made it is recorded only when known. */
export const invalidationMeaningSchema = z.enum(['immediate', 'swr']);
export type InvalidationMeaning = z.infer<typeof invalidationMeaningSchema>;

export const invalidationCauseSchema = z.object({
  source: z.enum(['app-worker', 'control', 'platform']),
  /** `revalidateTag`, `updateTag`, `revalidatePath`, … — only when the caller said so. */
  api: z.string().optional(),
  requestId: z.string().optional(),
});
export type InvalidationCause = z.infer<typeof invalidationCauseSchema>;

export const invalidationTargetSchema = z.object({
  kind: z.enum(['tag', 'entry']),
  id: z.string().min(1),
  /** The tag's exact value, for a tag target. */
  value: z.string().optional(),
});

export const invalidationRecordSchema = z.object({
  invalidationId: z.string().min(1),
  scopeId: z.string().min(1),
  revision: z.number().int().positive(),
  target: invalidationTargetSchema,
  staleAt: z.number().int(),
  hardExpireAt: z.number().int().nullable(),
  meaning: invalidationMeaningSchema,
  expireSeconds: z.number().int().nonnegative().nullable(),
  cause: invalidationCauseSchema,
  recordedAt: z.number().int(),
  schemaVersion: z.literal(ENTITY_SCHEMA_VERSION),
});
export type InvalidationRecord = z.infer<typeof invalidationRecordSchema>;

export const attemptReasonSchema = z.enum(['stale', 'expired', 'miss', 'invalidated', 'manual']);
export type AttemptReason = z.infer<typeof attemptReasonSchema>;

export const attemptStatusSchema = z.enum([
  'leased',
  'uploading',
  'committed',
  /** Ended without a generation because the render found nothing new to publish. */
  'skipped',
  'failed',
  'expired',
  'superseded',
]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const attemptErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});
export type AttemptError = z.infer<typeof attemptErrorSchema>;

/** What the edge said it was serving when it asked for the attempt: one place, one moment. */
export const attemptObservationSchema = z.object({
  generationId: z.string().min(1),
  at: z.number().int(),
  colo: z.string().optional(),
});
export type AttemptObservation = z.infer<typeof attemptObservationSchema>;

/** One try at regenerating an entry: its lease, and how it ended. Never a generation itself. */
export const generationAttemptSchema = z.object({
  attemptId: z.string().min(1),
  scopeId: z.string().min(1),
  entryId: z.string().min(1),
  reason: attemptReasonSchema,
  status: attemptStatusSchema,
  /** Increases with every lease of the entry; a commit with an older one is refused. */
  fencingToken: z.number().int().positive(),
  dependencyRevision: z.number().int().nonnegative(),
  leaseExpiresAt: z.number().int(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  generationId: z.string().nullable(),
  error: attemptErrorSchema.nullable(),
  producer: generationProducerSchema.nullable(),
  /** `null` when nothing at the edge asked: a regeneration the Worker started on its own. */
  observation: attemptObservationSchema.nullable(),
  schemaVersion: z.literal(ENTITY_SCHEMA_VERSION),
});
export type GenerationAttempt = z.infer<typeof generationAttemptSchema>;

/** A fact observed at one moment in one execution: never the state of every edge location. */
export const edgeObservationSchema = z.object({
  entryId: z.string().min(1),
  generationId: z.string().min(1),
  observedAt: z.number().int(),
  source: z.enum(['regenerate-trigger', 'resume']),
  colo: z.string().optional(),
});
export type EdgeObservation = z.infer<typeof edgeObservationSchema>;
