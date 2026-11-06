import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import {
  deleteStaticManifest,
  pruneOrphanStaticManifests,
} from '../../src/aws/lifecycle/asset-retention.ts';
import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import { recordKey } from '../../src/aws/lifecycle/state.ts';

function failure(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function fixture() {
  const now = 7_200_000;
  const objects = new Map<string, { body: string; etag: string; modified?: Date }>();
  const removed: { key: string; etag?: string }[] = [];
  let beforeDelete: (() => void) | undefined;
  const send = vi.fn(async (command: unknown): Promise<unknown> => {
    if (command instanceof ListObjectsV2Command) {
      const keys = [...objects.keys()]
        .filter(
          (key) =>
            key.startsWith(command.input.Prefix ?? '') &&
            (command.input.ContinuationToken === undefined ||
              key > command.input.ContinuationToken),
        )
        .sort();
      const selected = keys.slice(0, 2);
      return {
        Contents: selected.map((Key) => ({
          Key,
          ETag: objects.get(Key)?.etag,
          LastModified: objects.get(Key)?.modified,
        })),
        IsTruncated: keys.length > selected.length,
        ...(keys.length > selected.length ? { NextContinuationToken: selected.at(-1) } : {}),
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key ?? '');
      if (object === undefined) throw failure('NoSuchKey', 404);
      return { ETag: object.etag, Body: { transformToString: () => Promise.resolve(object.body) } };
    }
    if (command instanceof DeleteObjectCommand) {
      beforeDelete?.();
      const key = command.input.Key ?? '';
      const prior = objects.get(key);
      if (command.input.IfMatch !== undefined && command.input.IfMatch !== prior?.etag)
        throw failure('PreconditionFailed', 412);
      removed.push({
        key,
        ...(command.input.IfMatch === undefined ? {} : { etag: command.input.IfMatch }),
      });
      objects.delete(key);
      return {};
    }
    throw new Error('unexpected storage command');
  });
  const context: AwsContext = {
    services: { objects: { send } } as unknown as AwsServices,
    fetch,
    now: () => now,
    sleep: async () => undefined,
  };
  const lock = { assertHeld: vi.fn(async () => undefined) };
  const manifest = (id: string, modified: Date | undefined = new Date(0)): string => {
    const key = `static-manifests/${id}.json`;
    objects.set(key, {
      body: 'immutable-manifest',
      etag: id,
      ...(modified === undefined ? {} : { modified }),
    });
    return key;
  };
  const record = (id: string, status: string): void => {
    objects.set(recordKey(id), {
      etag: id,
      body: JSON.stringify({ v: 1, compute: 'fargate', deploymentId: id, status }),
    });
  };
  return {
    context,
    objects,
    removed,
    lock,
    send,
    manifest,
    record,
    beforeDelete: (hook: () => void) => {
      beforeDelete = hook;
    },
  };
}

describe('AWS retained static manifest cleanup', () => {
  it('deletes a retired manifest idempotently and preserves immutable asset bytes', async () => {
    const value = fixture();
    const key = value.manifest('expired');
    value.objects.set('static/_next/static/chunk.js', { body: 'immutable-bytes', etag: 'asset' });
    await deleteStaticManifest(value.context, 'bucket', 'expired', value.lock);
    await deleteStaticManifest(value.context, 'bucket', 'expired', value.lock);
    expect(value.objects.has(key)).toBe(false);
    expect(value.objects.get('static/_next/static/chunk.js')?.body).toBe('immutable-bytes');
    expect(value.removed.map((item) => item.key)).toStrictEqual([key, key]);
  });

  it('prunes old missing/deleted records across pages while preserving rollback, staging and recent uploads', async () => {
    const value = fixture();
    const orphan = value.manifest('a-orphan');
    const deleted = value.manifest('b-deleted');
    value.record('b-deleted', 'deleted');
    for (const status of ['live', 'kept', 'staging']) {
      value.manifest(`c-${status}`);
      value.record(`c-${status}`, status);
    }
    value.manifest('d-young', new Date(value.context.now() - 3_600_000));
    value.manifest('e-future', new Date(value.context.now() + 1000));
    const unknownAge = value.manifest('f-unknown');
    value.objects.set(unknownAge, { body: 'manifest', etag: 'unknown' });
    value.objects.set('static/_next/static/orphan.js', { body: 'asset', etag: 'asset' });
    await pruneOrphanStaticManifests(value.context, 'bucket', value.lock);
    expect(value.removed).toStrictEqual([
      { key: orphan, etag: 'a-orphan' },
      { key: deleted, etag: 'b-deleted' },
    ]);
    expect(
      [...value.objects.keys()].filter((key) => key.startsWith('static-manifests/')),
    ).toHaveLength(6);
    expect(value.objects.has('static/_next/static/orphan.js')).toBe(true);
    expect(
      value.send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command).length,
    ).toBeGreaterThan(1);
  });

  it('refuses deletion after losing the project lock', async () => {
    const value = fixture();
    const key = value.manifest('orphan');
    value.lock.assertHeld
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lock changed'));
    await expect(pruneOrphanStaticManifests(value.context, 'bucket', value.lock)).rejects.toThrow(
      'lock changed',
    );
    expect(value.objects.has(key)).toBe(true);
    expect(value.removed).toStrictEqual([]);
  });

  it('never deletes a manifest replaced after its age was observed', async () => {
    const value = fixture();
    const key = value.manifest('orphan');
    value.beforeDelete(() => value.objects.set(key, { body: 'new', etag: 'new-version' }));
    await expect(
      pruneOrphanStaticManifests(value.context, 'bucket', value.lock),
    ).rejects.toMatchObject({ name: 'PreconditionFailed' });
    expect(value.objects.get(key)?.body).toBe('new');
  });
});
