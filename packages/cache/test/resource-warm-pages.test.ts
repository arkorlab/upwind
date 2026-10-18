import { policyFromBuild, tagIdFor } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { applyResourceChangeInputSchema } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { limitsOf, parseVars, type ScopeLimits } from '../src/env.ts';
import {
  identifyEntry,
  insertEntry,
  publishEntry,
  type EntryIdentity,
} from '../src/scope/entries.ts';
import { insertGeneration } from '../src/scope/generations.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { claimResourceWarmJobs, planApplyResourceChange } from '../src/scope/resource-changes.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { replaceEntryTags } from '../src/scope/tags.ts';
import type { TxInput } from '../src/scope/tx.ts';

const NOW = 1_800_000_000_000;
const PAGE = 500;
const LARGE_SCOPE = 100_001;
const SQL_VALUE_BYTES = 2 * 1024 * 1024;
const LARGE_TIMEOUT_MS = 120_000;
const ROUTE = '/items/[id]';
const TAG = 'shared-items';
const POLICY = policyFromBuild({ initialRevalidate: false });

interface Fixture {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly scopeId: string;
  readonly limits: ScopeLimits;
  readonly tagId: string;
  readonly firstEntryId: string;
  readonly templateGenerationId: string;
  nextRevision: number;
}

function inputFor(fixture: Fixture): TxInput {
  return {
    sql: fixture.sql,
    scopeId: fixture.scopeId,
    limits: fixture.limits,
    now: NOW,
    revision: fixture.nextRevision++,
    history: NO_HISTORY,
  };
}

function identityAt(scopeId: string, index: number) {
  return identifyEntry(scopeId, { kind: 'app-page', route: ROUTE, pathname: `/items/${index}` });
}

function insertOne(fixture: Fixture, identity: EntryIdentity, revision: number): void {
  const generationId =
    identity.entryId === fixture.firstEntryId ? fixture.templateGenerationId : createId('gen');
  insertEntry(fixture.sql, { identity, groupInstanceId: null, revision, now: NOW });
  insertGeneration(fixture.sql, {
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
    publishedRevision: revision,
    condemned: null,
    bodyBytes: 0,
    producer: null,
    outputs: [],
    committedAt: NOW,
  });
  publishEntry(fixture.sql, {
    entryId: identity.entryId,
    generationId,
    seq: 1,
    revision,
    now: NOW,
  });
  replaceEntryTags(fixture.sql, identity.entryId, [
    { tagId: fixture.tagId, kind: 'next-explicit', value: TAG },
  ]);
  fixture.sql.exec('UPDATE scope SET revision = ?', revision);
}

/** Derive real identities in small batches; clone only invariant columns of a real generation. */
async function populate(fixture: Fixture, start: number, count: number): Promise<void> {
  if (count === 0) return;
  const revision = fixture.nextRevision++;
  for (let offset = 0; offset < count; offset += PAGE) {
    const indices = Array.from(
      { length: Math.min(PAGE, count - offset) },
      (_unused, index) => start + offset + index,
    );
    const identities = await Promise.all(
      indices.map((index) => identityAt(fixture.scopeId, index)),
    );
    const page = identities.map((identity) => ({ ...identity, generationId: createId('gen') }));
    const json = JSON.stringify(page);
    fixture.storage.transactionSync(() => {
      fixture.sql.exec(
        `INSERT INTO entries (
           entry_id, kind, route, pathname, cache_key_digest, group_instance_id, key_descriptor,
           handler, created_at, created_revision, revision, record_revision, kv_revision,
           current_generation_id, publication, regeneration, regeneration_attempt_id, failed_count,
           next_retry_at, tombstone_revision, committed_at, updated_at, fencing_max, seq_max
         ) SELECT json_extract(p.value, '$.entryId'), e.kind, json_extract(p.value, '$.route'),
           json_extract(p.value, '$.pathname'), json_extract(p.value, '$.cacheKeyDigest'), NULL,
           json_extract(p.value, '$.keyDescriptor'), NULL, ?, ?, ?, ?, 0,
           json_extract(p.value, '$.generationId'), 'published', 'idle', NULL, 0, NULL, NULL, ?, ?, 0, 1
         FROM json_each(?) p CROSS JOIN entries e WHERE e.entry_id = ?`,
        NOW,
        revision,
        revision,
        revision,
        NOW,
        NOW,
        json,
        fixture.firstEntryId,
      );
      fixture.sql.exec(
        `INSERT INTO generations (
           generation_id, entry_id, seq, source, attempt_id, cache_timestamp, produced_at, policy,
           status, headers, tags, dependency_coverage, dependency_revision, publication,
           published_revision, superseded_revision, condemned, storage, pruned_at, body_bytes,
           producer, outputs, committed_at
         ) SELECT json_extract(p.value, '$.generationId'), json_extract(p.value, '$.entryId'),
           1, g.source, NULL, ?, ?, g.policy, 200, g.headers, g.tags, g.dependency_coverage, 0,
           'published', ?, NULL, NULL, 'present', NULL, 0, NULL, '[]', ?
         FROM json_each(?) p CROSS JOIN generations g WHERE g.generation_id = ?`,
        NOW,
        NOW,
        revision,
        NOW,
        json,
        fixture.templateGenerationId,
      );
      fixture.sql.exec(
        `INSERT INTO entry_tags (tag_id, entry_id)
         SELECT ?, json_extract(value, '$.entryId') FROM json_each(?)`,
        fixture.tagId,
        json,
      );
      fixture.sql.exec(
        'UPDATE scope SET entry_count = entry_count + ?, revision = ?',
        page.length,
        revision,
      );
    });
  }
}

