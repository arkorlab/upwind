import type {
  CacheArtifactRef,
  OutputSnapshot,
  PublicArtifactRef,
  PublicOutputSnapshot,
} from './schema.ts';

export type {
  ArtifactEncoding,
  ArtifactRole,
  CacheArtifactRef,
  OutputCompute,
  OutputResponse,
  OutputSnapshot,
  PublicArtifactRef,
  PublicOutputSnapshot,
} from './schema.ts';

/**
 * The outputs of one generation and the bytes behind them.
 *
 * An artifact reference names bytes by content and by the role they play; `storageRef` is where the
 * platform keeps them and never leaves a Function — a browser gets an `artifactId` that only resolves
 * inside an authorized scope. An output snapshot is one response of the generation (the document,
 * its RSC twin, a segment, the Pages data, a route body), with the status and headers it is served
 * with and the artifacts it is made of. A legitimate zero-byte body is an artifact of length zero;
 * an output with no artifacts is one that has no body to keep, which is a different thing.
 *
 * The shapes are checked in `schema.ts`, which nothing here imports (see `keys.ts`).
 */

/** What an artifact is to its generation (`artifactRoleSchema`). */
export const ARTIFACT_ROLES = [
  'html',
  'rsc',
  'segment',
  'pages-data',
  'route-body',
  'data-value',
  'postponed',
] as const;

/** How an artifact's bytes are stored (`artifactEncodingSchema`). */
export const ARTIFACT_ENCODINGS = ['identity', 'gzip', 'br'] as const;

/** The same reference without its storage key: the form that may leave a Function. */
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

export function publicOutputSnapshot(output: OutputSnapshot): PublicOutputSnapshot {
  return { ...output, artifacts: output.artifacts.map((artifact) => publicArtifactRef(artifact)) };
}
