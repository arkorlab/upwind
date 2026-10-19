import { policyFromBuild, tagIdFor } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { applyResourceChangeInputSchema } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, type Mock, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { entryStateEvent } from '../src/scope/attempts.ts';
import { identifyEntry, insertEntry, publishEntry } from '../src/scope/entries.ts';
import { insertGeneration } from '../src/scope/generations.ts';
import { type EventInput, NO_HISTORY, type ScopeHistory } from '../src/scope/history.ts';
import { claimResourceWarmJobs, planApplyResourceChange } from '../src/scope/resource-changes.ts';
import { type GenerationRow, toGeneration } from '../src/scope/rows.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { findTag, replaceEntryTags } from '../src/scope/tags.ts';
import { record, type TxInput } from '../src/scope/tx.ts';

const NOW = 1_800_000_000_000;
const PAGE = 500;
const ROUTE = '/items/[id]';
const TAG = 'resource-members';
const SECOND_TAG = 'former-resource-members';
const LIMITS = limitsOf(parseVars({}));
const POLICY = policyFromBuild({ initialRevalidate: false });

interface Fixture {
  readonly storage: DurableObjectStorage;
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly tagId: string;
  readonly secondTagId: string;
  readonly entryIds: readonly string[];
  revision: number;
}

function inputFor(f: Fixture, history: ScopeHistory = NO_HISTORY): TxInput {
  return {
    sql: f.sql,
    scopeId: f.scopeId,
    limits: LIMITS,
    now: NOW,
    revision: f.revision,
    history,
  };
}

async function change(f: Fixture, history: ScopeHistory = NO_HISTORY, reconcile = true) {
  const request = applyResourceChangeInputSchema.parse({
    scopeId: f.scopeId,
    resourceId: 'resource',
    eventId: 'event',
    version: 1,
    tag: TAG,
    allowedRoutes: [ROUTE],
    reconcile,
  });
  const apply = await planApplyResourceChange(inputFor(f, history), request);
  const result = f.storage.transactionSync(apply);
  f.revision += 1;
  return result;
}

async function populate(f: Fixture, count: number): Promise<void> {
  const identities = await Promise.all(
    Array.from({ length: count }, (_unused, index) => {
      const identity = identifyEntry(f.scopeId, {
        kind: 'app-page',
        route: ROUTE,
        pathname: `/items/${index}`,
      });
      return identity;
    }),
  );
  f.storage.transactionSync(() => {
    for (const identity of identities) {
      const generationId = createId('gen');
      insertEntry(f.sql, { identity, groupInstanceId: null, revision: 2, now: NOW });
      insertGeneration(f.sql, {
        generationId,
        entryId: identity.entryId,
        seq: 1,
        source: 'build',
        attemptId: null,
        cacheTimestamp: NOW,
        producedAt: NOW,
        policy: POLICY,
        status: 200,
        headers: {},
        tags: [{ kind: 'next-explicit', value: TAG }],
        dependencyCoverage: 'complete',
        dependencyRevision: 0,
        publishedRevision: 2,
        condemned: null,
        bodyBytes: 0,
        producer: null,
        outputs: [],
        committedAt: NOW,
      });
      publishEntry(f.sql, {
        entryId: identity.entryId,
        generationId,
        seq: 1,
        revision: 2,
        now: NOW,
      });
      replaceEntryTags(f.sql, identity.entryId, [
        { tagId: f.tagId, kind: 'next-explicit', value: TAG },
      ]);
    }
    f.sql.exec('UPDATE scope SET entry_count = ?, revision = 2', count);
  });
}

