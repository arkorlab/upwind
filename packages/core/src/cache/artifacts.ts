import { z } from 'zod';

import { sha256HexSchema } from '../artifact/artifact.ts';

/**
 * The outputs of one generation and the bytes behind them.
 *
 * An artifact reference names bytes by content and by the role they play; `storageRef` is where the
 * platform keeps them and never leaves a Worker — a browser gets an `artifactId` that only resolves
 * inside an authorized scope. An output snapshot is one response of the generation (the document,
 * its RSC twin, a segment, the Pages data, a route body), with the status and headers it is served
 * with and the artifacts it is made of. A legitimate zero-byte body is an artifact of length zero;
 * an output with no artifacts is one that has no body to keep, which is a different thing.
 */

export const artifactRoleSchema = z.enum([
  'html',
  'rsc',
  'segment',
  'pages-data',
  'route-body',
  'data-value',
  'postponed',
]);
export type ArtifactRole = z.infer<typeof artifactRoleSchema>;

export const artifactEncodingSchema = z.enum(['identity', 'gzip', 'br']);
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

/** The same reference without its storage key: the form that may leave a Worker. */
export function publicArtifactRef(ref: CacheArtifactRef): PublicArtifactRef {
  return {
    artifactId: ref.artifactId,
    sha256: ref.sha256,
    byteLength: ref.byteLength,
    contentType: ref.contentType,
    encoding: ref.encoding,
    role: ref.role,
  };
}

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

export function publicOutputSnapshot(output: OutputSnapshot): PublicOutputSnapshot {
  return { ...output, artifacts: output.artifacts.map((artifact) => publicArtifactRef(artifact)) };
}