function withEntries<T>(count: number, action: (fixture: Fixture) => T | Promise<T>) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), async (_instance, state) => {
    const { sql } = state.storage;
    applySchema(sql, []);
    const first = await identityAt(scopeId, 0);
    const fixture: Fixture = {
      sql,
      storage: state.storage,
      scopeId,
      limits: { ...limitsOf(parseVars({})), entriesPerScope: LARGE_SCOPE + PAGE },
      tagId: await tagIdFor(scopeId, 'next-explicit', TAG),
      firstEntryId: first.entryId,
      templateGenerationId: createId('gen'),
      nextRevision: 1,
    };
    applySeedScope(inputFor(fixture), {
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
    const revision = fixture.nextRevision++;
    fixture.storage.transactionSync(() => {
      insertOne(fixture, first, revision);
    });
    await populate(fixture, 1, count - 1);
    return action(fixture);
  });
}

async function change(fixture: Fixture, allowedRoutes: readonly string[], reconcile = false) {
  const request = applyResourceChangeInputSchema.parse({
    scopeId: fixture.scopeId,
    resourceId: 'resource',
    eventId: 'event',
    version: 1,
    tag: TAG,
    allowedRoutes,
    reconcile,
  });
  const apply = await planApplyResourceChange(inputFor(fixture), request);
  return fixture.storage.transactionSync(apply);
}

function jobsLeft(sql: SqlStorage): number {
  return sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM resource_warm_jobs').one()
    .count;
}

