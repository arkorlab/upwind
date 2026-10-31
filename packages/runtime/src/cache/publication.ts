import {
  isPublicationTag,
  publicationExpired,
  resourceSnapshotOf,
  SNAPSHOT_PUBLICATION_VERSION,
  type PublicationRequirement,
} from '@stayingupwind/core/cache';
import { observePublicationTags } from '@stayingupwind/core/paas';

import { observeResourceTags, publicationContext } from './context.ts';
import type { HeldValue } from './held-writes.ts';
import type { DataEntryMetadata } from './host.ts';
import type { CacheRuntime } from './runtime.ts';

function missingResourceWitness(
  tags: readonly string[],
  required?: PublicationRequirement,
): boolean {
  return (
    required?.version === SNAPSHOT_PUBLICATION_VERSION &&
    tags.some((tag) => isPublicationTag(tag)) &&
    tags.every((tag) => resourceSnapshotOf(tag) === undefined)
  );
}

/** An expired grant is a local miss, never an authority lookup to renew a cached result. */
function publicationReadExpired(
  runtime: CacheRuntime,
  entry: DataEntryMetadata,
  now: number,
): boolean {
  return (
    missingResourceWitness(entry.tags, runtime.host.publication) ||
    (entry.tags.some((tag) => isPublicationTag(tag)) &&
      runtime.tags.validityOf(entry.tags, entry.timestamp, now) === 'expired')
  );
}

export function reusePublication(
  tags: readonly string[],
  now: number,
  required?: PublicationRequirement,
): boolean {
  if (
    publicationExpired(tags, now) ||
    missingResourceWitness(tags, required ?? publicationContext()?.publicationRequirement)
  )
    return false;
  observeResourceTags(tags);
  observePublicationTags(tags);
  return true;
}

export function mergeTags(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] {
  const tags = new Set(first);
  if (second !== undefined) {
    for (const tag of second) {
      tags.add(tag);
    }
  }
  return [...tags];
}

export function publicationReadable(
  runtime: CacheRuntime,
  held: HeldValue | undefined,
  now: number,
): held is HeldValue {
  return held !== undefined && !publicationReadExpired(runtime, held.entry, now);
}

/** A fresh fetch carries its declared bound before Next can hand its value to a render. */
export function observeFreshPublication(tags: readonly string[], now: number): void {
  observeResourceTags(tags);
  observePublicationTags(tags);
  if (publicationExpired(tags, now)) throw new Error('Publication unavailable');
}
