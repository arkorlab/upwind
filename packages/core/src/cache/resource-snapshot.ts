/** A publisher's original read watermark, in the version domain of its resource-change events. */
export interface ResourceSnapshotWitness {
  readonly resourceId: string;
  readonly version: number;
}

export const RESOURCE_SNAPSHOT_PREFIX = 'upwind:resource-snapshot:v1:';
const RESERVED = 'upwind:resource-snapshot:';
const RESOURCE = /^[a-f\d]{64}$/u;
const WITNESS = /^upwind:resource-snapshot:v1:([a-f\d]{64}):(0|[1-9]\d{0,15})$/u;

function invalid(): TypeError {
  return new TypeError('Invalid resource snapshot witness.');
}

/** The version is retained with the value; later reads cannot renew an earlier witness. */
export function resourceSnapshotTag(witness: ResourceSnapshotWitness): string {
  if (
    !RESOURCE.test(witness.resourceId) ||
    !Number.isSafeInteger(witness.version) ||
    witness.version < 0
  )
    throw invalid();
  return `${RESOURCE_SNAPSHOT_PREFIX}${witness.resourceId}:${String(witness.version)}`;
}

/** Reserved malformed or unsupported witness tags fail closed instead of becoming ordinary tags. */
export function resourceSnapshotOf(tag: string): ResourceSnapshotWitness | undefined {
  if (!tag.startsWith(RESERVED)) return undefined;
  const match = WITNESS.exec(tag);
  const resourceId = match?.[1];
  const version = Number(match?.[2]);
  if (resourceId === undefined || !Number.isSafeInteger(version) || version < 0) throw invalid();
  return { resourceId, version };
}
