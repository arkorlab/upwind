import {
  isPublicationTag,
  MAX_TAGS_PER_ENTRY,
  publicationExpired,
  resourceSnapshotOf,
  SNAPSHOT_PUBLICATION_VERSION,
  type PublicationRequirement,
} from '@stayingupwind/core/cache';
import { observePublicationTags } from '@stayingupwind/core/paas';

import { livePublicationState } from '../publication-state.ts';
import { observeResourceTags, publicationContext } from './context.ts';
import type { HeldValue } from './held-writes.ts';
import type { DataEntryMetadata } from './host.ts';
import type { CacheRuntime } from './runtime.ts';

function missingResourceWitness(
  tags: readonly string[],
  required?: PublicationRequirement,
): boolean {
  try {
    const snapshots = tags.map((tag) => resourceSnapshotOf(tag));
    return (
      required?.version === SNAPSHOT_PUBLICATION_VERSION &&
      tags.some((tag) => isPublicationTag(tag)) &&
      snapshots.every((snapshot) => snapshot === undefined)
    );
  } catch {
    return true;
  }
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
  const context = publicationContext();
  if (context !== undefined && tags.some((tag) => isPublicationTag(tag))) {
    const publications = new Set(context.publication);
    for (const tag of tags) if (isPublicationTag(tag)) publications.add(tag);
    if (
      publications.size > MAX_TAGS_PER_ENTRY ||
      !livePublicationState(
        publications,
        mergeTags([...(context.resourceTags ?? [])], tags),
        context.publicationRequirement,
        now,
      ).valid
    )
      return false;
  }
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
