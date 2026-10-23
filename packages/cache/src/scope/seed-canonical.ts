import { isRepairStorageRef, type OutputSnapshot } from '@stayingupwind/core/cache';

import { artifactFailed, findArtifactBySha } from './artifacts.ts';
import type { TxInput } from './tx.ts';

/** V2 seeds reuse this scope's repaired canonical copy, preserving existing borrowed accounting. */
export function canonicalSeedOutputs(
  input: TxInput,
  outputs: readonly OutputSnapshot[],
): readonly OutputSnapshot[] {
  if (input.packSchemaVersion !== 2 || input.repairNamespace === undefined) return outputs;
  const prefix = `r/${input.repairNamespace}/`;
  return outputs.map((output) => {
    return {
      ...output,
      artifacts: output.artifacts.map((artifact) => {
        const canonical = findArtifactBySha(input.sql, artifact.sha256);
        return canonical?.byte_length === artifact.byteLength &&
          isRepairStorageRef(canonical.storage_ref) &&
          canonical.storage_ref.startsWith(prefix) &&
          !artifactFailed(input.sql, canonical)
          ? { ...artifact, storageRef: canonical.storage_ref }
          : artifact;
      }),
    };
  });
}
