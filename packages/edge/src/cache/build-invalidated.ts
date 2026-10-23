import { tagKindOf } from '@stayingupwind/core/cache';
import type { RouteCache } from '@stayingupwind/core/manifest';

import type { EdgeMemory } from '../memory/caches.ts';

/**
 * A build shell is older than every invalidation of its deployment's scope (`scope/seed.ts`).
 * Unlike a delivery record, a cached negative lookup has no generation or revision to condemn.
 * Match the immutable build's trusted membership instead, using only exact at-once tag bounds.
 * A folded scope floor can include windowed invalidations, so it grants no such proof here.
 * Older manifests carry no membership and keep their previous fallback behavior.
 */
export function buildWasInvalidated(
  memory: Pick<EdgeMemory, 'invalidations'>,
  scopeId: string,
  cache: RouteCache | undefined,
): boolean {
  const tags = cache?.buildTags;
  if (tags === undefined || tags.length === 0) {
    return false;
  }
  const invalidations = memory.invalidations.of(scopeId);
  if (invalidations === undefined) {
    return false;
  }
  return tags.some(
    (tag) => tag.kind === tagKindOf(tag.value) && (invalidations.tags.get(tag.value) ?? 0) > 0,
  );
}
