import { type CachePolicy, policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { ResourceWarmJob } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { identifyEntry, insertEntry, publishEntry } from '../src/scope/entries.ts';
import { insertGeneration } from '../src/scope/generations.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { claimResourceWarmJobs, finishResourceWarmJob } from '../src/scope/resource-changes.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const SECOND = 1000;
const REQUIRED = 8;
const PUBLISHED_AT = NOW + 2 * SECOND;
const ACK_AT = NOW + 4 * SECOND;
const JOB = 'warm-job';

interface Fixture {
  readonly scopeId: string;
  readonly entryId: string;
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
}

interface QueuedJob {
  readonly id: string;
  readonly status: 'pending' | 'leased' | 'skipped';
  readonly retryAt: number;
  readonly leaseExpiresAt: number | null;
}

function queuedJob(id: string, status: QueuedJob['status'], at: number): QueuedJob {
  return {
    id,
    status,
    retryAt: status === 'leased' ? NOW - 100 * SECOND : at,
    leaseExpiresAt: status === 'leased' ? at : null,
  };
}

function interleavedJobs(count: number): QueuedJob[] {
  const jobs: QueuedJob[] = [];
  for (let index = 0; index < count; index += 1) {
    jobs.push(
      queuedJob(`pending-${index}`, 'pending', NOW - index * SECOND),
      queuedJob(`leased-${index}`, 'leased', NOW - index * SECOND),
    );
  }
  return jobs;
}

function queue(fixture: Fixture, jobs: readonly QueuedJob[]): void {
  fixture.sql.exec('DELETE FROM resource_warm_jobs');
  fixture.sql.exec(
    `INSERT INTO resource_warm_jobs (job_id, resource_id, entry_id, event_id, version,
     required_revision, status, attempt_count, retry_at, lease_token, lease_expires_at,
     detail, updated_at)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.id'), ?, 'event', 1, ?,
       json_extract(value, '$.status'), 1, json_extract(value, '$.retryAt'),
       CASE json_extract(value, '$.status') WHEN 'leased' THEN 'old-lease' ELSE NULL END,
       json_extract(value, '$.leaseExpiresAt'), NULL, ? FROM json_each(?)`,
    fixture.entryId,
    REQUIRED,
    NOW,
    JSON.stringify(jobs),
  );
}

function publish(fixture: Fixture, policy: CachePolicy, revision: number, seq: number): void {
  const { sql, entryId } = fixture;
  const generationId = `generation-${seq}`;
  const timestamp = seq === 1 ? NOW - 20 * SECOND : PUBLISHED_AT;
  sql.exec(
    `UPDATE generations SET publication = 'superseded', superseded_revision = ?
     WHERE entry_id = ? AND publication = 'published'`,
    revision,
    entryId,
  );
  insertGeneration(sql, {
    generationId,
    entryId,
    seq,
    source: 'runtime',
    attemptId: null,
    cacheTimestamp: timestamp,
    producedAt: timestamp,
    policy,
    status: 200,
    headers: {},
    tags: [],
    dependencyCoverage: 'complete',
    dependencyRevision: revision,
    publishedRevision: revision,
    condemned: null,
    bodyBytes: 0,
    producer: null,
    outputs: [],
    committedAt: timestamp,
  });
  publishEntry(sql, { entryId, generationId, seq, revision, now: timestamp });
}

function inScope<T>(action: (fixture: Fixture) => T | Promise<T>) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), async (_instance, state) => {
    const { sql } = state.storage;
    applySchema(sql, []);
    applySeedScope(
      {
        sql,
        scopeId,
        limits: limitsOf(parseVars({})),
        now: NOW,
        revision: 1,
        history: NO_HISTORY,
      },
      {
        scope: {
          scopeId,
          organizationId: 'owner',
          projectId: 'site',
          environmentId: 'production',
          deploymentId: scopeId,
          keySchemaVersion: 1,
          buildId: 'build',
        },
      },
    );
    const identity = await identifyEntry(scopeId, { kind: 'app-page', route: '/', pathname: '/' });
    const fixture = { sql, scopeId, entryId: identity.entryId, storage: state.storage };
    state.storage.transactionSync(() => {
      insertEntry(sql, { identity, groupInstanceId: null, revision: 2, now: NOW });
      publish(fixture, policyFromBuild({ initialRevalidate: false }), REQUIRED - 1, 1);
      sql.exec(
        `INSERT INTO resource_warm_jobs (job_id, resource_id, entry_id, event_id, version,
         required_revision, status, attempt_count, retry_at, lease_token, lease_expires_at,
         detail, updated_at) VALUES (?, 'resource', ?, 'event', 1, ?, 'pending', 0, ?,
         NULL, NULL, NULL, ?)`,
        JOB,
        identity.entryId,
        REQUIRED,
        NOW,
        NOW,
      );
    });
    return action(fixture);
  });
}

