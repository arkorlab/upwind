import { type EdgePointer, edgePointerSchema } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { createPointerReader, pointerReadsOut } from '../src/preview/pointer.ts';
import type { Lookup } from '../src/preview/storage.ts';
import { handleStandalone, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation } from './helpers/site.ts';

const READ_MS = 2000;
const PAST_TTL_MS = 10_001;
const KEY = 'pointer:deadline';
const POINTER: EdgePointer = {
  v: 1,
  projectId: 'site',
  originHost: 'site.example',
  mode: 'passthrough',
  policyId: 'site-policy',
  updatedAt: '2026-10-18T00:00:00.000Z',
};
const NEWER: EdgePointer = { ...POINTER, projectId: 'newer-site' };

function setup() {
  const get = vi.fn<(key: string) => Promise<unknown>>().mockResolvedValue(POINTER);
  const bindings = { ...env, POINTER_KEY: KEY, EDGE_STATE: { get } as unknown as KVNamespace };
  const runtime = standaloneRuntime(bindings, { memory: createEdgeMemory(() => Date.now()) });
  const parse = vi.fn((raw: unknown): EdgePointer | undefined => {
    const parsed = edgePointerSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  });
  const reader = createPointerReader<EdgePointer, never>({ parse });
  return { get, bindings, runtime, parse, reader };
}

function finishLate(
  pending: ReturnType<typeof Promise.withResolvers<unknown>>,
  outcome: 'found' | 'missing' | 'rejected',
): void {
  switch (outcome) {
    case 'found': {
      pending.resolve(POINTER);
      break;
    }
    case 'missing': {
      pending.resolve(null);
      break;
    }
    case 'rejected': {
      pending.reject(new Error('late pointer failure'));
      break;
    }
  }
}

