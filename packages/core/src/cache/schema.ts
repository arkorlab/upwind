import { sha256HexSchema } from '../artifact/artifact.ts';
import * as z from '../schema/index.ts';
import { ARTIFACT_ENCODINGS, ARTIFACT_ROLES } from './artifacts.ts';
import {
  CACHE_ENTRY_KINDS,
  DATA_ENTRY_KINDS,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_ENTRY,
  ROUTE_ENTRY_KINDS,
  TAG_KINDS,
} from './keys.ts';
import { GENERATION_SOURCE_KINDS, PACK_SCHEMA_VERSION } from './pack-header.ts';
import { CACHE_POLICY_SOURCES } from './timing.ts';

/**
 * The cache's shapes, as core's schemas check them: what a host validates on its way in and what the
 * types everywhere else are read off.
 *
 * Kept apart from the code that names, times and reads entries (`keys.ts`, `timing.ts`,
 * `freshness.ts`, `pack.ts`), which imports only the types from here. A Function's runtime runs that
 * code on every request and needs none of this: bundled beside it, these schemas would be built
 * before its first response, and for nothing. The one check the runtime does make, of a delivery
 * record's header, is written out by hand (`pack-header.ts`), and held to the schema below by the
 * tests.
 */

/** Route outputs by router and kind, and the two data caches Next.js keeps. */
export const cacheEntryKindSchema = z.enum(CACHE_ENTRY_KINDS);
export type CacheEntryKind = z.infer<typeof cacheEntryKindSchema>;
export const routeEntryKindSchema = z.enum(ROUTE_ENTRY_KINDS);
export type RouteEntryKind = z.infer<typeof routeEntryKindSchema>;

/**
 * One output of an entry's generation: the document, its RSC twin, a segment, the Pages data, a
 * route handler's body, or a data value. Never part of the entry's key.
 */
export const outputRepresentationSchema = z.union([
  z.enum(['html', 'rsc', 'pages-data', 'route-body', 'data-value']),
  z.templateLiteral(['segment:', z.string()]),
]);
export type OutputRepresentation = z.infer<typeof outputRepresentationSchema>;

export const routeEntryDescriptorSchema = z.object({
  kind: routeEntryKindSchema,
  /** The source route, with its dynamic segments: `/blog/[slug]`. */
  route: z.string().startsWith('/'),
  /** The concrete pathname, or the class template for a shell that serves a class of URLs. */
  pathname: z.string().startsWith('/'),
});
export type RouteEntryDescriptor = z.infer<typeof routeEntryDescriptorSchema>;

export const dataEntryDescriptorSchema = z.object({
  kind: z.enum(DATA_ENTRY_KINDS),
  /** The `use cache` handler kind (`default`, `remote`, a custom name); absent for the fetch cache. */
  handler: z.string().min(1).optional(),
  /** Next.js's own cache key; digested, never stored or shown. */
  key: z.string().min(1),
});
export type DataEntryDescriptor = z.infer<typeof dataEntryDescriptorSchema>;

export const entryDescriptorSchema = z.union([
  routeEntryDescriptorSchema,
  dataEntryDescriptorSchema,
]);
export type EntryDescriptor = z.infer<typeof entryDescriptorSchema>;

/** What a screen may show of a key: never a header value, a query value or the raw key. */
export const keyDescriptorSchema = z.object({
  kind: cacheEntryKindSchema,
  route: z.string().optional(),
  pathname: z.string().optional(),
  handler: z.string().optional(),
  /** The query names Next.js lets an ISR render see; recorded, not part of the key. */
  allowQuery: z.array(z.string()).optional(),
});
export type KeyDescriptor = z.infer<typeof keyDescriptorSchema>;

export const tagKindSchema = z.enum(TAG_KINDS);
export type TagKind = z.infer<typeof tagKindSchema>;

/** One tag a generation carries, as the generation records it. */
export const generationTagSchema = z.object({
  kind: tagKindSchema,
  /** Exact, case-sensitive; never normalised. */
  value: z.string().min(1).max(MAX_TAG_LENGTH),
});
export type GenerationTag = z.infer<typeof generationTagSchema>;

export const durationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('finite'), seconds: z.number().nonnegative() }),
  z.object({ kind: z.literal('unbounded') }),
  z.object({ kind: z.literal('unknown') }),
]);
export type Duration = z.infer<typeof durationSchema>;

export const deadlineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), unixMs: z.number().int() }),
  z.object({ kind: z.literal('never') }),
  z.object({ kind: z.literal('unknown') }),
]);
export type Deadline = z.infer<typeof deadlineSchema>;

/** Where a policy's numbers came from; `legacy-unknown` is a record that predates them. */
export const cachePolicySourceSchema = z.enum(CACHE_POLICY_SOURCES);
export type CachePolicySource = z.infer<typeof cachePolicySourceSchema>;

export const cachePolicySchema = z.object({
  revalidateAfter: durationSchema,
  expireAfter: durationSchema,
  /** For the client router only; never part of a server-side expiry. */
  clientStale: durationSchema,
  source: cachePolicySourceSchema,
});
export type CachePolicy = z.infer<typeof cachePolicySchema>;

export const cacheTimingSchema = z.object({
  /** When Next.js says the generation was made; `null` when the origin is not recorded. */
  cacheTimestamp: z.number().int().nullable(),
  producedAt: z.number().int().nullable(),
  revalidateAt: deadlineSchema,
  expireAt: deadlineSchema,
});
export type CacheTiming = z.infer<typeof cacheTimingSchema>;

export const validitySchema = z.enum(['fresh', 'stale', 'expired', 'unknown']);
export type Validity = z.infer<typeof validitySchema>;