function claim(fixture: Fixture, now = NOW + SECOND) {
  return fixture.storage.transactionSync(() =>
    claimResourceWarmJobs(fixture.sql, { scopeId: fixture.scopeId, limit: 2 }, now),
  );
}

function requireJob(fixture: Fixture): ResourceWarmJob {
  const job = claim(fixture).jobs[0];
  if (job === undefined) throw new Error('the older generation must not satisfy the queued change');
  return job;
}

function finish(fixture: Fixture, job: ResourceWarmJob, now = ACK_AT, token = job.leaseToken) {
  return fixture.storage.transactionSync(() => {
    return finishResourceWarmJob(
      fixture.sql,
      { scopeId: fixture.scopeId, jobId: job.jobId, leaseToken: token, outcome: 'published' },
      now,
    );
  });
}

function jobsLeft(sql: SqlStorage): number {
  return sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM resource_warm_jobs').one()
    .count;
}

/** Observe the actual candidate and next-time cursors, excluding the unchanged orphan cleanup. */
function countedClaim(fixture: Fixture) {
  const { sql } = fixture;
  const exec = sql.exec.bind(sql);
  const reads: (() => number)[] = [];
  const spy = vi
    .spyOn(sql, 'exec')
    .mockImplementation((query: string, ...bindings: SqlStorageValue[]) => {
      const cursor = exec(query, ...bindings);
      if (
        query.includes('FROM resource_warm_jobs') &&
        (query.includes('ORDER BY') || query.includes('SELECT MIN('))
      ) {
        reads.push(() => cursor.rowsRead);
      }
      return cursor;
    });
  try {
    const answer = claim(fixture, NOW);
    return { answer, reads: reads.map((read) => read()) };
  } finally {
    spy.mockRestore();
  }
}

type Defect = 'under-revision' | 'condemned' | 'unpublished' | 'pruned' | 'non-200';

function spoil(fixture: Fixture, defect: Defect): void {
  const { sql } = fixture;
  switch (defect) {
    case 'under-revision': {
      sql.exec('UPDATE generations SET dependency_revision = ? WHERE seq = 2', REQUIRED - 1);
      break;
    }
    case 'condemned': {
      sql.exec(
        'UPDATE generations SET condemned = ? WHERE seq = 2',
        JSON.stringify({ revision: REQUIRED + 1, staleAt: PUBLISHED_AT }),
      );
      break;
    }
    case 'unpublished': {
      sql.exec("UPDATE generations SET publication = 'superseded' WHERE seq = 2");
      break;
    }
    case 'pruned': {
      sql.exec("UPDATE generations SET storage = 'pruned', pruned_at = ? WHERE seq = 2", ACK_AT);
      break;
    }
    case 'non-200': {
      sql.exec('UPDATE generations SET status = 503 WHERE seq = 2');
      break;
    }
  }
}

function staleFinish(
  fixture: Fixture,
  job: ResourceWarmJob,
  stale: 'wrong-token' | 'expired-lease',
) {
  const now = stale === 'expired-lease' ? job.leaseExpiresAt + 1 : ACK_AT;
  const token = stale === 'wrong-token' ? 'another-owner' : job.leaseToken;
  return finish(fixture, job, now, token);
}

const POLICIES = [
  { name: 'zero', policy: policyFromBuild({ initialRevalidate: 0, initialExpiration: 600 }) },
  { name: 'short', policy: policyFromBuild({ initialRevalidate: 1, initialExpiration: 1 }) },
  { name: 'unknown', policy: policyFromBuild({}) },
];

