import { randomUUID } from 'node:crypto';

import { decodeGenerationPack, finiteSeconds } from '@stayingupwind/core/cache';
import type { CommitRequest } from '@stayingupwind/runtime/cache-host';
import { describe, expect, test } from 'vitest';

import type { AuthorityStore } from '../../src/aws/types.ts';
import { pair } from './support.ts';

export function cacheContract(
  name: string,
  makeStore: (scope: string) => Promise<AuthorityStore>,
): void {
  describe(name, () => {
    test('one task owns a generation lease; a second task reads its paired shell and resume state', async () => {
      const store = await makeStore(`scope_${randomUUID()}`);
      const host = await pair(store);
      try {
        const entry = { kind: 'app-page' as const, route: '/', pathname: '/' };
        const lease = await host.first.startAttempt({ entry, reason: 'miss' });
        expect(lease.kind).toBe('leased');
        if (lease.kind !== 'leased') throw new Error('lease missing');
        expect((await host.second.startAttempt({ entry, reason: 'miss' })).kind).toBe('busy');
        const html = await host.first.uploadArtifact({
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
          role: 'html',
          contentType: 'text/html',
          bytes: new TextEncoder().encode('<p>shell</p>'),
        });
        const postponed = await host.first.uploadArtifact({
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
          role: 'postponed',
          contentType: 'application/json',
          bytes: new TextEncoder().encode('resume-state'),
        });
        const commit: CommitRequest = {
          fencingToken: lease.fencingToken,
          observedTagRevision: 0,
          heldTagRevisions: {},
          generation: {
            cacheTimestamp: Date.now(),
            producedAt: Date.now(),
            policy: {
              revalidateAfter: finiteSeconds(10),
              expireAfter: finiteSeconds(60),
              clientStale: finiteSeconds(0),
              source: 'runtime-output',
            },
            status: 200,
            headers: { 'content-type': 'text/html' },
            tags: [{ kind: 'next-explicit', value: 'product' }],
            reason: 'miss',
            outputs: [
              {
                representationKey: 'html',
                pathname: '/',
                status: 200,
                headers: { 'content-type': 'text/html' },
                compute: 'resuming',
                response: 'initial',
                htmlSize: 12,
                artifacts: [
                  { ...html, role: 'html', contentType: 'text/html' },
                  { ...postponed, role: 'postponed', contentType: 'application/json' },
                ],
              },
            ],
          },
        };
        const result = await host.first.commit(lease.attemptId, commit);
        expect(result.kind).toBe('published');
        expect(await host.first.commit(lease.attemptId, commit)).toMatchObject(
          result.kind === 'published'
            ? { kind: 'published', generationId: result.generationId }
            : { kind: 'published' },
        );
        const bytes = await host.second.readRecord(lease.entryId);
        expect(bytes).toBeDefined();
        const record = decodeGenerationPack(bytes ?? new Uint8Array());
        expect(record.kind).toBe('ok');
        if (record.kind !== 'ok') throw new Error('record missing');
        expect(new TextDecoder().decode(record.pack.html)).toBe('<p>shell</p>');
        expect(new TextDecoder().decode(record.pack.postponed)).toBe('resume-state');
        await host.first.invalidate({ tags: ['product'], api: 'updateTag' });
        const after = decodeGenerationPack(
          (await host.second.readRecord(lease.entryId)) ?? new Uint8Array(),
        );
        expect(after.kind).toBe('ok');
        if (after.kind === 'ok') expect(after.pack.header.invalidation?.hardExpireAt).toBeDefined();
      } finally {
        await host.close();
      }
    }, 30_000);

    test('shares data and preserves writer ordering, namespace isolation and earlier expiry', async () => {
      const store = await makeStore(`scope_${randomUUID()}`);
      const host = await pair(store);
      try {
        const write = {
          key: 'key',
          entry: {
            kind: 'data:use-cache' as const,
            handler: 'default',
            tags: ['product'],
            stale: 0,
            timestamp: Date.now() - 10_000,
            expire: 3600,
            revalidate: 60,
          },
          valueBase64: Buffer.from('newer').toString('base64'),
          order: { writer: 'task-one', seq: 2 },
        };
        const published = await host.first.setData(write);
        expect(
          await host.second.getData({ key: 'key', kind: 'data:use-cache', handler: 'default' }),
        ).toMatchObject({
          generationId: published.generationId,
          value: { kind: 'inline', base64: write.valueBase64 },
        });
        expect(
          await host.second.getData({ key: 'key', kind: 'data:use-cache', handler: 'other' }),
        ).toBeUndefined();
        expect(await host.second.getData({ key: 'key', kind: 'data:fetch' })).toBeUndefined();
        expect(
          await host.second.setData({
            ...write,
            valueBase64: Buffer.from('older').toString('base64'),
            order: { writer: 'task-one', seq: 1 },
          }),
        ).toMatchObject({ generationId: published.generationId, superseded: true });
        const immediate = await host.first.invalidate({ tags: ['product'], api: 'updateTag' });
        await host.second.invalidate({ tags: ['product'], api: 'revalidateTag', expire: 300 });
        const read = await host.second.getData({
          key: 'key',
          kind: 'data:use-cache',
          handler: 'default',
        });
        expect(read?.invalidation?.hardExpireAt).toBeLessThanOrEqual(
          immediate.invalidations[0]?.hardExpireAt ?? Infinity,
        );
      } finally {
        await host.close();
      }
    }, 30_000);

    test('accepts 128 tags in one invalidation and a 1024-tag cache value without oversized transactions', async () => {
      const store = await makeStore(`scope_${randomUUID()}`);
      const host = await pair(store);
      try {
        const tags = Array.from({ length: 1024 }, (_, index) => `tag-${index}`);
        await host.first.setData({
          key: 'many-tags',
          entry: {
            kind: 'data:use-cache',
            handler: 'default',
            tags,
            stale: 0,
            timestamp: Date.now() - 10_000,
            expire: 3600,
            revalidate: 60,
          },
          valueBase64: 'eA==',
        });
        const invalidated = await host.second.invalidate({
          tags: tags.slice(0, 128),
          api: 'updateTag',
        });
        expect(invalidated.invalidations).toHaveLength(128);
        expect((await host.first.getTags(tags)).tags).toHaveLength(128);
        expect(
          (
            await host.first.getData({
              key: 'many-tags',
              kind: 'data:use-cache',
              handler: 'default',
            })
          )?.invalidation,
        ).toBeDefined();
        const delta = await host.second.tagsDelta(0);
        expect(delta.tags).toHaveLength(128);
        expect(delta.truncated).toBe(false);
      } finally {
        await host.close();
      }
    }, 30_000);

    test('a lease replaced after failure fences the old renderer and retirement prevents resurrection', async () => {
      const store = await makeStore(`scope_${randomUUID()}`);
      const host = await pair(store);
      try {
        const entry = { kind: 'app-page' as const, route: '/', pathname: '/' };
        const first = await host.first.startAttempt({ entry, reason: 'miss' });
        if (first.kind !== 'leased') throw new Error('lease missing');
        await host.first.fail(first.attemptId, {
          fencingToken: first.fencingToken,
          outcome: 'skipped',
        });
        const second = await host.second.startAttempt({ entry, reason: 'miss' });
        expect(second.kind).toBe('leased');
        if (second.kind === 'leased')
          expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
        await expect(
          host.first.uploadArtifact({
            attemptId: first.attemptId,
            fencingToken: first.fencingToken,
            role: 'html',
            contentType: 'text/html',
            bytes: new Uint8Array([1]),
          }),
        ).rejects.toThrow(/lease/u);
        await host.first.retire();
        await host.first.retire();
        await expect(host.second.initialize()).rejects.toThrow(/unavailable/u);
      } finally {
        await host.close();
      }
    }, 30_000);
  });
}
