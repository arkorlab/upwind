import { z } from 'zod';

import { deploymentFingerprintSchema } from '../deployment/fingerprint.ts';

/** What an artifact is, independent of where it is placed. */
export const artifactKindSchema = z.enum([
  'ppr-shell',
  'static-rsc',
  'immutable-asset',
  'document-static',
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const SHA256_HEX_LENGTH = 64;
export const sha256HexSchema = z
  .string()
  .length(SHA256_HEX_LENGTH)
  .regex(/^[0-9a-f]+$/u, 'expected lower-case hex');

const artifactLocatorSchema = z.object({
  sha256: sha256HexSchema,
  byteLength: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});
/** What a shell store needs to find and verify bytes: their hash, length and type, whatever they encode. */
export type ArtifactLocator = z.infer<typeof artifactLocatorSchema>;

/**
 * Content-addressed reference to bytes as the origin serves them. Proof, prefix comparison and
 * validation all work on these; a compressed rendering is a separate `EncodedShellRef`.
 */
export const artifactRefSchema = artifactLocatorSchema.extend({
  encoding: z.literal('identity'),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const shellEncodingSchema = z.enum(['br', 'gzip']);
export type ShellEncoding = z.infer<typeof shellEncodingSchema>;

/**
 * A shell compressed ahead of time, content-addressed like any artifact.
 *
 * The bytes are the *unfinished head* of a stream, not a complete one: the edge appends the
 * suffix as uncompressed blocks and closes the stream itself (see `splice/wire.ts`). A gzip
 * rendering carries the CRC-32 of the identity shell, which its trailer needs continued over the
 * suffix; without it the stream could not be closed, so a gzip reference cannot omit it.
 */
const brotliShellRefSchema = artifactLocatorSchema.extend({ encoding: z.literal('br') });
/** The trailer writes the CRC as four bytes; a value that does not fit is not a CRC-32. */
const UINT32_MAX = 0xff_ff_ff_ff;
const gzipShellRefSchema = artifactLocatorSchema.extend({
  encoding: z.literal('gzip'),
  crc32: z.number().int().nonnegative().max(UINT32_MAX),
});
export const encodedShellRefSchema = z.discriminatedUnion('encoding', [
  brotliShellRefSchema,
  gzipShellRefSchema,
]);
export type EncodedShellRef = z.infer<typeof encodedShellRefSchema>;

/**
 * The compressed renderings a route's shell has, by encoding; absent means identity only. Each
 * key admits only the reference of its own encoding, so a manifest cannot advertise one coding
 * and deliver another.
 */
export const shellEncodingsSchema = z.object({
  br: brotliShellRefSchema.optional(),
  gzip: gzipShellRefSchema.optional(),
});
export type ShellEncodings = z.infer<typeof shellEncodingsSchema>;

/** Renderings by encoding, or `undefined` when there are none; a later duplicate is ignored. */
export function shellEncodingsOf(refs: readonly EncodedShellRef[]): ShellEncodings | undefined {
  const br = refs.find((ref) => ref.encoding === 'br');
  const gzip = refs.find((ref) => ref.encoding === 'gzip');
  if (br === undefined && gzip === undefined) {
    return undefined;
  }
  return { ...(br !== undefined && { br }), ...(gzip !== undefined && { gzip }) };
}

/** Full artifact record: the reference plus provenance. */
export const artifactSchema = artifactRefSchema.extend({
  kind: artifactKindSchema,
  sourcePath: z.string().min(1),
  sourceOrigin: z.string().min(1),
  deployment: deploymentFingerprintSchema,
  capturedAt: z.iso.datetime(),
});
export type Artifact = z.infer<typeof artifactSchema>;

/** Deterministic locator per backend; the hot path never needs a placement lookup. */
export function kvArtifactKey(sha256: string): string {
  return `art:${sha256}`;
}

export function r2ArtifactKey(sha256: string): string {
  return `artifacts/${sha256}`;
}

export function staticAssetShellPath(sha256: string): string {
  return `/__arkor/shell/${sha256}`;
}