describe('completion of a resource change warm job', () => {
  it('merges pending retries and expired leases by due time and job ID', async () => {
    const result = await inScope((fixture) => {
      queue(fixture, [
        queuedJob('b-pending', 'pending', NOW - 2 * SECOND),
        queuedJob('a-leased', 'leased', NOW - 2 * SECOND),
        queuedJob('c-pending', 'pending', NOW - SECOND),
        queuedJob('d-live-lease', 'leased', NOW + SECOND),
        queuedJob('e-future', 'pending', NOW + 2 * SECOND),
        queuedJob('f-skipped', 'skipped', NOW - 10 * SECOND),
      ]);
      const answer = fixture.storage.transactionSync(() =>
        claimResourceWarmJobs(fixture.sql, { scopeId: fixture.scopeId, limit: 3 }, NOW),
      );
      return { ids: answer.jobs.map((job) => job.jobId), nextRetryAt: answer.nextRetryAt };
    });

    expect(result).toStrictEqual({
      ids: ['a-leased', 'b-pending', 'c-pending'],
      nextRetryAt: NOW + SECOND,
    });
  });

  it.each([1, 2, 4, 20])('keeps the original global top %s and next retry', async (limit) => {
    const result = await inScope((fixture) => {
      queue(fixture, interleavedJobs(40));
      const expected = fixture.sql
        .exec<{ job_id: string }>(
          `SELECT job_id FROM resource_warm_jobs
           WHERE (status = 'pending' AND retry_at <= ?)
              OR (status = 'leased' AND lease_expires_at <= ?)
           ORDER BY CASE status WHEN 'leased' THEN lease_expires_at ELSE retry_at END, job_id
           LIMIT ?`,
          NOW,
          NOW,
          limit,
        )
        .toArray();
      const answer = fixture.storage.transactionSync(() =>
        claimResourceWarmJobs(fixture.sql, { scopeId: fixture.scopeId, limit }, NOW),
      );
      const next = fixture.sql
        .exec<{ at: number | null }>(
          `SELECT MIN(CASE status WHEN 'leased' THEN lease_expires_at ELSE retry_at END) AS at
           FROM resource_warm_jobs WHERE status IN ('pending', 'leased')`,
        )
        .one().at;
      return {
        ids: answer.jobs.map((job) => job.jobId),
        expected: expected.map((job) => job.job_id),
        nextRetryAt: answer.nextRetryAt,
        next,
      };
    });

    expect(result.ids).toStrictEqual(result.expected);
    expect(result.nextRetryAt).toBe(result.next);
  });

  it('bounds candidate and next-time reads with the existing partial indexes', async () => {
    const result = await inScope((fixture) => {
      queue(fixture, interleavedJobs(500));
      return countedClaim(fixture);
    });

    expect(result.answer.jobs).toHaveLength(2);
    expect(result.reads).toHaveLength(2);
    expect(result.reads[0]).toBeLessThanOrEqual(64);
    expect(result.reads[1]).toBeLessThanOrEqual(16);
  });

  it('still removes future and skipped orphan jobs before computing the next retry', async () => {
    const result = await inScope((fixture) => {
      queue(fixture, [
        queuedJob('future-orphan', 'pending', NOW + SECOND),
        queuedJob('skipped-orphan', 'skipped', NOW - SECOND),
        queuedJob('live-future', 'pending', NOW + 2 * SECOND),
      ]);
      fixture.sql.exec(
        `UPDATE resource_warm_jobs SET entry_id = 'absent'
         WHERE job_id IN ('future-orphan', 'skipped-orphan')`,
      );
      return { answer: claim(fixture, NOW), left: jobsLeft(fixture.sql) };
    });

    expect(result).toStrictEqual({ answer: { jobs: [], nextRetryAt: NOW + 2 * SECOND }, left: 1 });
  });

  it.each(POLICIES)(
    'completes a revision-covering $name lifetime after publication',
    async ({ policy }) => {
      const result = await inScope((fixture) => {
        const job = requireJob(fixture);
        fixture.storage.transactionSync(() => {
          publish(fixture, policy, REQUIRED, 2);
        });
        return { answer: finish(fixture, job), left: jobsLeft(fixture.sql) };
      });

      expect(result).toStrictEqual({ answer: { kind: 'completed', nextRetryAt: null }, left: 0 });
    },
  );

  it.each(POLICIES)(
    'recognizes a lost ACK for the $name lifetime after its dispatch lease',
    async ({ policy }) => {
      const result = await inScope((fixture) => {
        const job = requireJob(fixture);
        fixture.storage.transactionSync(() => {
          publish(fixture, policy, REQUIRED, 2);
        });
        return { answer: claim(fixture, job.leaseExpiresAt + 1), left: jobsLeft(fixture.sql) };
      });

      expect(result).toStrictEqual({ answer: { jobs: [], nextRetryAt: null }, left: 0 });
    },
  );

  it.each(['under-revision', 'condemned', 'unpublished', 'pruned', 'non-200'] as const)(
    'does not complete a %s generation merely because a dispatch says published',
    async (defect) => {
      const result = await inScope((fixture) => {
        const job = requireJob(fixture);
        fixture.storage.transactionSync(() => {
          publish(fixture, policyFromBuild({}), REQUIRED, 2);
          spoil(fixture, defect);
        });
        return { answer: finish(fixture, job), left: jobsLeft(fixture.sql) };
      });

      expect(result.answer.kind).toBe('retry');
      expect(result.answer.nextRetryAt).toBeGreaterThan(ACK_AT);
      expect(result.left).toBe(1);
    },
  );

  it.each(['wrong-token', 'expired-lease'] as const)(
    'keeps a fulfilled job when a %s ACK arrives',
    async (stale) => {
      const result = await inScope((fixture) => {
        const job = requireJob(fixture);
        fixture.storage.transactionSync(() => {
          publish(fixture, policyFromBuild({}), REQUIRED, 2);
        });
        return { answer: staleFinish(fixture, job, stale), left: jobsLeft(fixture.sql) };
      });

      expect(result.answer.kind).toBe('superseded');
      expect(result.left).toBe(1);
    },
  );
});
