import { sha256HexSchema } from '../artifact/artifact.ts';
import * as z from '../schema/index.ts';

/**
 * What a blob is served as.
 *
 * The adapter writes a media type, but the bundle is uploaded as JSON by whoever owns the project,
 * and this string is put in a `content-type` header — by the edge on the hot path, by the shell
 * a reader that frames a build's shells, by the Cache API write behind a static file. A value a header cannot hold makes the
 * response fail to build where it is served rather than where it was accepted, so the upload is
 * where it is refused: printable ASCII (no newline can split a response, no control character can
 * confuse a parser) with the slash a media type has.
 */
const contentTypeSchema = z
  .string()
  .min(1)
  .regex(/^[\u{20}-\u{7E}]+$/u, 'expected printable ASCII')
  .refine((value) => value.includes('/'), 'expected a media type');

/** A file in the bundle, named by content. */
export const blobRefSchema = z.object({
  sha256: sha256HexSchema,
  byteLength: z.number().int().nonnegative(),
  contentType: contentTypeSchema,
});
export type BlobRef = z.infer<typeof blobRefSchema>;
