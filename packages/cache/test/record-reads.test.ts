import { sha256Hex } from '@stayingupwind/core/artifact';
import { decodeGenerationPack, policyFromBuild } from '@stayingupwind/core/cache';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { identifyEntry, insertEntry, publishEntry } from '../src/scope/entries.ts';
import { type GenerationInsert, insertGeneration } from '../src/scope/generations.ts';
import type { BlobStore } from '../src/scope/io.ts';
import {
  PROJECTION_MEMORY_BYTES,
  withProjectionMemory,
  withProjectionMemoryAtOnce,
} from '../src/scope/projection-memory.ts';
import { readCurrentData } from '../src/scope/reads.ts';
import { generationRecordBytes, InvalidArtifactError } from '../src/scope/records.ts';
import { type EntryRow, generationOutputs, type GenerationRow } from '../src/scope/rows.ts';
import { applySchema } from '../src/scope/schema.ts';
import { scopeStub } from '../src/scope/stub.ts';

const HTML = encodeUtf8('<p>document</p>');
const STATE = encodeUtf8('postponed state');
const NOW = 1_800_000_000_000;
const ENTRY: EntryRow = {
  entry_id: 'entry',
  kind: 'app-page',
  route: '/',
  pathname: '/',
  cache_key_digest: 'digest',
  group_instance_id: null,
  key_descriptor: '{}',
  handler: null,
  created_at: NOW,
  created_revision: 1,
  revision: 1,
  record_revision: 1,
  kv_revision: 0,
  current_generation_id: 'generation',
  publication: 'published',
  regeneration: 'idle',
  regeneration_attempt_id: null,
  failed_count: 0,
  next_retry_at: null,
  tombstone_revision: null,
  committed_at: NOW,
  updated_at: NOW,
  fencing_max: 0,
  seq_max: 1,
};

async function generation(): Promise<GenerationRow> {
  return {
    generation_id: 'generation',
    entry_id: ENTRY.entry_id,
    seq: 1,
    source: 'build',
    attempt_id: null,
    cache_timestamp: NOW,
    produced_at: NOW,
    policy: JSON.stringify(policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 })),
    status: 200,
    headers: '{}',
    tags: '[]',
    dependency_coverage: 'complete',
    dependency_revision: 0,
    publication: 'published',
    published_revision: 1,
    superseded_revision: null,
    condemned: null,
    storage: 'present',
    pruned_at: null,
    body_bytes: HTML.byteLength + STATE.byteLength,
    producer: null,
    outputs: JSON.stringify([
      {
        outputId: 'output',
        representationKey: 'html',
        pathname: '/',
        status: 200,
        headers: {},
        compute: 'static',
        response: 'complete',
        htmlSize: HTML.byteLength,
        artifacts: await Promise.all(
          [
            { role: 'html', bytes: HTML },
            { role: 'postponed', bytes: STATE },
          ].map(async ({ role, bytes }) => {
            return {
              artifactId: role,
              role,
              sha256: await sha256Hex(bytes),
              byteLength: bytes.byteLength,
              contentType: 'text/plain',
              encoding: 'identity',
              storageRef: role,
            };
          }),
        ),
      },
    ]),
    committed_at: NOW,
  };
}

