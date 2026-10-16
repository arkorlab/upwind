import {
  type CachePolicy,
  cachePolicySchema,
  type GenerationSourceKind,
  type GenerationTag,
  type InvalidationState,
  invalidationStateSchema,
  type OutputSnapshot,
} from '@stayingupwind/core/cache';
import {
  type CurrentGenerationSummary,
  type DependencyCoverage,
  type GenerationProducer,
} from '@stayingupwind/host/cache';

import { generationHeaders, type GenerationRow, parseJson } from './rows.ts';

/**
 * Generations: immutable once written, except for the four things the authority learns about
 * them afterwards — that a newer one replaced them, that an invalidation condemned them, that
 * their bytes were pruned, and where they are in publication.
 */

export interface GenerationInsert {
  readonly generationId: string;
  readonly entryId: string;
  readonly seq: number;
  readonly source: GenerationSourceKind;
  readonly attemptId: string | null;
  readonly cacheTimestamp: number | null;
  readonly producedAt: number | null;
  readonly policy: CachePolicy;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly tags: readonly GenerationTag[];
  readonly dependencyCoverage: DependencyCoverage;
  readonly dependencyRevision: number;
  readonly publishedRevision: number;
  readonly condemned: InvalidationState | null;
  readonly bodyBytes: number;
  readonly producer: GenerationProducer | null;
  readonly outputs: readonly OutputSnapshot[];
  readonly committedAt: number;
}

export function insertGeneration(sql: SqlStorage, g: GenerationInsert): void {
  sql.exec(
    `INSERT INTO generations (
       generation_id, entry_id, seq, source, attempt_id, cache_timestamp, produced_at, policy,
       status, headers, tags, dependency_coverage, dependency_revision, publication,
       published_revision, superseded_revision, condemned, storage, pruned_at, body_bytes,
       producer, outputs, committed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, NULL, ?, 'present', NULL, ?, ?, ?, ?)`,
    g.generationId,
    g.entryId,
    g.seq,
    g.source,
    g.attemptId,
    g.cacheTimestamp,
    g.producedAt,
    JSON.stringify(g.policy),
    g.status,
    JSON.stringify(g.headers),
    JSON.stringify(g.tags),
    g.dependencyCoverage,
    g.dependencyRevision,
    g.publishedRevision,
    g.condemned === null ? null : JSON.stringify(g.condemned),
    g.bodyBytes,
    g.producer === null ? null : JSON.stringify(g.producer),
    JSON.stringify(g.outputs),
    g.committedAt,
  );
}

export function findGeneration(sql: SqlStorage, generationId: string): GenerationRow | undefined {
  return sql
    .exec<GenerationRow>(`SELECT * FROM generations WHERE generation_id = ?`, generationId)
    .toArray()[0];
}

export function supersedeGeneration(sql: SqlStorage, generationId: string, revision: number): void {
  sql.exec(
    `UPDATE generations SET publication = 'superseded', superseded_revision = ? WHERE generation_id = ?`,
    revision,
    generationId,
  );
}

export function retireGenerations(sql: SqlStorage): void {
  sql.exec(`UPDATE generations SET publication = 'retired' WHERE publication = 'published'`);
}

export function condemnedOf(row: GenerationRow): InvalidationState | null {
  return row.condemned === null ? null : parseJson(invalidationStateSchema, row.condemned);
}

export function markPruned(sql: SqlStorage, generationId: string, now: number): void {
  sql.exec(
    `UPDATE generations SET storage = 'pruned', pruned_at = ? WHERE generation_id = ?`,
    now,
    generationId,
  );
}

export function summaryOf(row: GenerationRow): CurrentGenerationSummary {
  return {
    generationId: row.generation_id,
    seq: row.seq,
    cacheTimestamp: row.cache_timestamp,
    policy: parseJson(cachePolicySchema, row.policy),
    condemned: condemnedOf(row),
    status: row.status,
    location: generationHeaders(row)['location'] ?? null,
  };
}

/**
 * Former generations that can lose their bytes, in a bounded batch, oldest first: those whose bytes
 * are present, read in that order (`generations_formers`) as far as the batch. Each is placed among
 * its entry's former generations by those after it (`generations_by_entry`), counted no further than
 * the number retained: the newest is always kept for rollback, and a pruned one's place still
 * counts towards that number. Neither the history of pruned ones nor all of a long-lived entry's is
 * read for it, and a rollback copy or a generation still within its keep crowds out no later entry.
 *
 * `before` is measured from when the generation stopped being current: the commit of the one that
 * replaced it, published at the revision that superseded it — the next of its entry, found through
 * the entry's index, and looked for only where the count alone does not decide. One that served for
 * longer than the window is not old the moment it is replaced; a reader may still hold the record
 * that names it.
 */
export function prunableGenerations(
  sql: SqlStorage,
  input: { readonly before: number; readonly retain: number; readonly limit: number },
): GenerationRow[] {
  return sql
    .exec<GenerationRow>(
      `SELECT * FROM generations AS former
       WHERE storage = 'present' AND publication <> 'published'
         AND (publication = 'retired' OR (
           EXISTS (SELECT 1 FROM generations g
             WHERE g.entry_id = former.entry_id AND g.seq > former.seq
               AND g.publication <> 'published')
           AND ((SELECT COUNT(*) FROM (SELECT 1 FROM generations g
                   WHERE g.entry_id = former.entry_id AND g.seq > former.seq
                     AND g.publication <> 'published' LIMIT ?)) >= ?
             OR COALESCE(
               (SELECT s.committed_at FROM generations s
                WHERE s.entry_id = former.entry_id AND s.seq > former.seq
                  AND s.published_revision = former.superseded_revision
                ORDER BY s.seq LIMIT 1),
               former.committed_at) < ?)))
       ORDER BY committed_at, generation_id LIMIT ?`,
      input.retain,
      input.retain,
      input.before,
      input.limit,
    )
    .toArray();
}

/**
 * Every generation whose bytes are present: what a retired scope's retention prunes, oldest first
 * (`generations_formers`). None of a retired scope's is published (`retireGenerations`).
 */
export function presentGenerations(sql: SqlStorage, limit: number): GenerationRow[] {
  return sql
    .exec<GenerationRow>(
      `SELECT * FROM generations WHERE storage = 'present' AND publication <> 'published'
       ORDER BY committed_at, generation_id LIMIT ?`,
      limit,
    )
    .toArray();
}

/** Pruned generations past the history retention: their metadata goes too. */
export function deletePrunedBefore(sql: SqlStorage, before: number): number {
  return sql.exec(
    `DELETE FROM generations WHERE storage = 'pruned' AND publication <> 'published' AND pruned_at < ?`,
    before,
  ).rowsWritten;
}
