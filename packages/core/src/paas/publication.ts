import { type PublicationGrant, publicationTagOf } from '../cache/publication.ts';
import { tagNextCacheRead } from './next-cache-registry.ts';

export const PUBLICATION_OBSERVER = Symbol.for('upwind.publication-observer@1');
interface Observer {
  [PUBLICATION_OBSERVER]?: (tag: string) => void;
}

/** Call when consuming a trusted publisher's result, before returning its data to Next.js. */
export async function observePublicationGrant(grant: PublicationGrant): Promise<void> {
  const tag = await publicationTagOf(grant);
  observePublicationTags([tag]);
}

/** Reusing a cached child records its original bound in every parent, never a renewed grant. */
export function observePublicationTags(tags: readonly string[]): void {
  for (const tag of tags) {
    if (!tag.startsWith('upwind:publication:')) continue;
    tagNextCacheRead(tag);
    (globalThis as Observer)[PUBLICATION_OBSERVER]?.(tag);
  }
}
