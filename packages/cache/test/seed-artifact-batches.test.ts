import { policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { SeedArtifact, SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { referenceArtifact, releaseArtifact } from '../src/scope/artifacts.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import type { ArtifactRow } from '../src/scope/rows.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope, planSeedEntries } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';
import type { TxInput } from '../src/scope/tx.ts';

const NOW = 1_800_000_000_000;
const OUTPUT_ARTIFACTS = 16;

function artifactAt(index: number): SeedArtifact {
  return {
    role: 'rsc',
    sha256: index.toString(16).padStart(64, '0'),
    byteLength: 1,
    contentType: 'x',
    encoding: 'identity',
    storageRef: `s${index}`,
  };
}

function seedOf(artifacts: readonly SeedArtifact[], pathname = '/'): SeedEntryInput {
  return {
    descriptor: { kind: 'app-page', route: pathname, pathname },
    groupInstanceId: null,
    generation: {
      generationId: createId('gen'),
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: {},
      tags: [],
      dependencyCoverage: 'complete',
      outputs: Array.from(
        { length: Math.max(1, Math.ceil(artifacts.length / OUTPUT_ARTIFACTS)) },
        (_, index) => {
          return {
            representationKey: `h${index}`,
            pathname,
            status: 200,
            headers: {},
            compute: 'static',
            response: 'complete',
            htmlSize: null,
            artifacts: artifacts.slice(index * OUTPUT_ARTIFACTS, (index + 1) * OUTPUT_ARTIFACTS),
          };
        },
      ),
    },
  };
}

function inScope<T>(action: (tx: TxInput, storage: DurableObjectStorage) => T | Promise<T>) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
    const { sql } = state.storage;
    applySchema(sql, []);
    const tx = {
      sql,
      scopeId,
      now: NOW,
      revision: 1,
      limits: limitsOf(parseVars({})),
      history: NO_HISTORY,
    };
    applySeedScope(tx, {
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
    return action({ ...tx, revision: 2 }, state.storage);
  });
}

function countedArtifacts<T>(sql: SqlStorage, apply: () => T) {
  const exec = sql.exec.bind(sql);
  const bindingsPerStatement: number[] = [];
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query: string, ...bindings) => {
    if (query.includes('artifacts') || query.includes('pending_deletions')) {
      bindingsPerStatement.push(bindings.length);
    }
    return exec(query, ...(bindings as SqlStorageValue[]));
  });
  try {
    return { value: apply(), bindings: bindingsPerStatement };
  } finally {
    spy.mockRestore();
  }
}

