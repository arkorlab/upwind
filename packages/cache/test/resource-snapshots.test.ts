import { resourceSnapshotTag } from '@stayingupwind/core/cache';
import { describe, expect, it, vi } from 'vitest';

import { advancePreparedCommit } from '../src/scope/commit.ts';
import { resourceSnapshotFailure } from '../src/scope/resource-snapshots.ts';
import {
  head,
  lease,
  publish,
  RESOURCE,
  setData,
  TAG,
  withSnapshotScope,
  retainPublication,
  input,
} from './support/resource-snapshot-fixture.ts';

const witness = (version: number): string => resourceSnapshotTag({ resourceId: RESOURCE, version });

describe('snapshot-aware cache publication', () => {
  it('revalidates retained publication witnesses at the final repair transaction', async () => {
    await withSnapshotScope(async (scope) => {
      head(scope, 1);
      const started = await lease(scope);
      const retained = await retainPublication(scope, started, [TAG, witness(1)]);
      head(scope, 2);
      const result = scope.storage.transactionSync(() =>
        advancePreparedCommit(input(scope), retained),
      );
      const attempt = scope.sql
        .exec<{ status: string }>(
          'SELECT status FROM attempts WHERE attempt_id=?',
          started.attemptId,
        )
        .one();

      expect(result).toMatchObject({ kind: 'completed', value: { kind: 'stale-dependencies' } });
      expect(attempt.status).toBe('superseded');
    });
  });

  it('never promotes an old route snapshot using a resource watermark delivered after the read', async () => {
    await withSnapshotScope(async (scope) => {
      head(scope, 1);
      const initial = await publish(scope, await lease(scope), [TAG, witness(1)]);
      if (initial.kind !== 'published') throw new Error('The first generation must publish.');
      const started = await lease(scope);
      await scope.instance.applyResourceChange(
        {
          scopeId: scope.scopeId,
          resourceId: RESOURCE,
          eventId: 'later',
          version: 2,
          tag: TAG,
          allowedRoutes: ['/items'],
        },
        scope.now + 1,
      );
      const result = await publish(scope, started, [TAG, witness(1)]);
      const attempt = scope.sql
        .exec<{ status: string }>(
          'SELECT status FROM attempts WHERE attempt_id=?',
          started.attemptId,
        )
        .one();
      const entry = scope.sql
        .exec<{ current_generation_id: string; regeneration_attempt_id: string | null }>(
          'SELECT current_generation_id,regeneration_attempt_id FROM entries WHERE entry_id=?',
          started.entryId,
        )
        .one();

      expect(result.kind).toBe('stale-dependencies');
      expect(attempt.status).toBe('superseded');
      expect(entry.current_generation_id).toBe(initial.generationId);
      expect(entry.regeneration_attempt_id).toBeNull();
    });
  });

  it('uses the earliest nested witness even after a parent read obtains a later version', async () => {
    await withSnapshotScope(async (scope) => {
      head(scope, 2);

      expect((await publish(scope, await lease(scope), [TAG, witness(1), witness(2)])).kind).toBe(
        'stale-dependencies',
      );
      expect((await publish(scope, await lease(scope), [TAG, witness(2)])).kind).toBe('published');
    });
  });

  it.each(['missing', 'canonical', 'malformed'] as const)(
    'refuses %s resource proof and releases the route lease',
    async (reason) => {
      await withSnapshotScope(async (scope) => {
        if (reason !== 'missing') head(scope, 2);
        const tags =
          reason === 'malformed'
            ? [TAG, 'upwind:resource-snapshot:v1:broken']
            : [reason === 'canonical' ? 'other' : TAG, witness(2)];
        const started = await lease(scope);
        const result = await publish(scope, started, tags);
        const attempt = scope.sql
          .exec<{ status: string }>(
            'SELECT status FROM attempts WHERE attempt_id=?',
            started.attemptId,
          )
          .one();

        expect(result.kind).toBe('stale-dependencies');
        expect(attempt.status).toBe('superseded');
      });
    },
  );

  it('refuses an old data value with a post-event timestamp without replacing the stored generation', async () => {
    await withSnapshotScope(async (scope) => {
      head(scope, 1);
      const first = await setData(scope, [TAG, witness(1)]);
      if (!('generationId' in first)) throw new Error('The initial data value must publish.');
      head(scope, 2);
      const stale = await setData(scope, [TAG, witness(1)], 'b');
      const entry = scope.sql
        .exec<{ current_generation_id: string }>(
          'SELECT current_generation_id FROM entries WHERE entry_id=?',
          first.entryId,
        )
        .one();

      expect(stale).toMatchObject({ kind: 'refused', code: 'lease_expired' });
      expect(entry.current_generation_id).toBe(first.generationId);
      await expect(setData(scope, [TAG, witness(2)], 'c')).resolves.not.toHaveProperty(
        'kind',
        'refused',
      );
    });
  });

  it('checks unchanged data writes and original child witnesses instead of acknowledging a new watermark', async () => {
    await withSnapshotScope(async (scope) => {
      head(scope, 1);
      await setData(scope, [TAG, witness(1)]);
      head(scope, 2);

      await expect(setData(scope, [TAG, witness(1)])).resolves.toMatchObject({
        kind: 'refused',
        code: 'lease_expired',
      });
      await expect(setData(scope, [TAG, witness(1), witness(2)])).resolves.toMatchObject({
        kind: 'refused',
        code: 'lease_expired',
      });
    });
  });

  it('uses the indexed head lookup and leaves ordinary writes without witness SQL', async () => {
    await withSnapshotScope(async (scope) => {
      head(scope, 1);
      const observed = vi.spyOn(scope.sql, 'exec');
      resourceSnapshotFailure(scope.sql, [TAG]);

      expect(observed).not.toHaveBeenCalled();
      expect(scope.instance.resourceSnapshotCapability()).toBe(1);
      expect(observed).not.toHaveBeenCalled();
      expect(resourceSnapshotFailure(scope.sql, [TAG, witness(1)])).toBeUndefined();

      const call = observed.mock.calls[0]!;
      const query: unknown = call[0];
      const binding: unknown = call[1];
      if (typeof query !== 'string' || typeof binding !== 'string')
        throw new TypeError('The witness query must bind its JSON lookup.');
      observed.mockRestore();
      const plan = scope.sql
        .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, binding)
        .toArray();

      expect(plan.map((row) => row.detail).join('\n')).toMatch(
        /SEARCH h USING INDEX sqlite_autoindex_resource_heads/u,
      );
      expect((await publish(scope, await lease(scope), [TAG])).kind).toBe('published');
      await expect(setData(scope, [TAG])).resolves.not.toHaveProperty('kind', 'refused');
    });
  });
});
