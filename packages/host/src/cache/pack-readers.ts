import { sha256HexSchema } from '@stayingupwind/core/artifact';
import { z } from 'zod';

import { toZod } from '../zod/index.ts';

const sha256 = toZod(sha256HexSchema);
const platformReader = z.object({
  /** Actual deployed version identity, retained with the rollout's audit evidence. */
  versionId: z.string().min(1),
  moduleSha256: sha256,
});
export const platformPackReadersSchema = z.object({
  edge: platformReader,
  authority: platformReader,
  gateway: platformReader,
  readGateway: platformReader,
});

/**
 * A trusted deploy host's approval of actual reviewed bytes, never a declaration taken from a
 * project's bundle. The module digest names the complete bundled runtime and cache host together;
 * host identity/source digest retain why those bytes were approved. A filename or SDK version
 * alone does not establish this, because a custom cache host can carry an older pack decoder.
 */
export const approvedFunctionPackReaderSchema = z.object({
  mainModuleSha256: sha256,
  hostIdentity: z.string().min(1),
  hostModuleSha256: sha256,
});
export const approvedPackReaderRolloutSchema = z.object({
  schemaVersion: z.literal(2),
  /** The trusted release system's durable all-traffic rollout evidence, not a visitor probe. */
  rolloutId: z.string().min(1),
  platform: platformPackReadersSchema,
  functions: z.array(approvedFunctionPackReaderSchema).min(1),
});
export type ApprovedPackReaderRollout = z.infer<typeof approvedPackReaderRolloutSchema>;

const scopePackConsumerSchema = approvedFunctionPackReaderSchema.extend({
  name: z.string().min(1),
  mainModule: z.string().min(1),
});

export const scopePackReadersSchema = z.object({
  schemaVersion: z.literal(2),
  rolloutId: z.string().min(1),
  deploymentId: z.string().min(1),
  buildId: z.string().min(1),
  platform: platformPackReadersSchema,
  consumers: z.array(scopePackConsumerSchema).min(1),
});
export type ScopePackReaders = z.infer<typeof scopePackReadersSchema>;
