import { sha256HexSchema } from '@stayingupwind/core/artifact';
import {
  artifactEncodingSchema,
  artifactRoleSchema,
  cachePolicySchema,
  generationTagSchema,
  headerValuesSchema,
  MAX_TAGS_PER_ENTRY,
  outputComputeSchema,
  outputResponseSchema,
  routeEntryDescriptorSchema,
  routeEntryKindSchema,
} from '@stayingupwind/core/cache';
import * as z from 'zod';

import { toZod } from '../zod/index.ts';
import {
  cacheEntrySchema as cacheEntryEntity,
  cacheEntryStateSchema as cacheEntryStateEntity,
  cacheScopeSchema as cacheScopeEntity,
  cacheScopeStatusSchema as cacheScopeStatusEntity,
  dependencyCoverageSchema as dependencyCoverageEntity,
  publicCacheGenerationSchema as publicCacheGenerationEntity,
} from './entities.ts';
import { invalidateRequestSchema as invalidateRequestEntity } from './gateway-contract.ts';

/**
 * The entities and the request this contract carries, which `entities.ts` and `gateway-contract.ts`
 * write with core's validator — a deployment's Function reads them, and so builds no zod — as the
 * zod schemas this contract, which only a host's deploy and the authority read, composes them into.
 */
const cacheEntrySchema = toZod(cacheEntryEntity);
const cacheEntryStateSchema = toZod(cacheEntryStateEntity);
const cacheScopeSchema = toZod(cacheScopeEntity);
const cacheScopeStatusSchema = toZod(cacheScopeStatusEntity);
const dependencyCoverageSchema = toZod(dependencyCoverageEntity);
const publicCacheGenerationSchema = toZod(publicCacheGenerationEntity);
const invalidateRequestSchema = toZod(invalidateRequestEntity);

/**
 * What a host's deploy may ask of the cache authority — seed a scope and its entries, retire it,
 * have a token issued for it — and what anything may read of a scope, over the cache Worker's RPC
 * entrypoints. The shapes are validated on the way in by the entrypoint: the caller is trusted,
 * its serialization is not.
 *
 * What a host's history adds to a seed, and says of itself in an answer, travels beside the
 * authority's own fields (`ScopeHistory`): the seed and its answer, and a scope's head, keep keys
 * they do not name.
 */

export const MAX_SEED_BATCH = 200;
const NOT_RECORDED = 'not-recorded';
const UNAVAILABLE = 'unavailable';
export const MAX_WARM_FAILURE_DETAIL_LENGTH = 2048;

/**
 * What a host's history may say beside the authority's own fields: a plain value, or one object of
 * plain values — what crosses an RPC binding as it was sent, and what its types can carry.
 */
const plainSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()]);
const historyValueSchema = z.union([plainSchema, z.record(z.string(), plainSchema)]);

/** The scope a seed creates, as the deploy names it. */
export const scopeSeedSchema = cacheScopeSchema.omit({
  status: true,
  seededAt: true,
  schemaVersion: true,
});

/** `seedScope`: create a deployment's scope, once; a seed that finds it made changes nothing of it. */
export const seedScopeInputSchema = z
  .object({ scope: scopeSeedSchema })
  .catchall(historyValueSchema);
export type SeedScopeInput = z.infer<typeof seedScopeInputSchema>;

export const seedScopeResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['seeded', 'already-seeded']),
      revision: z.number().int().nonnegative(),
      /** The token the deployment's Workers present to the gateway. */
      token: z.string().min(1),
    })
    .catchall(historyValueSchema),
  // A refusal is an answer too, and keeps what a history says beside it as the others do.
  z.object({ kind: z.literal('conflict'), reason: z.string() }).catchall(historyValueSchema),
]);
export type SeedScopeResult = z.infer<typeof seedScopeResultSchema>;

/** A build artifact already in storage under the build's own key. */
export const seedArtifactSchema = z.object({
  role: toZod(artifactRoleSchema),
  sha256: toZod(sha256HexSchema),
  byteLength: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  encoding: toZod(artifactEncodingSchema),
  storageRef: z.string().min(1),
});
export type SeedArtifact = z.infer<typeof seedArtifactSchema>;