function withEntries<T>(count: number, action: (f: Fixture) => T | Promise<T>) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), async (_instance, state) => {
    const { sql } = state.storage;
    applySchema(sql, []);
    const f: Fixture = {
      storage: state.storage,
      sql,
      scopeId,
      tagId: await tagIdFor(scopeId, 'next-explicit', TAG),
      secondTagId: await tagIdFor(scopeId, 'next-explicit', SECOND_TAG),
      entryIds: [],
      revision: 1,
    };
    applySeedScope(inputFor(f), {
      scope: {
        scopeId,
        organizationId: 'owner',
        projectId: 'site',
        environmentId: 'production',
        deploymentId: scopeId,
        keySchemaVersion: 1,
        buildId: 'build',
      },
    });
    await populate(f, count);
    const entryIds = sql
      .exec<{ entry_id: string }>('SELECT entry_id FROM entries ORDER BY entry_id')
      .toArray();
    const fixture = { ...f, entryIds: entryIds.map((row) => row.entry_id), revision: 3 };
    await change(fixture, NO_HISTORY, false);
    sql.exec('DELETE FROM resource_warm_jobs');
    // Valid older stored generations can lack the seed-time condemnation current writers add.
    sql.exec('UPDATE generations SET condemned = NULL');
    sql.exec("UPDATE entries SET regeneration = 'idle'");
    return action(fixture);
  });
}

function snapshot(f: Fixture) {
  return {
    generations: f.sql
      .exec('SELECT generation_id, condemned FROM generations ORDER BY generation_id')
      .toArray(),
    entries: f.sql
      .exec(`SELECT entry_id, revision, record_revision, regeneration,
      regeneration_attempt_id, fencing_max, seq_max, updated_at FROM entries ORDER BY entry_id`)
      .toArray(),
    revision: f.sql.exec<{ revision: number }>('SELECT revision FROM scope').one().revision,
  };
}

/** Previous full-row algorithm, used only as a small native-SQL state/history oracle. */
function legacyTag(input: TxInput, tagId: string, affected: Set<string>): void {
  const rows = input.sql
    .exec<GenerationRow>(
      `SELECT g.* FROM entry_tags et
    JOIN entries e ON e.entry_id = et.entry_id
    JOIN generations g ON g.generation_id = e.current_generation_id
    WHERE et.tag_id = ? AND (g.dependency_revision < 3
      OR (g.source = 'build' AND g.published_revision > 3))`,
      tagId,
    )
    .toArray();
  const tag = findTag(input.sql, tagId);
  if (tag?.stale_at === null || tag?.stale_at === undefined) return;
  for (const generation of rows) {
    const revision =
      generation.condemned === null
        ? 0
        : (toGeneration(input.scopeId, generation).condemned?.revision ?? 0);
    if (revision >= 3) continue;
    input.sql.exec(
      `UPDATE generations SET condemned = json_object(
      'revision', MAX(COALESCE(json_extract(condemned, '$.revision'), 0), ?),
      'staleAt', MIN(COALESCE(json_extract(condemned, '$.staleAt'), ?), ?),
      'hardExpireAt', MIN(COALESCE(json_extract(condemned, '$.hardExpireAt'), ?), ?)
    ) WHERE generation_id = ?`,
      tag.revision,
      tag.stale_at,
      tag.stale_at,
      tag.hard_expire_at,
      tag.hard_expire_at,
      generation.generation_id,
    );
    input.sql.exec(
      `UPDATE entries SET revision = ?, record_revision = ?,
      regeneration = CASE regeneration WHEN 'idle' THEN 'queued' ELSE regeneration END,
      updated_at = ? WHERE entry_id = ?`,
      input.revision,
      input.revision,
      input.now,
      generation.entry_id,
    );
    affected.add(generation.entry_id);
  }
}

function historyFor(events: EventInput[]): ScopeHistory {
  return {
    ...NO_HISTORY,
    append(_context, event) {
      events.push(event);
    },
  };
}

