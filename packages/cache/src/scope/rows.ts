import {
  cacheEntryKindSchema,
  cachePolicySchema,
  generationSourceKindSchema,
  generationTagSchema,
  invalidationStateSchema,
  KEY_SCHEMA_VERSION,
  keyDescriptorSchema,
  type OutputSnapshot,
  outputSnapshotSchema,
  tagKindSchema,
} from '@stayingupwind/core/cache';
import {
  attemptErrorSchema,
  attemptObservationSchema,
  attemptReasonSchema,
  attemptStatusSchema,
  type CacheEntry,
  type CacheEntryState,
  cacheEnvironmentSchema,
  type CacheGeneration,
  type CacheScope,
  cacheScopeStatusSchema,
  type CacheTag,
  dependencyCoverageSchema,
  ENTITY_SCHEMA_VERSION,
  entryPublicationSchema,
  type GenerationAttempt,
  generationProducerSchema,
  invalidationCauseSchema,
  invalidationMeaningSchema,
  type InvalidationRecord,
  publicationStateSchema,
  publicCacheGeneration,
  type PublicCacheGeneration,
  regenerationStateSchema,
  storageStateSchema,
} from '@stayingupwind/host/cache';
import { toZod } from '@stayingupwind/host/zod';
import { z } from 'zod';

/**
 * The tables as rows, and the rows as the entities the rest of the cache reads. A JSON column
 * is parsed against its schema on the way out: the authority wrote it, but a schema it no longer
 * knows is a bug to surface, not a value to serve.
 */

export interface ScopeRow extends Record<string, SqlStorageValue> {
  scope_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  deployment_id: string;
  key_schema_version: number;
  build_id: string;
  status: string;
  seeded_at: number;
  retired_at: number | null;
  revision: number;
  entry_count: number;
  body_bytes: number;
}

export interface EntryRow extends Record<string, SqlStorageValue> {
  entry_id: string;
  kind: string;
  route: string | null;
  pathname: string | null;
  cache_key_digest: string;
  group_instance_id: string | null;
  key_descriptor: string;
  handler: string | null;
  created_at: number;
  created_revision: number;
  revision: number;
  record_revision: number;
  kv_revision: number;
  current_generation_id: string | null;
  publication: string;
  regeneration: string;
  regeneration_attempt_id: string | null;
  failed_count: number;
  next_retry_at: number | null;
  tombstone_revision: number | null;
  committed_at: number | null;
  updated_at: number;
  fencing_max: number;
  seq_max: number;
}

export interface GenerationRow extends Record<string, SqlStorageValue> {
  generation_id: string;
  entry_id: string;
  seq: number;
  source: string;
  attempt_id: string | null;
  cache_timestamp: number | null;
  produced_at: number | null;
  policy: string;
  status: number;
  headers: string;
  tags: string;
  dependency_coverage: string;
  dependency_revision: number;
  publication: string;
  published_revision: number | null;
  superseded_revision: number | null;
  condemned: string | null;
  storage: string;
  pruned_at: number | null;
  body_bytes: number;
  producer: string | null;
  outputs: string;
  committed_at: number;
}

export interface TagRow extends Record<string, SqlStorageValue> {
  tag_id: string;
  kind: string;
  value: string;
  revision: number;
  stale_at: number | null;
  hard_expire_at: number | null;
  meaning: string | null;
}

export interface ResourceHeadRow extends Record<string, SqlStorageValue> {
  resource_id: string;
  event_id: string;
  version: number;
  tag: string;
  tag_revision: number;
  applied_at: number;
}

export interface WarmJobRow extends Record<string, SqlStorageValue> {
  job_id: string;
  resource_id: string;
  entry_id: string;
  event_id: string;
  version: number;
  required_revision: number;
  status: string;
  attempt_count: number;
  retry_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  detail: string | null;
  updated_at: number;
}

export interface AttemptRow extends Record<string, SqlStorageValue> {
  attempt_id: string;
  entry_id: string;
  reason: string;
  status: string;
  fencing_token: number;
  dependency_revision: number;
  lease_expires_at: number;
  started_at: number;
  finished_at: number | null;
  generation_id: string | null;
  error: string | null;
  producer: string | null;
  observation: string | null;
}

export interface InvalidationRow extends Record<string, SqlStorageValue> {
  invalidation_id: string;
  revision: number;
  target_kind: string;
  target_id: string;
  target_value: string | null;
  stale_at: number;
  hard_expire_at: number | null;
  meaning: string;
  expire_seconds: number | null;
  cause: string;
  recorded_at: number;
}

export interface ArtifactRow extends Record<string, SqlStorageValue> {
  artifact_id: string;
  sha256: string;
  storage_ref: string;
  byte_length: number;
  owned: number;
  refs: number;
  referenced_at: number;
}

export interface AttemptArtifactRow extends Record<string, SqlStorageValue> {
  attempt_id: string;
  sha256: string;
  role: string;
  byte_length: number;
  content_type: string;
  encoding: string;
  storage_ref: string;
  uploaded_at: number;
}

const headersSchema = z.record(z.string(), z.string());
const tagsSchema = z.array(toZod(generationTagSchema));
const outputsSchema = z.array(toZod(outputSnapshotSchema));

/** A schema that parses: zod's, or one core's validator made (`@stayingupwind/core/schema`). */
interface Parsing<T> {
  parse: (value: unknown) => T;
}

export function parseJson<T>(schema: Parsing<T>, text: string): T {
  return schema.parse(JSON.parse(text));
}

