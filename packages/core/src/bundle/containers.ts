import * as z from '../schema/index.ts';

const MAX_PATH_LENGTH = 1024;
const MAX_REFERENCE_LENGTH = 2048;

/** Source paths belong to the project; a build context may name its root. */
function projectPath(allowRoot: boolean): z.StringSchema {
  return z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .refine((value) => {
      return (
        (allowRoot && value === '.') ||
        (!value.startsWith('/') &&
          !value.includes('\\') &&
          !/[\p{Cc}:]/u.test(value) &&
          value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
      );
    }, 'a project-relative path without traversal');
}

const dockerfileImageSchema = z.strictObject({
  dockerfile: projectPath(false),
  buildContext: projectPath(true).optional(),
});
const imageReferenceSchema = z
  .string()
  .min(1)
  .max(MAX_REFERENCE_LENGTH)
  .regex(/^[A-Za-z0-9][\w.:/@-]*$/u, 'a container image reference')
  .refine((value) => !value.includes('://'), 'an image reference rather than a URL');
const existingImageSchema = z.strictObject({ reference: imageReferenceSchema });
const containerImageSchema = z.union([dockerfileImageSchema, existingImageSchema]);

/** Build input, independent of the digest a host prepares for a particular deployment. */
export const containerDefinitionSchema = z.strictObject({
  image: containerImageSchema,
  instanceType: z.enum(['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4']),
  maxInstances: z.number().int().positive(),
});
export type ContainerDefinition = z.infer<typeof containerDefinitionSchema>;

/** Versions that require a host to attach a default-policy Container to its owner namespace. */
export const CONTAINER_BUNDLE_VERSION = 7;
export const CONTAINER_SPLIT_BUNDLE_VERSION = 8;
