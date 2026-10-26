import { KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import type { SeedScopeInput } from '@stayingupwind/host/cache';

import type { MutationPipeline } from '../scope/mutation-pipeline.ts';
import { applySeedScope, needsSeedVerification, planSeedEntries } from '../scope/seed.ts';
import { isRefusal, refuse } from '../scope/state.ts';
import type { CacheFiles } from './files.ts';
import type { NativeCacheWorkerOptions } from './protocol.ts';
import { readSeedArtifact, validateSeedArtifact } from './seed-artifact.ts';

const SEED_BATCH_SIZE = 200;

async function copyBuildArtifacts(
  options: NativeCacheWorkerOptions,
  files: CacheFiles,
  maximumArtifactBytes: number,
): Promise<void> {
  const seed = options.seed;
  if (seed === undefined) return;
  for (const entry of seed.entries) {
    for (const output of entry.generation.outputs) {
      for (const artifact of output.artifacts) {
        validateSeedArtifact(artifact, maximumArtifactBytes);
        if (await files.blobs.exists(artifact.storageRef)) continue;
        const bytes = await readSeedArtifact(seed.blobsDirectory, artifact, maximumArtifactBytes);
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
  maximumArtifactBytes: number,
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
  await copyBuildArtifacts(options, files, maximumArtifactBytes);
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
