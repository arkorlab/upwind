import * as z from 'zod';

/**
 * What an authority's changes are, by kind and by the entity each is of: the words a change is
 * told in to a scope's history (`ScopeHistory`), whatever the history makes of them.
 */

export const cacheEventKindSchema = z.enum([
  'scope.seeded',
  'scope.retired',
  'entry.created',
  'entry.state.changed',
  'entry.retired',
  'entries.projected',
  'entries.invalidated',
  'generation.committed',
  'generation.pruned',
  'attempt.started',
  'attempt.failed',
  'attempt.skipped',
  'attempt.expired',
  'attempt.superseded',
  'invalidation.recorded',
]);
export type CacheEventKind = z.infer<typeof cacheEventKindSchema>;

export const cacheEventEntityTypeSchema = z.enum([
  'scope',
  'entry',
  'generation',
  'attempt',
  'invalidation',
]);
export type CacheEventEntityType = z.infer<typeof cacheEventEntityTypeSchema>;
