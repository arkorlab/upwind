import * as z from '../schema/index.ts';
import { blobRefSchema } from './blob.ts';

const MAX_ARTIFACT_PATH_LENGTH = 240;
const MAX_NATIVE_ARTIFACT_BYTES = 268_435_456;
const COMPATIBILITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Earliest Cloudflare Workers compatibility date accepted for a bundled Function (`nodejs_compat` v2). */
export const MIN_WORKER_COMPATIBILITY_DATE = '2024-09-23';

/**
 * Safe Cloudflare Workers compatibility flags a bundled Function may request. Flags that weaken
 * egress isolation or alter network semantics (`disable_global_fetch_strictly_public`,
 * `allow_custom_ports`, `fetcher_no_get_put_delete_body`, `experimental`, and unknown flags) are
 * excluded.
 */
export const WORKER_COMPATIBILITY_FLAGS = [
  'allow_importable_env',
  'enable_ctx_exports',
  'enable_nodejs_fs_module',
  'enable_nodejs_http_modules',
  'enable_nodejs_http_server_modules',
  'enable_nodejs_process_v2',
  'enable_request_signal',
  'fetch_iterable_type_support',
  'global_fetch_strictly_public',
  'nodejs_als',
  'nodejs_compat',
  'nodejs_compat_populate_process_env',
  'nodejs_compat_v2',
  'streams_enable_constructors',
  'url_standard',
] as const;

export const workerCompatibilityFlagSchema = z.enum(WORKER_COMPATIBILITY_FLAGS);
export type WorkerCompatibilityFlag = z.infer<typeof workerCompatibilityFlagSchema>;

/* eslint-disable unicorn/prefer-temporal -- Temporal is not available in the Workers runtime. */
function isIsoCalendarDate(value: string): boolean {
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
/* eslint-enable unicorn/prefer-temporal */

export const workerCompatibilityDateSchema = z
  .string()
  .regex(COMPATIBILITY_DATE_PATTERN)
  .refine(
    (value) =>
      !COMPATIBILITY_DATE_PATTERN.test(value) ||
      (isIsoCalendarDate(value) && value >= MIN_WORKER_COMPATIBILITY_DATE),
    `expected a valid YYYY-MM-DD compatibility date on or after ${MIN_WORKER_COMPATIBILITY_DATE}`,
  );

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
  // An empty enum is JSON-Schema representable and refuses every explicit runtime value.
  runtime: z.enum([] as const).optional(),
  mainModule: z.string().min(1),
  modules: z.array(functionModuleSchema),
  compatibilityDate: workerCompatibilityDateSchema,
  compatibilityFlags: z.array(workerCompatibilityFlagSchema),
});
export type WorkerFunctionSpec = z.infer<typeof workerFunctionSchema>;

/** Paths in an artifact are portable names, never host paths or parent traversals. */
export const nodeArtifactPathSchema = z
  .string()
  .min(1)
  .max(MAX_ARTIFACT_PATH_LENGTH)
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
  artifact: blobRefSchema.refine((ref) => {
    return (
      ref.contentType === 'application/gzip' &&
      ref.byteLength > 0 &&
      ref.byteLength <= MAX_NATIVE_ARTIFACT_BYTES
    );
  }, 'expected a tar.gz artifact of at most 256 MiB'),
  entrypoint: nodeArtifactPathSchema,
  abi: nodeContainerAbiSchema,
});
export type NodeContainerFunctionSpec = z.infer<typeof nodeContainerFunctionSchema>;
export const functionSchema = z.union([nodeContainerFunctionSchema, workerFunctionSchema]);
export type FunctionSpec = z.infer<typeof functionSchema>;

export function isNodeContainerFunction(spec: FunctionSpec): spec is NodeContainerFunctionSpec {
  return 'runtime' in spec && spec.runtime === 'node-container';
}
