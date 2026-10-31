import { resourceSnapshotTag, type ResourceSnapshotWitness } from '../cache/resource-snapshot.ts';
import { tagNextCacheRead } from './next-cache-registry.ts';

export const RESOURCE_SNAPSHOT_OBSERVER = Symbol.for('upwind.resource-snapshot-observer@1');
interface ResourceObserver {
  [RESOURCE_SNAPSHOT_OBSERVER]?: (tags: readonly string[]) => void;
}

/** Called by a trusted producer before returning a resource's values to Next.js. */
export function observeResourceSnapshot(
  input: ResourceSnapshotWitness & { readonly tag: string },
): void {
  if (
    typeof input.tag !== 'string' ||
    input.tag.length === 0 ||
    input.tag.startsWith('upwind:resource-snapshot:')
  )
    throw new TypeError('Invalid resource snapshot tag.');
  const tags = [input.tag, resourceSnapshotTag(input)];
  for (const tag of tags) tagNextCacheRead(tag);
  (globalThis as ResourceObserver)[RESOURCE_SNAPSHOT_OBSERVER]?.(tags);
}