export const seedOutputSchema = z.object({
  representationKey: z.string().min(1),
  pathname: z.string().nullable(),
  status: z.number().int().nullable(),
  headers: toZod(headerValuesSchema),
  compute: toZod(outputComputeSchema),
  response: toZod(outputResponseSchema),
  htmlSize: z.number().int().nonnegative().nullable(),
  artifacts: z.array(seedArtifactSchema),
});
export type SeedOutput = z.infer<typeof seedOutputSchema>;

const seedGenerationSchema = z.object({
  generationId: z.string().min(1),
  cacheTimestamp: z.number().int().nullable(),
  producedAt: z.number().int().nullable(),
  policy: toZod(cachePolicySchema),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  tags: z.array(toZod(generationTagSchema)).max(MAX_TAGS_PER_ENTRY),
  outputs: z.array(seedOutputSchema).min(1),
  dependencyCoverage: dependencyCoverageSchema,
});

export const seedEntryInputSchema = z.object({
  descriptor: toZod(routeEntryDescriptorSchema),
  allowQuery: z.array(z.string()).optional(),
  groupInstanceId: z.string().nullable(),
  generation: seedGenerationSchema,
});
export type SeedEntryInput = z.infer<typeof seedEntryInputSchema>;

/** `seedEntries`: the build's generation of each entry, in batches; an entry seeded before is skipped. */
export const seedEntriesInputSchema = z.object({
  scopeId: z.string().min(1),
  batchIndex: z.number().int().nonnegative(),
  entries: z.array(seedEntryInputSchema).max(MAX_SEED_BATCH),
});
export type SeedEntriesInput = z.infer<typeof seedEntriesInputSchema>;

/** An entry a batch left unseeded, and why. */
const seedRefusalSchema = z.object({
  descriptor: toZod(routeEntryDescriptorSchema),
  reason: z.string(),
});

export const seedEntriesResultSchema = z.object({
  inserted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /**
   * Entries no delivery record of could ever be written: left unseeded rather than published and
   * retried forever, and served as any entry the cache holds no record of is.
   */
  refused: z.array(seedRefusalSchema),
  revision: z.number().int().nonnegative(),
});
export type SeedEntriesResult = z.infer<typeof seedEntriesResultSchema>;

/** `retireScope`: nothing of the scope is served any more; bodies go with the retention alarm. */
export const retireScopeInputSchema = z.object({
  scopeId: z.string().min(1),
  reason: z.string().min(1),
});
export type RetireScopeInput = z.infer<typeof retireScopeInputSchema>;

export const retireScopeResultSchema = z.object({
  kind: z.enum(['retired', 'already-retired', 'unknown']),
});
export type RetireScopeResult = z.infer<typeof retireScopeResultSchema>;

export const issueTokenInputSchema = z.object({ scopeId: z.string().min(1) });
export const issueTokenResultSchema = z.object({ token: z.string().min(1) });

/** Invalidate through the private control binding without issuing a deployment's app token. */
export const invalidateScopeInputSchema = z.object({
  scopeId: z.string().min(1),
  request: invalidateRequestSchema,
});
export type InvalidateScopeInput = z.infer<typeof invalidateScopeInputSchema>;

/** A source-neutral resource change, numbered durably by whatever reports it. */
export const applyResourceChangeInputSchema = z.object({
  scopeId: z.string().min(1),
  resourceId: z.string().min(1),
  eventId: z.string().min(1),
  version: z.number().int().positive(),
  tag: toZod(generationTagSchema.shape.value),
  /** Only the trusted deployment's known public routes are rendered without a visitor. */
  allowedRoutes: z.array(z.string().startsWith('/')).optional(),
  /** Reconcile entries seeded after the retained change; retries never re-invalidate fresh work. */
  reconcile: z.boolean().optional(),
});
export type ApplyResourceChangeInput = z.infer<typeof applyResourceChangeInputSchema>;

const appliedResourceChangeSchema = z.object({
  kind: z.enum(['applied', 'already-applied']),
  revision: z.number().int().nonnegative(),
  affectedEntryIds: z.array(z.string().min(1)),
  queuedJobs: z.number().int().nonnegative(),
});
export const applyResourceChangeResultSchema = z.discriminatedUnion('kind', [
  appliedResourceChangeSchema,
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['unknown', 'retired']) }),
]);
export type ApplyResourceChangeResult = z.infer<typeof applyResourceChangeResultSchema>;

