import type { CacheArtifactRef, PackArtifactRef } from './schema.ts';

/** Fresh repair locations have a fixed ASCII width, independent of scope and attempt names. */
export const REPAIR_STORAGE_REF_LENGTH = 67;
const PACK_ARTIFACT_TUPLE_LENGTH = 8;
const REPAIR_STORAGE_REF = /^r\/[0-9a-f]{32}\/[0-9a-f]{32}$/u;

/** A shape, never evidence that a scope owns an object or that a replacement was written. */
export function isRepairStorageRef(value: unknown): value is string {
  return typeof value === 'string' && REPAIR_STORAGE_REF.test(value);
}

/** The rare repair writer still needs a successful conditional PUT receipt for this location. */
export function createRepairStorageNamespace(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** The scope retains its namespace for orphan/retirement cleanup; only the nonce changes. */
export function createRepairStorageRef(namespace: string): string {
  if (!/^[0-9a-f]{32}$/u.test(namespace)) throw new Error('invalid repair storage namespace');
  return `r/${namespace}/${crypto.randomUUID().replaceAll('-', '')}`;
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
export type RepairPackArtifactTuple = readonly [
  ...artifact: RepairArtifactTuple,
  representationKey: string,
];

/**
 * Ordinary references remain objects, including arbitrarily short borrowed literals. Removing the
 * seven property names saves 80 bytes, more than the 66-byte maximum growth from a shortest
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
  if (value.length !== PACK_ARTIFACT_TUPLE_LENGTH || !isRepairStorageRef(value[6]))
    return undefined;
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
