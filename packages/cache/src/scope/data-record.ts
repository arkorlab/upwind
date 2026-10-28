import { invalidationStateSchema } from '@stayingupwind/core/cache';
import * as z from '@stayingupwind/core/schema';
import { dataEntryMetadataSchema } from '@stayingupwind/host/cache';

/**
 * The data-cache record in KV, the one shape the read gateway parses. The authority writes it
 * (`records.ts`), and both gateways read it back for every data-cache read a render makes.
 *
 * Written with core's validator (`@stayingupwind/core/schema`) rather than zod, as the gateway's
 * request schemas are, and kept apart from `records.ts`: the read gateway's isolate builds every
 * schema the modules it imports define before it answers its first read, and zod, with what
 * `records.ts` imports, is most of what it would load to read this one.
 */

export const DATA_RECORD_SCHEMA_VERSION = 1;

const dataValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), base64: z.string() }),
  z.object({
    kind: z.literal('ref'),
    artifactId: z.string().min(1),
    storageRef: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
  }),
]);

/** The data-cache record in KV, read by the gateway alone: its storage key never leaves it. */
export const dataRecordSchema = z.object({
  schemaVersion: z.literal(DATA_RECORD_SCHEMA_VERSION),
  scopeId: z.string().min(1),
  entryId: z.string().min(1),
  generationId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  dependencyRevision: z.number().int().nonnegative(),
  entry: dataEntryMetadataSchema,
  value: dataValueSchema,
  invalidation: invalidationStateSchema.optional(),
});
export type DataRecord = z.infer<typeof dataRecordSchema>;
