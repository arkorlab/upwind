import { z } from 'zod';

import { RESOURCES_MANIFEST_BINDING } from '../paas/resources.ts';

const MAX_NAME_LENGTH = 64;
const MAX_MODULE_LENGTH = 1024;
const MAX_EXPORT_LENGTH = 128;
const MAX_DURABLE_OBJECTS = 10;

/** A host-owned registration; paths are relative to the application's project directory. */
export const durableObjectDeclarationSchema = z.strictObject({
  name: z
    .string()
    .max(MAX_NAME_LENGTH)
    .regex(/^[A-Za-z_]\w*$/u, 'a binding name')
    .refine(
      (value) => value !== RESOURCES_MANIFEST_BINDING && value !== '__proto__',
      'the resource manifest and prototype setter names are reserved',
    ),
  module: z
    .string()
    .min(1)
    .max(MAX_MODULE_LENGTH)
    .refine((value) => {
      return (
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !/[\p{Cc}:]/u.test(value) &&
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
      );
    }, 'a project-relative module path without traversal'),
  // eslint-disable-next-line unicorn/no-keyword-prefix -- Matches the host registration field.
  className: z
    .string()
    .max(MAX_EXPORT_LENGTH)
    .regex(/^[A-Za-z_$][\w$]*$/u, 'a named class export')
    .refine((value) => value !== 'default', 'a named export rather than the default export'),
});
export type DurableObjectDeclaration = z.infer<typeof durableObjectDeclarationSchema>;

export const durableObjectDeclarationsSchema = z
  .array(durableObjectDeclarationSchema)
  .max(MAX_DURABLE_OBJECTS)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.name)).size === entries.length,
    'Durable Object binding names must be unique',
  );

/** Namespace identity stays independent of the customer's source class name. */
export const DURABLE_OBJECT_EXPORT = 'UpwindDurableObject';
export const DURABLE_OBJECT_BUNDLE_VERSION = 5;
export const DURABLE_OBJECT_SPLIT_BUNDLE_VERSION = 6;
