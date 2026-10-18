import { sha256Hex } from '@stayingupwind/core/artifact';
import { decodeGenerationPack, policyFromBuild } from '@stayingupwind/core/cache';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it, vi } from 'vitest';

import type { BlobStore } from '../src/scope/io.ts';
import {
  PROJECTION_MEMORY_BYTES,
  withProjectionMemory,
  withProjectionMemoryAtOnce,
} from '../src/scope/projection-memory.ts';
import { generationRecordBytes, InvalidArtifactError } from '../src/scope/records.ts';
import type { EntryRow, GenerationRow } from '../src/scope/rows.ts';

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