describe('a pointer read has its own KV deadline', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockReturnValue();

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers a stalled standalone POINTER_KEY request with 503 instead of hanging', async () => {
    const test = setup();
    const pending = Promise.withResolvers<unknown>();

    test.get.mockReturnValue(pending.promise);

    const ctx = createExecutionContext();
    let response: Response | undefined;
    const handled = (async () => {
      response = await handleStandalone(navigation('/'), test.bindings, ctx, test.runtime);
    })();
    try {
      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      expect(response?.status).toBe(503);
      expect(response?.headers.get('x-arkor-edge')).toBe('error;reason=pointer-unavailable');
      expect(test.runtime.memory.pointers.peek(KEY)).toBeUndefined();
      expect(test.runtime.memory.absentPointers.get(KEY)).toBeUndefined();
      expect(pointerReadsOut(test.runtime, KEY)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve(null);
      await handled;
      await response?.body?.cancel();
      await waitOnExecutionContext(ctx);
    }
  });

  it('keeps a fresh held pointer free of KV reads, parsing and timers', async () => {
    const test = setup();
    test.runtime.memory.pointers.set(KEY, { pointer: POINTER, readAt: Date.now() });

    await expect(test.reader.get(test.bindings, test.runtime, KEY)).resolves.toStrictEqual({
      kind: 'found',
      value: POINTER,
    });
    expect(test.get).not.toHaveBeenCalled();
    expect(test.parse).not.toHaveBeenCalled();
    expect(pointerReadsOut(test.runtime, KEY)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: 'valid', raw: POINTER, kind: 'found', held: POINTER, absent: undefined },
    { name: 'missing', raw: null, kind: 'missing', held: undefined, absent: true },
    { name: 'malformed', raw: { v: 1 }, kind: 'missing', held: undefined, absent: true },
  ])('preserves the immediate $name pointer result and clears its timer', async (sample) => {
    const test = setup();

    test.get.mockResolvedValue(sample.raw);

    const read = await test.reader.get(test.bindings, test.runtime, KEY);

    expect(read.kind).toBe(sample.kind);
    expect(test.runtime.memory.pointers.peek(KEY)?.value.pointer).toStrictEqual(sample.held);
    expect(test.runtime.memory.absentPointers.get(KEY)).toBe(sample.absent);
    expect(pointerReadsOut(test.runtime, KEY)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['found', 'missing', 'rejected'] as const)(
    'consumes a late %s outcome without parsing or replacing a newer held pointer',
    async (outcome) => {
      const test = setup();
      const pending = Promise.withResolvers<unknown>();

      test.get.mockReturnValueOnce(pending.promise);

      let read: Lookup<EdgePointer> | undefined;
      const observed = (async () => {
        read = await test.reader.get(test.bindings, test.runtime, KEY);
      })();
      try {
        await vi.advanceTimersByTimeAsync(READ_MS + 1);

        expect(read?.kind).toBe('unavailable');
        expect(pointerReadsOut(test.runtime, KEY)).toBe(0);

        test.get.mockResolvedValue(NEWER);

        await expect(test.reader.get(test.bindings, test.runtime, KEY)).resolves.toStrictEqual({
          kind: 'found',
          value: NEWER,
        });

        finishLate(pending, outcome);
        await vi.advanceTimersByTimeAsync(0);

        expect(test.runtime.memory.pointers.peek(KEY)?.value.pointer).toStrictEqual(NEWER);
        expect(test.runtime.memory.absentPointers.get(KEY)).toBeUndefined();
        expect(test.parse).toHaveBeenCalledExactlyOnceWith(NEWER);
        expect(pointerReadsOut(test.runtime, KEY)).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        pending.resolve(null);
        await observed;
      }
    },
  );

  it('does not let an expired owner remove the retry still waiting on its own KV read', async () => {
    const test = setup();
    const old = Promise.withResolvers<unknown>();
    const fresh = Promise.withResolvers<unknown>();

    test.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);

    let read: Lookup<EdgePointer> | undefined;
    let retry: Promise<Lookup<EdgePointer>> | undefined;
    const observed = (async () => {
      read = await test.reader.get(test.bindings, test.runtime, KEY);
    })();
    try {
      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      expect(read?.kind).toBe('unavailable');

      retry = test.reader.get(test.bindings, test.runtime, KEY);
      old.resolve(POINTER);
      await vi.advanceTimersByTimeAsync(0);

      expect(pointerReadsOut(test.runtime, KEY)).toBe(1);
      expect(test.runtime.memory.pointers.peek(KEY)).toBeUndefined();
      expect(test.parse).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      fresh.resolve(NEWER);

      await expect(retry).resolves.toStrictEqual({ kind: 'found', value: NEWER });
      expect(test.runtime.memory.pointers.peek(KEY)?.value.pointer).toStrictEqual(NEWER);
      expect(pointerReadsOut(test.runtime, KEY)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      old.resolve(null);
      fresh.resolve(null);
      await observed;
      await retry;
    }
  });

  it('keeps serving a stale pointer when its background refresh times out', async () => {
    const test = setup();
    const pending = Promise.withResolvers<unknown>();
    test.runtime.memory.pointers.set(KEY, { pointer: POINTER, readAt: Date.now() });

    test.get.mockReturnValue(pending.promise);

    await vi.advanceTimersByTimeAsync(PAST_TTL_MS);
    const kept: Promise<void>[] = [];
    const read = test.reader.get(test.bindings, test.runtime, KEY, {
      holdRefresh: (work) => {
        kept.push(work);
      },
    });
    try {
      await expect(read).resolves.toStrictEqual({ kind: 'found', value: POINTER });
      expect(pointerReadsOut(test.runtime, KEY)).toBe(1);

      await vi.advanceTimersByTimeAsync(READ_MS + 1);
      await Promise.all(kept);

      expect(test.runtime.memory.pointers.peek(KEY)?.value.pointer).toStrictEqual(POINTER);
      expect(test.runtime.memory.absentPointers.get(KEY)).toBeUndefined();
      expect(pointerReadsOut(test.runtime, KEY)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve(null);
      await Promise.all(kept);
    }
  });
});