function store(read: BlobStore['read']): BlobStore {
  return {
    read,
    exists: () => Promise.resolve(false),
    write: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    deletePrefix: () => Promise.resolve(),
    listPage: () => Promise.resolve({ objects: [], cursor: undefined }),
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function observe(building: Promise<unknown>, failed: (error: unknown) => void) {
  try {
    await building;
  } catch (error) {
    failed(error);
  }
}

describe('the reads a delivery record holds room for', () => {
  it.each([
    { first: 'html', failure: 'missing', errorType: InvalidArtifactError },
    { first: 'html', failure: 'length', errorType: InvalidArtifactError },
    { first: 'html', failure: 'digest', errorType: InvalidArtifactError },
    { first: 'html', failure: 'read', errorType: Error },
    { first: 'postponed', failure: 'missing', errorType: InvalidArtifactError },
  ])(
    'keeps room after $first $failure until the other read ends',
    async ({ first, failure, errorType }) => {
      const current = await generation();
      const pending = Promise.withResolvers<Uint8Array | undefined>();
      const fault = new Error('storage read failed');
      const reads: string[] = [];
      const blobs = store((key) => {
        reads.push(key);
        if (key !== first) return pending.promise;
        switch (failure) {
          case 'length': {
            return Promise.resolve(new Uint8Array(1));
          }
          case 'digest': {
            return Promise.resolve(new Uint8Array(HTML.byteLength));
          }
          case 'read': {
            return Promise.reject(fault);
          }
          default: {
            return Promise.resolve(undefined);
          }
        }
      });
      const failed = vi.fn<(error: unknown) => void>();
      const building = observe(
        withProjectionMemory(PROJECTION_MEMORY_BYTES, () =>
          generationRecordBytes({ blobs, scopeId: 'scope' }, ENTRY, current),
        ),
        failed,
      );
      try {
        await nextTurn();

        expect(reads).toStrictEqual(['html', 'postponed']);
        await expect(
          withProjectionMemoryAtOnce(1, () => Promise.resolve('next')),
        ).resolves.toBeUndefined();
        expect(failed).not.toHaveBeenCalled();
      } finally {
        pending.resolve(first === 'html' ? STATE : HTML);
        await building;
      }

      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed.mock.calls[0]?.[0]).toBeInstanceOf(errorType);
      await expect(withProjectionMemoryAtOnce(1, () => Promise.resolve('next'))).resolves.toBe(
        'next',
      );
    },
  );

  it.each(['missing', 'rejected', 'cancelled'])(
    'holds the original failure until a late %s read settles',
    async (late) => {
      const current = await generation();
      const pending = Promise.withResolvers<Uint8Array | undefined>();
      const original = new Error('HTML read failed');
      const blobs = store((key) => (key === 'html' ? Promise.reject(original) : pending.promise));
      const failed = vi.fn<(error: unknown) => void>();
      const building = observe(
        withProjectionMemory(PROJECTION_MEMORY_BYTES, () =>
          generationRecordBytes({ blobs, scopeId: 'scope' }, ENTRY, current),
        ),
        failed,
      );
      try {
        await nextTurn();

        await expect(
          withProjectionMemoryAtOnce(1, () => Promise.resolve('next')),
        ).resolves.toBeUndefined();
        expect(failed).not.toHaveBeenCalled();
      } finally {
        if (late === 'missing') pending.resolve(undefined);
        else if (late === 'cancelled') pending.reject(new DOMException('cancelled', 'AbortError'));
        else pending.reject(new Error('late storage failure'));
        await building;
      }

      expect(failed).toHaveBeenCalledExactlyOnceWith(original);
      await expect(withProjectionMemoryAtOnce(1, () => Promise.resolve('next'))).resolves.toBe(
        'next',
      );
    },
  );

  it('starts both valid reads together and writes the same complete pack', async () => {
    const current = await generation();
    const html = Promise.withResolvers<Uint8Array>();
    const state = Promise.withResolvers<Uint8Array>();
    const read = vi.fn((key: string) => (key === 'html' ? html.promise : state.promise));
    const deps = { blobs: store(read), scopeId: 'scope' };
    const building = generationRecordBytes(deps, ENTRY, current);

    expect(read.mock.calls).toStrictEqual([['html'], ['postponed']]);

    state.resolve(STATE);
    html.resolve(HTML);
    const bytes = await building;
    const control = await generationRecordBytes(
      { ...deps, blobs: store((key) => Promise.resolve(key === 'html' ? HTML : STATE)) },
      ENTRY,
      current,
    );

    expect(bytes).toStrictEqual(control);

    const pack = decodeGenerationPack(bytes);

    expect(pack.kind).toBe('ok');

    expect(pack).toHaveProperty('pack.html', HTML);
    expect(pack).toHaveProperty('pack.postponed', STATE);
  });
});

/** A real SQLite data entry whose inline bytes are read through the supplied BlobStore. */
async function currentDataFixture(sql: SqlStorage, scopeId: string) {
  applySchema(sql, []);
  const identity = await identifyEntry(scopeId, { kind: 'data:fetch', key: 'current-key' });
  insertEntry(sql, { identity, groupInstanceId: null, revision: 1, now: NOW });
  const row = await generation();
  const initial: GenerationInsert = {
    generationId: 'generation',
    entryId: identity.entryId,
    seq: 1,
    source: 'build',
    attemptId: null,
    cacheTimestamp: NOW,
    producedAt: NOW,
    policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
    status: 200,
    headers: {},
    tags: [],
    dependencyCoverage: 'complete',
    dependencyRevision: 1,
    publishedRevision: 1,
    condemned: null,
    bodyBytes: HTML.byteLength,
    producer: null,
    outputs: generationOutputs(row),
    committedAt: NOW,
  };
  insertGeneration(sql, initial);
  publishEntry(sql, {
    entryId: identity.entryId,
    generationId: 'generation',
    seq: 1,
    revision: 1,
    now: NOW,
  });
  return { identity, initial };
}

describe('a current data record while its bytes are read', () => {
  it.each([
    'generation',
    'record-revision',
    'retired',
    'deleted',
    'metadata-only',
    'unchanged',
  ] as const)('keeps authority state consistent after %s changes', async (scenario) => {
    const scopeId = `scope-${crypto.randomUUID()}`;
    const result = await runInDurableObject(scopeStub(env, scopeId), async (_instance, state) => {
      const sql = state.storage.sql;
      const { identity, initial } = await currentDataFixture(sql, scopeId);
      const pending = Promise.withResolvers<Uint8Array | undefined>();
      const entered = Promise.withResolvers<true>();
      const budget = { reserved: 0, limit: 1024 * 1024 };
      const reading = readCurrentData(
        {
          sql,
          scopeId,
          blobs: store(() => {
            entered.resolve(true);
            return pending.promise;
          }),
        },
        { kind: 'data:fetch', key: 'current-key' },
        budget,
      );
      await entered.promise;

      switch (scenario) {
        case 'generation': {
          insertGeneration(sql, {
            ...initial,
            generationId: 'next',
            seq: 2,
            dependencyRevision: 2,
          });
          publishEntry(sql, {
            entryId: identity.entryId,
            generationId: 'next',
            seq: 2,
            revision: 2,
            now: NOW,
          });
          break;
        }
        case 'record-revision': {
          sql.exec('UPDATE entries SET record_revision = 2 WHERE entry_id = ?', identity.entryId);
          sql.exec(
            'UPDATE generations SET condemned = ? WHERE generation_id = ?',
            JSON.stringify({ revision: 2, staleAt: NOW, hardExpireAt: null }),
            initial.generationId,
          );
          break;
        }
        case 'retired': {
          sql.exec(
            "UPDATE entries SET publication = 'retired' WHERE entry_id = ?",
            identity.entryId,
          );
          break;
        }
        case 'deleted': {
          sql.exec('DELETE FROM entries WHERE entry_id = ?', identity.entryId);
          break;
        }
        case 'metadata-only': {
          sql.exec('UPDATE entries SET revision = 2 WHERE entry_id = ?', identity.entryId);
          break;
        }
        case 'unchanged': {
          break;
        }
      }
      pending.resolve(HTML);
      return { value: await reading, reserved: budget.reserved };
    });

    expect(result.reserved).toBe(0);

    const stands = scenario === 'unchanged' || scenario === 'metadata-only';

    expect(result.value?.value).toStrictEqual(
      stands ? { kind: 'inline', base64: btoa(new TextDecoder().decode(HTML)) } : undefined,
    );
    expect(result.value?.revision).toBe(stands ? 1 : undefined);
  });

  it('keeps the no-room reference path without reading bytes', async () => {
    const scopeId = `scope-${crypto.randomUUID()}`;
    const result = await runInDurableObject(scopeStub(env, scopeId), async (_instance, state) => {
      await currentDataFixture(state.storage.sql, scopeId);
      const read = vi.fn<BlobStore['read']>();
      const budget = { reserved: 0, limit: 0 };
      const value = await readCurrentData(
        { sql: state.storage.sql, scopeId, blobs: store(read) },
        { kind: 'data:fetch', key: 'current-key' },
        budget,
      );
      return { value, reads: read.mock.calls.length, reserved: budget.reserved };
    });

    expect(result.reads).toBe(0);
    expect(result.reserved).toBe(0);
    expect(result.value?.value.kind).toBe('ref');
  });
});
