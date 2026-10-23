import type { CacheArtifactRef, PackArtifactRef } from './schema.ts';

/** Fresh repair locations have a fixed ASCII width, independent of scope and attempt names. */
export const REPAIR_STORAGE_REF_LENGTH = 43;
const REPAIR_STORAGE_REF =
  /^repair\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A shape, never evidence that a scope owns an object or that a replacement was written. */
export function isRepairStorageRef(value: unknown): value is string {
  return typeof value === 'string' && REPAIR_STORAGE_REF.test(value);
}

/** The rare repair writer still needs a successful conditional PUT receipt for this location. */
export function createRepairStorageRef(): string {
  return `repair/${crypto.randomUUID()}`;
}

/** Fixed order in SQL, retaining every mandatory artifact value and its meaning. */
export type RepairArtifactTuple = readonly [
  artifactId: string,
  sha256: string,
  byteLength: number,
  contentType: string,
  encoding: CacheArtifactRef['encoding'],
  role: CacheArtifactRef['role'],
  storageRef: string,
];
export type RepairPackArtifactTuple = readonly [...RepairArtifactTuple, representationKey: string];

/**
 * Ordinary references remain objects, including arbitrarily short borrowed literals. Removing the
 * seven property names saves 80 bytes, more than the 42-byte maximum growth from a shortest
 * literal to a fresh repair key. A tuple's next repair key has the same fixed JSON width.
 */
export function compactCacheArtifact(
  artifact: CacheArtifactRef,
): CacheArtifactRef | RepairArtifactTuple {
  if (!isRepairStorageRef(artifact.storageRef)) return artifact;
  return [
    artifact.artifactId,
    artifact.sha256,
    artifact.byteLength,
    artifact.contentType,
    artifact.encoding,
    artifact.role,
    artifact.storageRef,
  ];
}

/** The eighth property name saves another 20 bytes; absent locations stay ordinary objects. */
export function compactPackArtifact(
  artifact: PackArtifactRef,
): PackArtifactRef | RepairPackArtifactTuple {
  if (!isRepairStorageRef(artifact.storageRef)) return artifact;
  return [
    artifact.artifactId,
    artifact.sha256,
    artifact.byteLength,
    artifact.contentType,
    artifact.encoding,
    artifact.role,
    artifact.storageRef,
    artifact.representationKey,
  ];
}

/** Fields for the existing fast validator to check, only for version-two repair tuples. */
export function repairPackArtifactFields(
  value: readonly unknown[],
): Record<string, unknown> | undefined {
  if (value.length !== 8 || !isRepairStorageRef(value[6])) return undefined;
  const [
    artifactId,
    sha256,
    byteLength,
    contentType,
    encoding,
    role,
    storageRef,
    representationKey,
  ] = value;
  return {
    artifactId,
    sha256,
    byteLength,
    contentType,
    encoding,
    role,
    storageRef,
    representationKey,
  };
}