export const MAX_RESOURCE_WARM_JOBS = 20;

/** A bounded dispatch lease, separate from the renderer's own publication fencing token. */
export const resourceWarmJobSchema = z.object({
  jobId: z.string().min(1),
  resourceId: z.string().min(1),
  eventId: z.string().min(1),
  version: z.number().int().positive(),
  requiredRevision: z.number().int().nonnegative(),
  entryId: z.string().min(1),
  entryKind: toZod(routeEntryKindSchema),
  route: z.string().startsWith('/'),
  pathname: z.string().startsWith('/'),
  leaseToken: z.string().min(1),
  leaseExpiresAt: z.number().int(),
});
export type ResourceWarmJob = z.infer<typeof resourceWarmJobSchema>;

export const listResourceWarmJobsInputSchema = z.object({
  scopeId: z.string().min(1),
  limit: z.number().int().positive().max(MAX_RESOURCE_WARM_JOBS).optional(),
});
export type ListResourceWarmJobsInput = z.infer<typeof listResourceWarmJobsInputSchema>;

export const listResourceWarmJobsResultSchema = z.object({
  /** No more than a call may ask for: an answer past it is no answer to the call. */
  jobs: z.array(resourceWarmJobSchema).max(MAX_RESOURCE_WARM_JOBS),
  /** The next pending retry or live dispatch lease; null when no work remains. */
  nextRetryAt: z.number().int().nullable(),
});
export type ListResourceWarmJobsResult = z.infer<typeof listResourceWarmJobsResultSchema>;

export const finishResourceWarmJobInputSchema = z.object({
  scopeId: z.string().min(1),
  jobId: z.string().min(1),
  leaseToken: z.string().min(1),
  outcome: z.enum(['published', 'busy', 'failed', 'skipped']),
  detail: z.string().max(MAX_WARM_FAILURE_DETAIL_LENGTH).optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type FinishResourceWarmJobInput = z.infer<typeof finishResourceWarmJobInputSchema>;

export const finishResourceWarmJobResultSchema = z.object({
  kind: z.enum(['completed', 'retry', 'superseded', 'unknown']),
  nextRetryAt: z.number().int().nullable(),
});
export type FinishResourceWarmJobResult = z.infer<typeof finishResourceWarmJobResultSchema>;

export const scopeHeadSchema = z
  .object({
    scopeId: z.string().min(1),
    status: cacheScopeStatusSchema,
    revision: z.number().int().nonnegative(),
    entryCount: z.number().int().nonnegative(),
    seededAt: z.number().int(),
  })
  .catchall(historyValueSchema);
export type ScopeHead = z.infer<typeof scopeHeadSchema>;

export const notRecordedSchema = z.object({ kind: z.literal(NOT_RECORDED) });
export const unavailableSchema = z.object({ kind: z.literal(UNAVAILABLE), detail: z.string() });

/** A side-effect-free read of one entry as the authority holds it. */
export const readEntryResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('found'),
    entry: cacheEntrySchema,
    state: cacheEntryStateSchema,
    current: publicCacheGenerationSchema.nullable(),
    revision: z.number().int().nonnegative(),
    evaluatedAt: z.number().int(),
  }),
  notRecordedSchema,
  unavailableSchema,
]);
export type ReadEntryResult = z.infer<typeof readEntryResultSchema>;

export const readGenerationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('found'), generation: publicCacheGenerationSchema }),
  notRecordedSchema,
  unavailableSchema,
]);
export type ReadGenerationResult = z.infer<typeof readGenerationResultSchema>;

/** Internal service-binding result; storage keys never enter public events or a host's own APIs. */
export const readArtifactLocationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('found'), storageRef: z.string().min(1) }),
  z.object({ kind: z.literal('pruned') }),
  notRecordedSchema,
  unavailableSchema,
]);
export type ReadArtifactLocationResult = z.infer<typeof readArtifactLocationResultSchema>;

export const readHeadResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('found'), head: scopeHeadSchema }),
  notRecordedSchema,
  unavailableSchema,
]);
export type ReadHeadResult = z.infer<typeof readHeadResultSchema>;