describe('a build seed referencing its borrowed artifacts', () => {
  it.each([0, 1, 16, 17, 99, 100, 101, 512, 1024])(
    'references %i artifacts within SQLite statement and parameter bounds',
    async (count) => {
      const refs = Array.from({ length: count }, (_, index) => artifactAt(index));
      const result = await inScope(async (tx, storage) => {
        const apply = await planSeedEntries(tx, {
          scopeId: tx.scopeId,
          batchIndex: 0,
          entries: [seedOf(refs)],
        });
        const measured = countedArtifacts(tx.sql, () => storage.transactionSync(apply));
        return {
          ...measured,
          artifacts: tx.sql
            .exec<{ count: number; refs: number; owned: number }>(
              `SELECT COUNT(*) AS count,COALESCE(SUM(refs),0) AS refs,COALESCE(SUM(owned),0) AS owned FROM artifacts`,
            )
            .one(),
        };
      });

      expect(result.value).toMatchObject({ inserted: 1, skipped: 0, refused: [], revision: 2 });
      expect(result.artifacts).toStrictEqual({ count, refs: count, owned: 0 });
      expect(result.bindings).toHaveLength(2 * Math.ceil(count / 100) + Math.ceil(count / 16));
      expect(Math.max(0, ...result.bindings)).toBeLessThanOrEqual(100);
    },
  );

  it('retains the first fresh entry location when another entry in the same batch shares its SHA', async () => {
    const result = await inScope(async (tx, storage) => {
      const { sql } = tx;
      const first = { ...artifactAt(0), storageRef: 'first', byteLength: 3 };
      const later = { ...first, storageRef: 'later', byteLength: 9 };
      sql.exec(
        `INSERT INTO pending_deletions (storage_ref,queued_at) VALUES ('first',1),('later',1)`,
      );
      const apply = await planSeedEntries(tx, {
        scopeId: tx.scopeId,
        batchIndex: 0,
        entries: [seedOf([first], '/a'), seedOf([later], '/b')],
      });
      const seeded = storage.transactionSync(apply);
      return {
        seeded,
        artifact: sql.exec<ArtifactRow>(`SELECT * FROM artifacts`).one(),
        pending: Array.from(
          sql.exec<{ storage_ref: string }>(`SELECT storage_ref FROM pending_deletions`),
          (row) => row.storage_ref,
        ),
        generations: sql
          .exec<{ pathname: string; body_bytes: number; published_revision: number }>(
            `SELECT e.pathname,g.body_bytes,g.published_revision FROM entries e JOIN generations g ON g.generation_id = e.current_generation_id ORDER BY e.pathname`,
          )
          .toArray(),
      };
    });

    expect(result.seeded).toMatchObject({ inserted: 2, refused: [], revision: 2 });
    expect(result.artifact).toMatchObject({
      storage_ref: 'first',
      byte_length: 3,
      refs: 2,
      owned: 0,
    });
    expect(result.pending).toStrictEqual(['later']);
    expect(result.generations).toStrictEqual([
      { pathname: '/a', body_bytes: 3, published_revision: 2 },
      { pathname: '/b', body_bytes: 9, published_revision: 2 },
    ]);
  });

  it('keeps each first location, all occurrences and existing owned metadata when references revive', async () => {
    const result = await inScope(async (tx, storage) => {
      const { sql } = tx;
      const owned = {
        ...artifactAt(0),
        artifactId: 'owned-canonical',
        storageRef: 'owned-original',
        byteLength: 9,
        owned: true,
      };
      referenceArtifact(sql, owned, NOW - 1);
      releaseArtifact(sql, owned.sha256);
      const borrowed = {
        ...artifactAt(1),
        artifactId: 'borrowed-canonical',
        storageRef: 'borrowed-original',
        byteLength: 7,
        owned: false,
      };
      referenceArtifact(sql, borrowed, NOW - 1);
      const firstNew = { ...artifactAt(2), storageRef: 'new-first', byteLength: 3 };
      const refs = [
        { ...artifactAt(0), storageRef: 'owned-proposed' },
        { ...artifactAt(1), storageRef: 'borrowed-proposed' },
        firstNew,
        { ...firstNew, storageRef: 'new-later', byteLength: 17 },
        artifactAt(0),
      ];
      for (const key of [
        'owned-original',
        'borrowed-original',
        'owned-proposed',
        'borrowed-proposed',
        'new-first',
        'new-later',
      ]) {
        sql.exec(
          `INSERT INTO pending_deletions (storage_ref,queued_at) VALUES (?,?)`,
          key,
          NOW - 1,
        );
      }
      const events: string[] = [];
      const history = {
        ...NO_HISTORY,
        append(_context: unknown, event: { kind: string }) {
          events.push(event.kind);
        },
      };
      const apply = await planSeedEntries(
        { ...tx, history },
        { scopeId: tx.scopeId, batchIndex: 0, entries: [seedOf(refs)] },
      );
      const seeded = storage.transactionSync(apply);
      return {
        seeded,
        events,
        rows: sql.exec<ArtifactRow>(`SELECT * FROM artifacts ORDER BY sha256`).toArray(),
        pending: Array.from(
          sql.exec<{ storage_ref: string }>(
            `SELECT storage_ref FROM pending_deletions ORDER BY storage_ref`,
          ),
          (row) => row.storage_ref,
        ),
        generation: sql
          .exec<{ body_bytes: number; published_revision: number }>(
            `SELECT body_bytes,published_revision FROM generations`,
          )
          .one(),
        scope: sql
          .exec<{ body_bytes: number; entry_count: number; revision: number }>(
            `SELECT body_bytes,entry_count,revision FROM scope`,
          )
          .one(),
      };
    });

    expect(result.seeded).toMatchObject({ inserted: 1, refused: [], revision: 2 });
    expect(result.rows).toMatchObject([
      {
        artifact_id: 'owned-canonical',
        storage_ref: 'owned-original',
        byte_length: 9,
        owned: 1,
        refs: 2,
        referenced_at: NOW,
      },
      {
        artifact_id: 'borrowed-canonical',
        storage_ref: 'borrowed-original',
        byte_length: 7,
        owned: 0,
        refs: 2,
        referenced_at: NOW,
      },
      { storage_ref: 'new-first', byte_length: 3, owned: 0, refs: 2, referenced_at: NOW },
    ]);
    expect(result.pending).toStrictEqual(['borrowed-proposed', 'new-later', 'owned-proposed']);
    expect(result.generation).toStrictEqual({ body_bytes: 23, published_revision: 2 });
    expect(result.scope).toStrictEqual({ body_bytes: 0, entry_count: 1, revision: 2 });
    expect(result.events).toStrictEqual(['entry.created', 'generation.committed']);
  });

  it('rolls canonical revivals, pending deletions and earlier inserts back when a later chunk fails', async () => {
    const result = await inScope(async (tx, storage) => {
      const { sql } = tx;
      const refs = Array.from({ length: 17 }, (_, index) => artifactAt(index));
      const first = { ...artifactAt(0), artifactId: 'owned-canonical', owned: true };
      referenceArtifact(sql, first, NOW - 1);
      releaseArtifact(sql, first.sha256);
      for (const ref of refs)
        sql.exec(
          `INSERT INTO pending_deletions (storage_ref,queued_at) VALUES (?,?)`,
          ref.storageRef,
          NOW - 1,
        );
      sql.exec(`CREATE TRIGGER reject_artifact BEFORE INSERT ON artifacts
        WHEN NEW.sha256 = '${artifactAt(16).sha256}' BEGIN SELECT RAISE(ABORT,'refused artifact'); END`);
      const apply = await planSeedEntries(tx, {
        scopeId: tx.scopeId,
        batchIndex: 0,
        entries: [seedOf(refs)],
      });

      expect(() => storage.transactionSync(apply)).toThrow('refused artifact');

      return {
        rows: sql.exec<ArtifactRow>(`SELECT * FROM artifacts`).toArray(),
        pending: sql
          .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM pending_deletions`)
          .one().count,
        generations: sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM generations`).one()
          .count,
        scope: sql
          .exec<{ revision: number; entry_count: number }>(`SELECT revision,entry_count FROM scope`)
          .one(),
      };
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      artifact_id: 'owned-canonical',
      owned: 1,
      refs: 0,
      referenced_at: NOW - 1,
    });
    expect(result.pending).toBe(17);
    expect(result.generations).toBe(0);
    expect(result.scope).toStrictEqual({ revision: 1, entry_count: 0 });
  });
});
