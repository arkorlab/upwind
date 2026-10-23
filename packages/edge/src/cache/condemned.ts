import { type DecodedGenerationPack, kvGenerationKey, tagKindOf } from '@stayingupwind/core/cache';
import { invalidatedTagsMatcher } from '@stayingupwind/core/paas';

import type { EdgeMemory } from '../memory/caches.ts';
import type { ScopeInvalidations } from '../memory/invalidations.ts';

/**
 * The records a Function's response said are invalidated, wherever this isolate finds them next.
 *
 * A Server Action that calls `updateTag` answers with the page it changed, and Next.js has the next
 * request read what the invalidation wrote. The authority records the invalidation at once, but this
 * isolate would hear of it as it hears of any other: once its hold is over and KV shows the record
 * changed. The Function's response says which tags its request invalidated at once
 * (`INVALIDATED_TAGS_HEADER`) and the revision of the scope they were recorded at
 * (`INVALIDATED_REVISION_HEADER`). This isolate keeps that against the scope
 * (`memory/invalidations.ts`), and a record of the scope that carries one of those tags and was
 * written before that revision is condemned wherever it comes from — memory, KV or the data
 * center's copy, a read that set out before the response passed as much as one after — and judged
 * expired (`decideGeneration`): regenerated in the foreground, as one whose hard deadline has
 * passed. A record written at that revision or after was rendered from what the invalidation wrote,
 * or is the authority's own rewrite, which says it expired: it is served as it says.
 *
 * Memory holds no condemned record: what it holds when the response passes is let go of, and a read
 * does not hold one it brings (`generation-loader.ts`) — a record held is served past its hold
 * however long ago it was read, which would outlive what condemns it. Nor is one kept as the data
 * center's copy (`keepLatest`), which isolates that never heard of the invalidation would answer
 * with; and no absence is held from before the scope's latest invalidation, nor while KV may still
 * answer with what it held before it (`absencesHeldFrom`, `generation-hold.ts`). The invalidations
 * themselves are kept for longer than a copy from before them may answer
 * (`memory/invalidations.ts`).
 *
 * A response that names no revision — from a Function built before the header — has what it names
 * let go of from memory, and the scope's absences from before it, and condemns nothing: without a
 * bound, a record rendered since would be condemned with the rest. Only this isolate hears of it;
 * another hears of the invalidation the way it hears of any other.
 */

/** In `INVALIDATED_TAGS_HEADER`, as upwind's `invalidatedTagsValue` writes it: every tag. */
const EVERY_TAG = '*';

/**
 * The tags an `INVALIDATED_TAGS_HEADER` names, as upwind's `invalidatedTagsValue` writes them — each
 * a URI component, separated by commas — or `undefined` for every tag: `*`, or a list that cannot
 * be read, which may have named any.
 */
function namedTags(value: string): readonly string[] | undefined {
  if (value === EVERY_TAG) {
    return undefined;
  }
  try {
    return value.split(',').map((tag) => decodeURIComponent(tag));
  } catch {
    return undefined;
  }
}

