import * as z from '../schema/index.ts';
import { MAX_TAG_LENGTH, TAG_KINDS } from './keys.ts';

/** The tag vocabulary shared by manifests and delivery records, without the other cache schemas. */
export const tagKindSchema = z.enum(TAG_KINDS);
export type TagKind = z.infer<typeof tagKindSchema>;

/** One tag recorded by a build or generation; exact and case-sensitive. */
export const generationTagSchema = z.object({
  kind: tagKindSchema,
  value: z.string().min(1).max(MAX_TAG_LENGTH),
});
export type GenerationTag = z.infer<typeof generationTagSchema>;