function parseNullable<T>(schema: Parsing<T>, text: string | null): T | null {
  return text === null ? null : parseJson(schema, text);
}

export function toScope(row: ScopeRow): CacheScope {
  return {
    scopeId: row.scope_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: cacheEnvironmentSchema.parse(row.environment_id),
    deploymentId: row.deployment_id,
    // The schema its keys were made under, as it was seeded: one this authority does not know is a
    // fault to surface, as a column's schema is, not this authority's own to serve in its place.
    keySchemaVersion: z.literal(KEY_SCHEMA_VERSION).parse(row.key_schema_version),
    buildId: row.build_id,
    status: cacheScopeStatusSchema.parse(row.status),
    seededAt: row.seeded_at,
    schemaVersion: ENTITY_SCHEMA_VERSION,
  };
}

export function toEntry(scopeId: string, row: EntryRow): CacheEntry {
  return {
    entryId: row.entry_id,
    scopeId,
    kind: cacheEntryKindSchema.parse(row.kind),
    route: row.route,
    pathname: row.pathname,
    cacheKeyDigest: row.cache_key_digest,
    groupInstanceId: row.group_instance_id,
    keyDescriptor: parseJson(keyDescriptorSchema, row.key_descriptor),
    handler: row.handler,
    createdAt: row.created_at,
    createdRevision: row.created_revision,
    schemaVersion: ENTITY_SCHEMA_VERSION,
  };
}

export function toEntryState(row: EntryRow): CacheEntryState {
  return {
    entryId: row.entry_id,
    revision: row.revision,
    currentGenerationId: row.current_generation_id,
    publication: entryPublicationSchema.parse(row.publication),
    regeneration: regenerationStateSchema.parse(row.regeneration),
    regenerationAttemptId: row.regeneration_attempt_id,
    failedCount: row.failed_count,
    nextRetryAt: row.next_retry_at,
    tombstoneRevision: row.tombstone_revision,
    kvRevision: row.kv_revision,
    committedAt: row.committed_at,
    updatedAt: row.updated_at,
  };
}

export function toGeneration(scopeId: string, row: GenerationRow): CacheGeneration {
  return {
    generationId: row.generation_id,
    entryId: row.entry_id,
    scopeId,
    seq: row.seq,
    source: generationSourceKindSchema.parse(row.source),
    attemptId: row.attempt_id,
    cacheTimestamp: row.cache_timestamp,
    producedAt: row.produced_at,
    policy: parseJson(cachePolicySchema, row.policy),
    status: row.status,
    tags: parseJson(tagsSchema, row.tags),
    dependencyCoverage: dependencyCoverageSchema.parse(row.dependency_coverage),
    dependencyRevision: row.dependency_revision,
    publication: publicationStateSchema.parse(row.publication),
    publishedRevision: row.published_revision,
    supersededRevision: row.superseded_revision,
    condemned: parseNullable(invalidationStateSchema, row.condemned),
    storage: storageStateSchema.parse(row.storage),
    prunedAt: row.pruned_at,
    bodyBytes: row.body_bytes,
    producer: parseNullable(generationProducerSchema, row.producer),
    outputs: parseJson(outputsSchema, row.outputs),
    schemaVersion: ENTITY_SCHEMA_VERSION,
  };
}

export function toPublicGeneration(scopeId: string, row: GenerationRow): PublicCacheGeneration {
  return publicCacheGeneration(toGeneration(scopeId, row));
}

/** The headers the generation is answered with, as recorded (`generationResponseHeaders`). */
export function generationHeaders(row: Pick<GenerationRow, 'headers'>): Record<string, string> {
  return parseJson(headersSchema, row.headers);
}

export function generationOutputs(row: GenerationRow): OutputSnapshot[] {
  return parseJson(outputsSchema, row.outputs);
}

export function toTag(scopeId: string, row: TagRow): CacheTag {
  return {
    tagId: row.tag_id,
    scopeId,
    kind: tagKindSchema.parse(row.kind),
    value: row.value,
    revision: row.revision,
    staleAt: row.stale_at,
    hardExpireAt: row.hard_expire_at,
  };
}

export function toAttempt(scopeId: string, row: AttemptRow): GenerationAttempt {
  return {
    attemptId: row.attempt_id,
    scopeId,
    entryId: row.entry_id,
    reason: attemptReasonSchema.parse(row.reason),
    status: attemptStatusSchema.parse(row.status),
    fencingToken: row.fencing_token,
    dependencyRevision: row.dependency_revision,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    generationId: row.generation_id,
    error: parseNullable(attemptErrorSchema, row.error),
    producer: parseNullable(generationProducerSchema, row.producer),
    observation: parseNullable(attemptObservationSchema, row.observation),
    schemaVersion: ENTITY_SCHEMA_VERSION,
  };
}

export function toInvalidation(scopeId: string, row: InvalidationRow): InvalidationRecord {
  return {
    invalidationId: row.invalidation_id,
    scopeId,
    revision: row.revision,
    target: {
      kind: row.target_kind === 'tag' ? 'tag' : 'entry',
      id: row.target_id,
      ...(row.target_value !== null && { value: row.target_value }),
    },
    staleAt: row.stale_at,
    hardExpireAt: row.hard_expire_at,
    meaning: invalidationMeaningSchema.parse(row.meaning),
    expireSeconds: row.expire_seconds,
    cause: parseJson(invalidationCauseSchema, row.cause),
    recordedAt: row.recorded_at,
    schemaVersion: ENTITY_SCHEMA_VERSION,
  };
}
