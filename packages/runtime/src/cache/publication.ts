import { isPublicationTag, publicationExpired } from '@stayingupwind/core/cache';
import { observePublicationTags } from '@stayingupwind/core/paas';

import type { HeldValue } from './held-writes.ts';
import type { DataEntryMetadata } from './host.ts';
import type { CacheRuntime } from './runtime.ts';

/** An expired grant is a local miss, never an authority lookup to renew a cached result. */
function publicationReadExpired(
  runtime: CacheRuntime,
  entry: DataEntryMetadata,
  now: number,
): boolean {
  return (
    entry.tags.some((tag) => isPublicationTag(tag)) &&
    runtime.tags.validityOf(entry.tags, entry.timestamp, now) === 'expired'
  );
}

export function reusePublication(tags: readonly string[], now: number): boolean {
  if (publicationExpired(tags, now)) return false;
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