function legacySnapshot(f: Fixture, tagIds: readonly string[]) {
  const events: EventInput[] = [];
  const rollback = new Error('oracle rollback');
  let result: ReturnType<typeof snapshot> | undefined;
  try {
    f.storage.transactionSync(() => {
      const input = inputFor(f, historyFor(events));
      const affected = new Set<string>();
      for (const tagId of tagIds) legacyTag(input, tagId, affected);
      if (affected.size > 0) {
        record(
          input,
          [...affected].map((id) => entryStateEvent(f.sql, id)),
        );
      }
      result = snapshot(f);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (result === undefined) throw new Error('oracle did not capture native rows');
  return { state: result, events };
}

function addSecondTag(f: Fixture): void {
  f.sql.exec(
    `INSERT INTO tags (tag_id, kind, value, revision, stale_at, hard_expire_at, meaning)
    VALUES (?, 'next-explicit', ?, 3, ?, NULL, 'swr')`,
    f.secondTagId,
    SECOND_TAG,
    NOW - 1,
  );
  f.sql.exec('INSERT INTO entry_tags SELECT ?, entry_id FROM entries', f.secondTagId);
  f.sql.exec(
    `INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
    target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
    VALUES ('second-tag-change', 3, 'tag', ?, ?, ?, NULL, 'swr', NULL, '{}', ?)`,
    f.secondTagId,
    SECOND_TAG,
    NOW - 1,
    NOW,
  );
}

function queryDetails(spy: Mock<SqlStorage['exec']>) {
  return spy.mock.calls.map((call, index) => {
    const result = spy.mock.results[index];
    return {
      query: call[0],
      args: call.slice(1),
      columns: result?.type === 'return' ? result.value.columnNames : [],
    };
  });
}

function claimOne(f: Fixture) {
  return f.storage.transactionSync(() => {
    const claimed = claimResourceWarmJobs(f.sql, { scopeId: f.scopeId, limit: 1 }, NOW);
    return claimed.jobs[0];
  });
}

describe('paged equal-version resource reconciliation', () => {
  it.each([false, true])(
    'matches the prior state and history with a shared second tag: %s',
    async (second) => {
      const result = await withEntries(3, async (f) => {
        if (second) addSecondTag(f);
        f.sql.exec(
          "UPDATE entries SET regeneration = 'running', regeneration_attempt_id = 'live', fencing_max = 9 WHERE entry_id = ?",
          f.entryIds[0] ?? 'missing',
        );
        const tags = second ? [f.tagId, f.secondTagId] : [f.tagId];
        const before = legacySnapshot(f, tags);
        const events: EventInput[] = [];
        const answer = await change(f, historyFor(events));
        return { before, after: { state: snapshot(f), events }, answer };
      });

      expect(result.after).toStrictEqual(result.before);
      expect(result.answer).toMatchObject({ kind: 'already-applied', queuedJobs: 3 });
      expect(result.after.events).toHaveLength(3);
    },
  );

  it('uses the head revision to skip work and the current tag values for newly condemned rows', async () => {
    const result = await withEntries(2, async (f) => {
      f.sql.exec(
        'UPDATE tags SET revision = 9, stale_at = ?, hard_expire_at = NULL WHERE tag_id = ?',
        NOW - 10,
        f.tagId,
      );
      f.sql.exec(
        `UPDATE generations SET condemned = '{"revision":3,"staleAt":0,"hardExpireAt":null}'
        WHERE entry_id = ?`,
        f.entryIds[0] ?? 'missing',
      );
      const before = legacySnapshot(f, [f.tagId]);
      const events: EventInput[] = [];
      const answer = await change(f, historyFor(events));
      return { before, after: { state: snapshot(f), events }, answer };
    });

    expect(result.after).toStrictEqual(result.before);
    expect(result.answer).toMatchObject({ queuedJobs: 2 });
    expect(result.after.events).toHaveLength(1);
  });

  it('still queues already-condemned late seeds without a history event or revision advance', async () => {
    const result = await withEntries(2, async (f) => {
      f.sql.exec(
        `UPDATE generations SET condemned = '{"revision":3,"staleAt":0,"hardExpireAt":null}'`,
      );
      const before = snapshot(f).revision;
      const events: EventInput[] = [];
      const answer = await change(f, historyFor(events));
      return { answer, events, before, after: snapshot(f).revision };
    });

    expect(result.answer).toMatchObject({ affectedEntryIds: [], queuedJobs: 2 });
    expect(result.events).toHaveLength(0);
    expect(result.after).toBe(result.before);
  });

  it('reads narrow pages and performs two condemnation statements per selected page', async () => {
    const result = await withEntries(PAGE + 1, async (f) => {
      f.sql.exec(`UPDATE generations SET headers = json_object('x-padding', hex(zeroblob(131072)))
        WHERE entry_id IN (SELECT entry_id FROM entries ORDER BY entry_id LIMIT 2)`);
      const spy = vi.spyOn(f.sql, 'exec');
      try {
        const answer = await change(f);
        return { answer, details: queryDetails(spy) };
      } finally {
        spy.mockRestore();
      }
    });
    const generations = result.details.filter((row) =>
      row.query.includes('SELECT g.generation_id'),
    );
    const states = result.details.filter((row) =>
      row.query.includes('SELECT e.entry_id, e.revision'),
    );
    const updates = result.details.filter((row) =>
      row.query.startsWith('UPDATE generations SET condemned'),
    );

    expect(result.answer).toMatchObject({ queuedJobs: PAGE + 1 });
    expect(generations.map((row) => row.columns)).toStrictEqual(
      Array.from({ length: 2 }, () => ['generation_id', 'entry_id', 'condemned']),
    );
    expect(generations.map((row) => row.args.at(-1))).toStrictEqual([PAGE, PAGE]);
    expect(states.map((row) => row.columns.length)).toStrictEqual([12, 12]);
    expect(updates).toHaveLength(2);
  });

  it('captures every final event before a history callback mutates a later entry', async () => {
    const result = await withEntries(PAGE + 1, async (f) => {
      const events: EventInput[] = [];
      const later = f.entryIds.at(-1);
      const history: ScopeHistory = {
        ...NO_HISTORY,
        append(context, event) {
          events.push(event);
          if (events.length === 1) {
            context.sql.exec(
              'UPDATE entries SET failed_count = 99 WHERE entry_id = ?',
              later ?? 'missing',
            );
          }
        },
      };
      const answer = await change(f, history);
      return {
        answer,
        events,
        later,
        count: f.sql
          .exec<{ failed_count: number }>(
            'SELECT failed_count FROM entries WHERE entry_id = ?',
            later ?? 'missing',
          )
          .one().failed_count,
      };
    });

    expect(result.events).toHaveLength(PAGE + 1);
    expect(result.events.at(-1)).toMatchObject({
      entityId: result.later,
      payload: { entryState: { failedCount: 0 } },
    });
    expect(result.count).toBe(99);
    expect(result.answer).toMatchObject({ queuedJobs: PAGE + 1 });
  });

  it('rolls back every page and revision if a later history callback throws', async () => {
    const result = await withEntries(PAGE + 1, async (f) => {
      const before = snapshot(f);
      let appended = 0;
      const history: ScopeHistory = {
        ...NO_HISTORY,
        append(context) {
          appended += 1;
          if (appended === 1) context.sql.exec('UPDATE entries SET failed_count = 7');
          if (appended === PAGE + 1) throw new Error('later history failure');
        },
      };

      await expect(change(f, history)).rejects.toThrow('later history failure');

      return {
        before,
        after: snapshot(f),
        appended,
        jobs: f.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM resource_warm_jobs')
          .one().count,
      };
    });

    expect(result.after).toStrictEqual(result.before);
    expect(result.appended).toBe(PAGE + 1);
    expect(result.jobs).toBe(0);
  });

  it('keeps leased warm work while adding jobs for all other outdated entries', async () => {
    const result = await withEntries(PAGE + 1, async (f) => {
      await change(f);
      const job = claimOne(f);
      if (job === undefined) throw new Error('a warm job must be claimed');
      f.sql.exec("DELETE FROM resource_warm_jobs WHERE status <> 'leased'");
      const answer = await change(f);
      const kept = f.sql
        .exec('SELECT status, lease_token FROM resource_warm_jobs WHERE job_id = ?', job.jobId)
        .one();
      return { answer, kept, token: job.leaseToken };
    });

    expect(result.answer).toMatchObject({ affectedEntryIds: [], queuedJobs: PAGE });
    expect(result.kept).toStrictEqual({ status: 'leased', lease_token: result.token });
  });

  it('still rejects malformed condemnation before committing any page', async () => {
    const result = await withEntries(2, async (f) => {
      f.sql.exec(
        'UPDATE generations SET condemned = \'{"revision":"bad"}\' WHERE entry_id = ?',
        f.entryIds.at(-1) ?? 'missing',
      );
      const before = snapshot(f);

      await expect(change(f)).rejects.toBeInstanceOf(Error);

      return { before, after: snapshot(f) };
    });

    expect(result.after).toStrictEqual(result.before);
  });
});
