import * as z from '../schema/index.ts';
import { blobRefSchema } from './blob.ts';

export const functionModuleTypeSchema = z.enum(['esm', 'commonjs', 'text', 'json', 'wasm', 'data']);
export type FunctionModuleType = z.infer<typeof functionModuleTypeSchema>;

export const functionModuleSchema = z.object({
  /** Module path inside the Function (`index.mjs`, `.next/server/app-paths-manifest.json`). */
  name: z.string().min(1),
  type: functionModuleTypeSchema,
  blob: blobRefSchema,
});
export type FunctionModule = z.infer<typeof functionModuleSchema>;

/** A Function as it will be uploaded: its modules, entry, and the runtime it was built for. */
export const workerFunctionSchema = z.object({
  runtime: z.literal(undefined).optional(),
  mainModule: z.string().min(1),
  modules: z.array(functionModuleSchema),
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  compatibilityFlags: z.array(z.string()),
});
export type WorkerFunctionSpec = z.infer<typeof workerFunctionSchema>;

/** Paths in an artifact are portable names, never host paths or parent traversals. */
export const nodeArtifactPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => {
    return (
      !value.startsWith('/') &&
      !/[\\:\p{Cc}]/u.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    );
  }, 'expected a portable artifact-relative path');

export const nodeContainerAbiSchema = z.strictObject({
  nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  nodeAbi: z.string().regex(/^\d+$/u),
  platform: z.literal('linux'),
  arch: z.literal('x64'),
  libc: z.literal('glibc'),
});

export const nodeContainerFunctionSchema = z.strictObject({
  runtime: z.literal('node-container'),
  artifact: blobRefSchema.refine(
    (ref) =>
      ref.contentType === 'application/gzip' &&
      ref.byteLength > 0 &&
      ref.byteLength <= 256 * 1024 * 1024,
    'expected a tar.gz artifact of at most 256 MiB',
  ),
  entrypoint: nodeArtifactPathSchema,
  abi: nodeContainerAbiSchema,
});
export type NodeContainerFunctionSpec = z.infer<typeof nodeContainerFunctionSchema>;
export const functionSchema = z.union([nodeContainerFunctionSchema, workerFunctionSchema]);
export type FunctionSpec = z.infer<typeof functionSchema>;

export function isNodeContainerFunction(spec: FunctionSpec): spec is NodeContainerFunctionSpec {
  return 'runtime' in spec && spec.runtime === 'node-container';
}
