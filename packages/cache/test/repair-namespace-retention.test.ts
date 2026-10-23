import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  createRepairStorageNamespace,
  createRepairStorageRef,
  r2CachePrefix,
} from '@stayingupwind/core/cache';
import { createId, encodeUtf8 } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { createLogger } from '../src/logger.ts';
import {
  dataUploadScanPending,
  listDataUploads,
  queueDataUploads,
} from '../src/scope/data-uploads.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { blobStore } from '../src/scope/io.ts';
import { repairUploadMetadata } from '../src/scope/repair-upload.ts';
import { eraseScopeStorage } from '../src/scope/retention-run.ts';
import { forgetDeletions } from '../src/scope/retention.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';

const HOUR = 3_600_000;
const BYTES = encodeUtf8('a copied seed remains borrowed for quota');

describe('repair namespace retention', () => {
  it('sweeps abandoned copies, protects live borrowed refs and pins, and erases only its own provenance', async () => {
    const scopeId = createId('dpl');
    const namespace = createRepairStorageNamespace();
    const keys = {
      borrowed: createRepairStorageRef(namespace),
      pinned: createRepairStorageRef(namespace),
      orphan: createRepairStorageRef(namespace),
      foreign: createRepairStorageRef(namespace),
    };
    const sha256 = await sha256Hex(BYTES);
    const stub = scopeStub(env, scopeId);
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const now = Date.now() + 2 * HOUR;
      applySchema(sql, []);
      applySeedScope(
        { sql, scopeId, limits: limitsOf(parseVars({})), now, revision: 1, history: NO_HISTORY },
        {
          scope: {
            scopeId,
            organizationId: 'owner',
            projectId: 'project',
            environmentId: 'production',
            deploymentId: scopeId,
            buildId: 'build',
            keySchemaVersion: 1,
          },
        },
      );
      // This fixture tests the sweep independently of the separately covered immutable seed seal.
      sql.exec('UPDATE scope SET pack_schema_version = 2, repair_namespace = ?', namespace);
      const owner = state.id.toString();
      for (const [name, key] of Object.entries(keys)) {
        await env.ARTIFACTS.put(key, BYTES as BufferSource, {
          sha256,
          customMetadata: repairUploadMetadata({
            namespace,
            attemptId: 'copy-request',
            sha256,
            byteLength: BYTES.byteLength,
            scopeOwner: name === 'foreign' ? '0'.repeat(64) : owner,
          }),
        });
      }
      for (const [index, name] of ['borrowed', 'pinned'].entries()) {
        const key = name === 'borrowed' ? keys.borrowed : keys.pinned;
        sql.exec(
          `INSERT INTO artifacts (artifact_id, sha256, storage_ref, byte_length, owned, refs, referenced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          `artifact-${name}`,
          String(index).repeat(64),
          key,
          BYTES.byteLength,
          index,
          name === 'borrowed' ? 1 : 0,
          now,
        );
      }
      sql.exec(
        'INSERT INTO meta (key, value) VALUES (?, ?)',
        `artifact_repair_pin:${'1'.repeat(64)}`,
        'accepted-job',
      );
      const blobs = blobStore(env.ARTIFACTS, () => ({}), { repairOwner: owner });
      const phases: string[] = [];
      const pending: boolean[] = [];
      for (let index = 0; index < 3; index += 1) {
        const page = await listDataUploads({ sql, scopeId, blobs });
        phases.push(page.phase);
        state.storage.transactionSync(() => queueDataUploads({ sql, scopeId, now, page }));
        pending.push(dataUploadScanPending(sql));
      }
      const deletions = sql
        .exec<{ storage_ref: string }>(
          'SELECT storage_ref FROM pending_deletions ORDER BY storage_ref',
        )
        .toArray()
        .map((row) => row.storage_ref);
      await blobs.delete(deletions);
      const afterSweep = (await env.ARTIFACTS.list({ prefix: `r/${namespace}/` })).objects.map(
        (object) => object.key,
      );
      state.storage.transactionSync(() => forgetDeletions(sql, deletions));
      // A failed request can finish a fresh physical PUT after a previous sweep's last page.
      const late = createRepairStorageRef(namespace);
      await env.ARTIFACTS.put(late, BYTES as BufferSource, {
        sha256,
        customMetadata: repairUploadMetadata({
          namespace,
          attemptId: 'late-copy',
          sha256,
          byteLength: BYTES.byteLength,
          scopeOwner: owner,
        }),
      });
      for (let index = 0; index < 3; index += 1) {
        const page = await listDataUploads({ sql, scopeId, blobs });
        state.storage.transactionSync(() =>
          queueDataUploads({ sql, scopeId, now: now + HOUR, page }),
        );
      }
      const lateDeletions = sql
        .exec<{ storage_ref: string }>('SELECT storage_ref FROM pending_deletions')
        .toArray()
        .map((row) => row.storage_ref);
      await blobs.delete(lateDeletions);
      state.storage.transactionSync(() => forgetDeletions(sql, lateDeletions));

      const ordinary = `${r2CachePrefix(scopeId)}leftover`;
      await env.ARTIFACTS.put(ordinary, 'leftover');
      // The caller invokes whole-scope erasure only after retirement and all SQL obligations end.
      const erased = await eraseScopeStorage(scopeId, blobs, createLogger(), namespace);
      const afterErase = (await env.ARTIFACTS.list({ prefix: `r/${namespace}/` })).objects.map(
        (object) => object.key,
      );
      return {
        phases,
        pending,
        late,
        lateDeletions,
        deletions,
        afterSweep,
        afterErase,
        erased,
        ordinary: await env.ARTIFACTS.head(ordinary),
      };
    });

    expect(result.phases).toStrictEqual(['data', 'blobs', 'repairs']);
    expect(result.pending).toStrictEqual([true, true, false]);
    expect(result.deletions).toStrictEqual([keys.orphan]);
    expect(result.afterSweep.toSorted()).toStrictEqual(
      [keys.borrowed, keys.pinned, keys.foreign].toSorted(),
    );
    expect(result.lateDeletions).toStrictEqual([result.late]);
    expect(result.erased).toBe(true);
    expect(result.afterErase).toStrictEqual([keys.foreign]);
    expect(result.ordinary).toBeNull();
  });
});