/** The revision an `INVALIDATED_REVISION_HEADER` names; `undefined` for none, or one unreadable. */
function revisionOf(bound: string | null): number | undefined {
  if (bound === null || !/^\d+$/u.test(bound)) {
    return undefined;
  }
  const revision = Number(bound);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

/**
 * The tags of a record an application's invalidation can name: Next.js's own. A platform-delivery
 * tag may carry the same value as one of them, and is not one.
 */
function nextTagsOf(pack: DecodedGenerationPack): string[] {
  return pack.header.tags
    .filter((tag) => tag.kind === tagKindOf(tag.value))
    .map((tag) => tag.value);
}

/** Whether one of `tags` is bound past `revision` in `bounds`. */
function boundPast(
  bounds: ReadonlyMap<string, number>,
  tags: readonly string[],
  revision: number,
): boolean {
  return tags.some((tag) => {
    const bound = bounds.get(tag);
    return bound !== undefined && revision < bound;
  });
}

/** Whether `invalidations` condemn `pack`: a tag of it bound to a revision it was written before. */
function condemns(invalidations: ScopeInvalidations, pack: DecodedGenerationPack): boolean {
  const tags = nextTagsOf(pack);
  const { revision } = pack.header;
  if (tags.length === 0) {
    return false;
  }
  if (invalidations.every !== undefined && revision < invalidations.every) {
    return true;
  }
  return boundPast(invalidations.tags, tags, revision);
}

/**
 * What this isolate was told of `pack`: condemned (`expired`), regenerated in the foreground; or
 * invalidated with a window (`stale`), which the edge does not serve itself — the record it read
 * may be from before the invalidation and say nothing of it — but leaves to the Function, which
 * serves the entry stale and regenerates it behind; or nothing.
 */
export function condemnationOf(
  memory: EdgeMemory,
  pack: DecodedGenerationPack,
): 'expired' | 'stale' | undefined {
  const invalidations = memory.invalidations.of(pack.header.scopeId);
  if (invalidations === undefined) {
    return undefined;
  }
  if (condemns(invalidations, pack)) {
    return 'expired';
  }
  return boundPast(invalidations.stale, nextTagsOf(pack), pack.header.revision)
    ? 'stale'
    : undefined;
}

/** `condemnationOf`, for `decideGeneration`. */
export function condemnedIn(
  memory: EdgeMemory,
  deploymentId?: string,
): (pack: DecodedGenerationPack) => 'expired' | 'stale' | undefined {
  return (pack) => {
    transferInvalidations(memory, deploymentId, pack.header.scopeId);
    return condemnationOf(memory, pack);
  };
}

/**
 * Take in what a Function's response said its request invalidated at once — `value` of
 * `INVALIDATED_TAGS_HEADER`, `bound` of `INVALIDATED_REVISION_HEADER` — against `scopeId`, and let
 * go of what memory holds that it touches.
 */
export function takeInvalidation(
  memory: EdgeMemory,
  scopeId: string,
  invalidated: { readonly value: string; readonly bound: string | null },
): void {
  const { value, bound } = invalidated;
  // Without a revision it bounds no record, and is taken in for when it came all the same: an
  // absence held from before it is not held past it (`generation-hold.ts`).
  memory.invalidations.take(scopeId, namedTags(value), revisionOf(bound));
  const touches = invalidatedTagsMatcher(value, bound);
  const held = [...memory.generations.values()]
    .map(({ pack }) => pack)
    .filter(
      (pack) => pack.header.scopeId === scopeId && touches(nextTagsOf(pack), pack.header.revision),
    );
  for (const pack of held) {
    memory.generations.delete(kvGenerationKey(pack.header.scopeId, pack.header.entryId));
  }
}

/**
 * Whether what this isolate was told reaches `pack` at all: condemns it, or invalidated one of its
 * tags with a window. Neither is held: a record held is served past its hold however long ago it
 * was read, and what tells the edge not to serve it is forgotten an hour on.
 */
export function isInvalidated(
  memory: EdgeMemory,
  pack: DecodedGenerationPack,
  deploymentId?: string,
): boolean {
  transferInvalidations(memory, deploymentId, pack.header.scopeId);
  return condemnationOf(memory, pack) !== undefined;
}

/** Bind a cold Action's provisional invalidations as soon as a request learns its cache scope. */
export function transferInvalidations(
  memory: EdgeMemory,
  deploymentId: string | undefined,
  scopeId: string,
): void {
  const moved =
    deploymentId === undefined ? 'none' : memory.invalidations.move(deploymentId, scopeId);
  if (moved === 'unbounded') {
    forgetHeld(memory, scopeId, () => true);
  } else if (moved === 'bounded') {
    letGoOfInvalidated(memory, scopeId);
  }
}

/**
 * Let go of what memory holds of the scope that what this isolate was told reaches now, at once or
 * with a window (`isInvalidated`): a record held is served past its hold however long ago it was
 * read (`generation-loader.ts`), and the window's bound is not kept as long.
 */
export function letGoOfInvalidated(memory: EdgeMemory, scopeId: string): void {
  forgetHeld(memory, scopeId, (pack) => isInvalidated(memory, pack));
}

function forgetHeld(
  memory: EdgeMemory,
  scopeId: string,
  touches: (pack: DecodedGenerationPack) => boolean,
): void {
  const held = [...memory.generations.values()]
    .map(({ pack }) => pack)
    .filter((pack) => pack.header.scopeId === scopeId && touches(pack));
  for (const pack of held) {
    memory.generations.delete(kvGenerationKey(pack.header.scopeId, pack.header.entryId));
  }
}
