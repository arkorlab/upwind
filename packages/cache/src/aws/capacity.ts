import { CacheHostError } from '@stayingupwind/runtime/cache-host';

import { DEFAULT_CACHE_VARS } from '../env.ts';
import type { EntryState, GenerationReference, ScopeState } from './model.ts';

export function entryCapacity(
  scope: ScopeState,
  previous?: EntryState,
  generation?: GenerationReference,
): ScopeState {
  const entries = scope.entries + (previous === undefined ? 1 : 0);
  const bodyBytes =
    generation === undefined
      ? scope.bodyBytes
      : scope.bodyBytes - (previous?.current?.bytes ?? 0) + generation.bytes;
  if (
    entries > DEFAULT_CACHE_VARS.QUOTA_ENTRIES_PER_SCOPE ||
    bodyBytes > DEFAULT_CACHE_VARS.QUOTA_BODY_BYTES_PER_SCOPE
  )
    throw new CacheHostError('AWS cache scope reached its entry or body quota', {
      code: 'quota_exceeded',
      status: 429,
    });
  return { ...scope, entries, bodyBytes };
}

export function tagCapacity(scope: ScopeState, newlyInvalidated: number): ScopeState {
  const tags = scope.tags + newlyInvalidated;
  if (tags > DEFAULT_CACHE_VARS.QUOTA_TAGS_PER_SCOPE)
    throw new CacheHostError('AWS cache scope reached its tag quota', {
      code: 'quota_exceeded',
      status: 429,
    });
  return { ...scope, tags };
}
