import {
  compactCacheArtifact,
  isRepairStorageRef,
  type OutputSnapshot,
  outputSnapshotSchema,
} from '@stayingupwind/core/cache';
import { toZod } from '@stayingupwind/host/zod';
import { z } from 'zod';

const ordinaryOutput = toZod(outputSnapshotSchema);
const ordinaryArtifact = ordinaryOutput.shape.artifacts.element;
const fields = ordinaryArtifact.shape;
const repairTuple = z
  .tuple([
    fields.artifactId,
    fields.sha256,
    fields.byteLength,
    fields.contentType,
    fields.encoding,
    fields.role,
    fields.storageRef.refine(isRepairStorageRef),
  ])
  .transform(([artifactId, sha256, byteLength, contentType, encoding, role, storageRef]) => {
    return { artifactId, sha256, byteLength, contentType, encoding, role, storageRef };
  });
// The ordinary shape is first: legacy rows take the same artifact parser without an extra walk.
const storedArtifact = z.union([ordinaryArtifact, repairTuple]);
const storedOutputs = z.array(ordinaryOutput.extend({ artifacts: z.array(storedArtifact) }));

/** Existing rows keep their literal keys; repair tuples expand to the same internal artifact shape. */
export function decodeStoredOutputs(text: string): OutputSnapshot[] {
  return storedOutputs.parse(JSON.parse(text));
}

/**
 * Enable only for a scope whose immutable consumers have been verified. Ordinary artifacts remain
 * objects. First repair saves at least 14 JSON bytes; a tuple's next repair replaces a fixed-width
 * ASCII key with another of the same width. Shape alone never proves ownership or a fresh PUT.
 */
export function encodeStoredOutputs(outputs: readonly OutputSnapshot[], compact = false): string {
  if (!compact) return JSON.stringify(outputs);
  return JSON.stringify(
    outputs.map((output) => {
      return {
        ...output,
        artifacts: output.artifacts.map((artifact) => compactCacheArtifact(artifact)),
      };
    }),
  );
}