/** What the host recorded against a generation when something it depends on was invalidated. */
export const invalidationStateSchema = z.object({
  /** The invalidation's revision, so a later generation is never condemned by an earlier record. */
  revision: z.number().int().nonnegative(),
  /** From when the generation is stale (unix ms). */
  staleAt: z.number().int().optional(),
  /** From when it may no longer be served at all (unix ms). */
  hardExpireAt: z.number().int().optional(),
});
export type InvalidationState = z.infer<typeof invalidationStateSchema>;

export const artifactRoleSchema = z.enum(ARTIFACT_ROLES);
export type ArtifactRole = z.infer<typeof artifactRoleSchema>;

export const artifactEncodingSchema = z.enum(ARTIFACT_ENCODINGS);
export type ArtifactEncoding = z.infer<typeof artifactEncodingSchema>;

export const cacheArtifactRefSchema = z.object({
  /** Resolvable only through an authorized scope; says nothing about where the bytes are. */
  artifactId: z.string().min(1),
  sha256: sha256HexSchema,
  byteLength: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  encoding: artifactEncodingSchema,
  role: artifactRoleSchema,
  /** Internal: the storage key. Stripped before anything reaches a browser. */
  storageRef: z.string().min(1),
});
export type CacheArtifactRef = z.infer<typeof cacheArtifactRefSchema>;

export const publicArtifactRefSchema = cacheArtifactRefSchema.omit({ storageRef: true });
export type PublicArtifactRef = z.infer<typeof publicArtifactRefSchema>;

export const outputComputeSchema = z.enum(['static', 'resuming', 'blocking', 'unknown']);
export type OutputCompute = z.infer<typeof outputComputeSchema>;
export const outputResponseSchema = z.enum(['empty', 'initial', 'complete', 'unknown']);
export type OutputResponse = z.infer<typeof outputResponseSchema>;

const headerValueSchema = z.union([z.string(), z.array(z.string())]);
/** Response headers as Next.js records them: a header set more than once is an array. */
export const headerValuesSchema = z.record(z.string(), headerValueSchema);

export const outputSnapshotSchema = z.object({
  outputId: z.string().min(1),
  /** Which representation of the entry this is: `html`, `rsc`, `segment:<path>`, `pages-data`, … */
  representationKey: z.string().min(1),
  pathname: z.string().nullable(),
  status: z.number().int().nullable(),
  headers: headerValuesSchema,
  compute: outputComputeSchema,
  response: outputResponseSchema,
  /** Only the App Router document carries one. */
  htmlSize: z.number().int().nonnegative().nullable(),
  artifacts: z.array(cacheArtifactRefSchema),
});
export type OutputSnapshot = z.infer<typeof outputSnapshotSchema>;

export const publicOutputSnapshotSchema = outputSnapshotSchema.extend({
  artifacts: z.array(publicArtifactRefSchema),
});
export type PublicOutputSnapshot = z.infer<typeof publicOutputSnapshotSchema>;

/** Whether a generation came out of a build or out of a regeneration at runtime. */
export const generationSourceKindSchema = z.enum(GENERATION_SOURCE_KINDS);
export type GenerationSourceKind = z.infer<typeof generationSourceKindSchema>;

/** An artifact as a record names it: the reference, and which of the generation's outputs it is. */
export const packArtifactRefSchema = publicArtifactRefSchema.extend({
  representationKey: z.string().min(1),
  /** Internal delivery locator; public artifact/inspector responses still omit it. */
  storageRef: z.string().min(1).optional(),
});
export type PackArtifactRef = z.infer<typeof packArtifactRefSchema>;

/** The header of a delivery record (`pack.ts`). */
export const generationPackHeaderSchema = z.object({
  schemaVersion: z.literal(PACK_SCHEMA_VERSION),
  scopeId: z.string().min(1),
  entryId: z.string().min(1),
  generationId: z.string().min(1),
  seq: z.number().int().positive(),
  source: generationSourceKindSchema,
  kind: routeEntryKindSchema,
  route: z.string().startsWith('/'),
  pathname: z.string().startsWith('/'),
  cacheTimestamp: z.number().int().nullable(),
  producedAt: z.number().int().nullable(),
  policy: cachePolicySchema,
  status: z.number().int(),
  /**
   * What the entry is answered with, already filtered for the kind of entry it is
   * (`generationResponseHeaders`): a page's to what an edge-served shell may replay, and a
   * redirect's to where it leads as well; a route handler's — which only its Function serves — to
   * what a response replayed whole may.
   */
  headers: z.record(z.string(), z.string()),
  /** Lifted from the render's own `x-next-cache-tags` before that header was filtered away. */
  tags: z.array(generationTagSchema).max(MAX_TAGS_PER_ENTRY),
  htmlSha256: sha256HexSchema,
  htmlLength: z.number().int().nonnegative(),
  /** `null` and a length of zero for a page complete at render time: nothing resumes it. */
  postponedSha256: sha256HexSchema.nullable(),
  postponedLength: z.number().int().nonnegative(),
  /**
   * The generation's other outputs (a page's data, the RSC payload, each prefetched segment);
   * read through the host, not from here. Each carries the key of the output it belongs to,
   * which is what a request for one of them names — the role alone cannot tell two segments apart.
   */
  artifacts: z.array(packArtifactRefSchema),
  /** The scope revision this record was written at. */
  revision: z.number().int().nonnegative(),
  invalidation: invalidationStateSchema.optional(),
});
export type GenerationPackHeader = z.infer<typeof generationPackHeaderSchema>;
