import { kvGenerationKey } from '@stayingupwind/core/cache';
import type { ScopeSignals } from '@stayingupwind/host/cache';
import { describe, expect, it, vi } from 'vitest';

import { watchedCacheSignals } from '../src/workers/watched-records.ts';

describe('records read through the local authority binding', () => {
  it('observes the actual authority answer under the same key as a KV read', async () => {
    const answer = new Uint8Array([1, 2, 3]).buffer;
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const currentRecord = vi.fn(() => gate.promise);
    const source = { scopeSignals: vi.fn(), currentRecord };
    const observed = vi.fn();
    const watched = watchedCacheSignals(source, observed);
    const reading = watched?.currentRecord?.('dpl_scope', 'ent_page', 1);

    expect(observed).not.toHaveBeenCalled();

    gate.resolve(answer);

    await expect(reading).resolves.toBe(answer);
    expect(currentRecord).toHaveBeenCalledWith('dpl_scope', 'ent_page', 1);
    expect(currentRecord.mock.contexts).toStrictEqual([source]);
    expect(observed).toHaveBeenCalledExactlyOnceWith(
      kvGenerationKey('dpl_scope', 'ent_page'),
      answer,
    );
  });

  it('does not invent an observation for an absent authority record', async () => {
    const source = {
      scopeSignals: vi.fn(),
      currentRecord: vi.fn(() => Promise.resolve(undefined)),
    };
    const observed = vi.fn();
    const watched = watchedCacheSignals(source, observed);

    await expect(watched?.currentRecord?.('dpl_scope', 'ent_page', 1)).resolves.toBeUndefined();
    expect(observed).not.toHaveBeenCalled();
  });

  it('preserves a failed authority read without adding a read witness', async () => {
    const failure = new Error('authority unavailable');
    const source = { scopeSignals: vi.fn(), currentRecord: vi.fn(() => Promise.reject(failure)) };
    const observed = vi.fn();
    const watched = watchedCacheSignals(source, observed);

    await expect(watched?.currentRecord?.('dpl_scope', 'ent_page', 1)).rejects.toBe(failure);
    expect(observed).not.toHaveBeenCalled();
  });

  it('keeps scope-signal receivers and older bindings unchanged', async () => {
    const answer: ScopeSignals = {
      revision: 3,
      invalidatedAt: null,
      tags: [],
      truncated: false,
      announced: false,
    };
    const source = {
      scopeSignals: vi.fn(() => Promise.resolve(answer)),
      currentRecord: vi.fn(() => Promise.resolve(undefined)),
    };
    const observed = vi.fn();
    const watched = watchedCacheSignals(source, observed);

    await expect(watched?.scopeSignals('dpl_scope', null)).resolves.toBe(answer);

    const older = { scopeSignals: vi.fn() };

    expect(source.scopeSignals.mock.contexts).toStrictEqual([source]);
    expect(watchedCacheSignals(older, observed)).toBe(older);
    expect(watchedCacheSignals(undefined, observed)).toBeUndefined();
    expect(observed).not.toHaveBeenCalled();
  });
});