describe('resource changes larger than one SQL value', () => {
  it(
    'warms every admitted entry beyond a two MiB ID list',
    async () => {
      const result = await withEntries(LARGE_SCOPE, async (fixture) => {
        const answer = await change(fixture, [ROUTE]);
        if (answer.kind !== 'applied') throw new Error('the resource change must commit');
        const middle = await identityAt(fixture.scopeId, Math.floor(LARGE_SCOPE / 2));
        const last = await identityAt(fixture.scopeId, LARGE_SCOPE - 1);
        const boundary = [fixture.firstEntryId, middle.entryId, last.entryId];
        const covered = fixture.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM resource_warm_jobs
           WHERE entry_id IN (SELECT value FROM json_each(?))`,
            JSON.stringify(boundary),
          )
          .one().count;
        const widths = new Set(answer.affectedEntryIds.map((id) => id.length));
        return {
          affected: answer.affectedEntryIds.length,
          bytes: new TextEncoder().encode(JSON.stringify(answer.affectedEntryIds)).byteLength,
          widths: [...widths],
          queued: answer.queuedJobs,
          jobs: jobsLeft(fixture.sql),
          covered,
        };
      });

      expect(result.affected).toBe(LARGE_SCOPE);
      expect(result.bytes).toBeGreaterThan(SQL_VALUE_BYTES);
      expect(result.widths).toStrictEqual([25]);
      expect(result.queued).toBe(LARGE_SCOPE);
      expect(result.jobs).toBe(LARGE_SCOPE);
      expect(result.covered).toBe(3);
    },
    LARGE_TIMEOUT_MS,
  );

  it.each(['one long route', 'many short routes'] as const)(
    'does not bind the trusted allowlist with %s as one SQL value',
    async (shape) => {
      const allowed =
        shape === 'one long route'
          ? [`/${'x'.repeat(SQL_VALUE_BYTES)}`, ROUTE]
          : [
              ...Array.from(
                { length: LARGE_SCOPE + 2 * PAGE },
                (_unused, index) => `/not-allowed/${index}`,
              ),
              ROUTE,
            ];
      const bytes = new TextEncoder().encode(JSON.stringify(allowed)).byteLength;
      const result = await withEntries(1, async (fixture) => {
        const answer = await change(fixture, allowed);
        return { kind: answer.kind, jobs: jobsLeft(fixture.sql) };
      });

      expect(bytes).toBeGreaterThan(SQL_VALUE_BYTES);
      expect(result).toStrictEqual({ kind: 'applied', jobs: 1 });
    },
  );

  it('keeps both page boundaries and previously leased jobs when reconciling new entries', async () => {
    const result = await withEntries(PAGE + 1, async (fixture) => {
      const initial = await change(fixture, [ROUTE]);
      const leased = fixture.storage.transactionSync(() =>
        claimResourceWarmJobs(fixture.sql, { scopeId: fixture.scopeId, limit: 1 }, NOW + 1),
      ).jobs[0];
      if (leased === undefined) throw new Error('one unsatisfied job must be leased');
      await populate(fixture, PAGE + 1, 1);
      const reconciled = await change(fixture, [ROUTE, ROUTE], true);
      const kept = fixture.sql
        .exec<{ status: string; lease_token: string | null }>(
          'SELECT status, lease_token FROM resource_warm_jobs WHERE job_id = ?',
          leased.jobId,
        )
        .one();
      return { initial, reconciled, jobs: jobsLeft(fixture.sql), kept, token: leased.leaseToken };
    });

    expect(result.initial.kind).toBe('applied');
    expect(result.initial).toHaveProperty('queuedJobs', PAGE + 1);
    expect(result.reconciled).toHaveProperty('queuedJobs', 1);
    expect(result.jobs).toBe(PAGE + 2);
    expect(result.kept).toStrictEqual({ status: 'leased', lease_token: result.token });
  });

  it('preserves SQLite route equality for Unicode, NUL and malformed UTF-16 inputs', async () => {
    const result = await withEntries(1, async (fixture) => {
      const allowed = ['/café', '/cafe\u0301', '/emoji-🙂', '/nul\0tail', '/bad\uD800'];
      for (const route of allowed) {
        const identity = await identifyEntry(fixture.scopeId, {
          kind: 'app-page',
          route,
          pathname: route,
        });
        const revision = fixture.nextRevision++;
        fixture.storage.transactionSync(() => {
          insertOne(fixture, identity, revision);
        });
      }
      const expected = fixture.sql
        .exec<{ entry_id: string }>(
          `SELECT entry_id FROM entries
           WHERE route IN (SELECT value FROM json_each(?)) ORDER BY entry_id`,
          JSON.stringify(allowed),
        )
        .toArray()
        .map((row) => row.entry_id);
      await change(fixture, allowed);
      const actual = fixture.sql
        .exec<{ entry_id: string }>('SELECT entry_id FROM resource_warm_jobs ORDER BY entry_id')
        .toArray()
        .map((row) => row.entry_id);
      return { expected, actual };
    });

    expect(result.actual).toStrictEqual(result.expected);
  });

  it('rolls back invalidations, the resource head and earlier job pages if a later page fails', async () => {
    const result = await withEntries(PAGE + 1, async (fixture) => {
      fixture.sql.exec(
        `CREATE TRIGGER fail_late_warm BEFORE INSERT ON resource_warm_jobs
         WHEN (SELECT COUNT(*) FROM resource_warm_jobs) >= 500
         BEGIN SELECT RAISE(ABORT, 'late warm failure'); END`,
      );
      let failed = false;
      try {
        await change(fixture, [ROUTE]);
      } catch (error) {
        failed = error instanceof Error && error.message.includes('late warm failure');
      }
      const heads = fixture.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM resource_heads')
        .one().count;
      const invalidations = fixture.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM invalidations')
        .one().count;
      return { failed, heads, invalidations, jobs: jobsLeft(fixture.sql) };
    });

    expect(result).toStrictEqual({ failed: true, heads: 0, invalidations: 0, jobs: 0 });
  });
});
