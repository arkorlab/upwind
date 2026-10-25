import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import type { SeedScopeInput } from '@stayingupwind/host/cache';

import type { MutationPipeline } from '../scope/mutation-pipeline.ts';
import { applySeedScope, needsSeedVerification, planSeedEntries } from '../scope/seed.ts';
import { isRefusal, refuse } from '../scope/state.ts';
import type { CacheFiles } from './files.ts';
import type { NativeCacheWorkerOptions } from './protocol.ts';

const SEED_BATCH_SIZE = 200;

async function copyBuildArtifacts(
  options: NativeCacheWorkerOptions,
  files: CacheFiles,
): Promise<void> {
  const seed = options.seed;
  if (seed === undefined) return;
  for (const entry of seed.entries) {
    for (const output of entry.generation.outputs) {
      for (const artifact of output.artifacts) {
        if (await files.blobs.exists(artifact.storageRef)) continue;
        // The build's own SHA-256 names this file, never a public URL or request path.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const bytes = await readFile(path.join(seed.blobsDirectory, artifact.sha256));
        if (
          bytes.byteLength !== artifact.byteLength ||
          createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
        ) {
          throw new Error('native cache build artifact does not match its digest');
        }
        await files.blobs.write(artifact.storageRef, bytes, artifact.contentType);
      }
    }
  }
}

/** Seed is idempotent; the shared planner skips entries that this deployment already owns. */
export async function seedNativeCache(
  options: NativeCacheWorkerOptions,
  files: CacheFiles,
  pipeline: MutationPipeline,
  settle: () => Promise<void>,
): Promise<void> {
  const scope: SeedScopeInput['scope'] = {
    scopeId: options.scopeId,
    organizationId: 'native',
    projectId: 'native',
    environmentId: 'production',
    deploymentId: options.deploymentId ?? options.scopeId,
    keySchemaVersion: KEY_SCHEMA_VERSION,
    buildId: options.buildId,
  };
  const outcome = await pipeline.run(Date.now(), (tx) => () => applySeedScope(tx, { scope }), {
    seed: { kind: 'conflict', reason: 'the scope is retired' },
    atOnce: true,
  });
  if (outcome.kind === 'conflict') throw new Error(`native cache: ${outcome.reason}`);
  const seed = options.seed;
  if (seed === undefined) return;
  await copyBuildArtifacts(options, files);
  for (let offset = 0; offset < seed.entries.length; offset += SEED_BATCH_SIZE) {
    const result = await pipeline.run(
      Date.now(),
      (tx) => {
        return planSeedEntries(tx, {
          scopeId: scope.scopeId,
          batchIndex: offset / SEED_BATCH_SIZE,
          entries: seed.entries.slice(offset, offset + SEED_BATCH_SIZE),
        });
      },
      { empty: refuse('not_found', 'the native cache is not seeded') },
    );
    if (isRefusal(result)) throw new Error(`native cache ${result.code}: ${result.message}`);
    if (needsSeedVerification(result) || 'jobId' in result)
      throw new Error('native cache could not verify its build seed');
    if (result.refused.length > 0)
      throw new Error(`native cache seed refused: ${result.refused[0]?.reason ?? 'unknown'}`);
  }
  await settle();
}
