import {
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  type EdgePointer,
} from '@stayingupwind/host/delivery';
import { KV_DEFAULT_POLICY_KEY, kvPolicyKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { getPolicy, getPolicyForPointer } from '../src/preview/manifest.ts';
import { servePointerRequest } from '../src/preview/pointer-request.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation } from './helpers/site.ts';

const READ_MS = 2000;
const POLICY: DeliveryPolicy = { ...DEFAULT_DELIVERY_POLICY, id: 'cold-policy' };
const FALLBACK: DeliveryPolicy = { ...DEFAULT_DELIVERY_POLICY, id: 'fallback-policy' };
const POINTER: EdgePointer = {
  v: 1,
  projectId: 'site',
  originHost: 'site.example',
  mode: 'edge',
  policyId: POLICY.id,
  updatedAt: '2026-10-18T00:00:00.000Z',
};

function setup(held = false) {
  const get = vi.fn<(key: string) => Promise<unknown>>(() => Promise.resolve(POLICY));
  const bindings: EdgeBindings = { ...env, EDGE_STATE: { get } as unknown as KVNamespace };
  const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) });
  if (held) runtime.memory.policies.set(POLICY.id, POLICY);
  return { get, bindings, runtime };
}

describe('a cold policy read has a storage deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['policy', 'default pointer', 'default policy'] as const)(
    'stops waiting for a stalled %s without holding its absence',
    async (target) => {
      const test = setup();
      const pending = Promise.withResolvers<unknown>();
      const targetKey = {
        policy: kvPolicyKey(POLICY.id),
        'default pointer': KV_DEFAULT_POLICY_KEY,
        'default policy': kvPolicyKey(FALLBACK.id),
      }[target];

      test.get.mockImplementation((key) => {
        if (key === targetKey) return pending.promise;
        if (key === KV_DEFAULT_POLICY_KEY) return Promise.resolve({ policyId: FALLBACK.id });
        return Promise.resolve(key === kvPolicyKey(FALLBACK.id) ? FALLBACK : null);
      });

      vi.spyOn(console, 'warn').mockReturnValue();

      vi.useFakeTimers();
      let result: Awaited<ReturnType<typeof getPolicy>> | undefined;
      const observed = (async () => {
        result = await getPolicy(test.bindings, test.runtime, POLICY.id);
      })();
      try {
        await vi.advanceTimersByTimeAsync(READ_MS + 1);

        expect(result?.kind).toBe('unavailable');
        expect(test.runtime.memory.policies.peek(POLICY.id)).toBeUndefined();
        expect(test.runtime.memory.policyStandIns.peek(POLICY.id)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);

        const reads = test.get.mock.calls.length;
        pending.resolve(target === 'default pointer' ? { policyId: FALLBACK.id } : FALLBACK);
        await vi.advanceTimersByTimeAsync(0);

        expect(test.get).toHaveBeenCalledTimes(reads);
        expect(test.runtime.memory.policies.peek(POLICY.id)).toBeUndefined();
        expect(test.runtime.memory.policyStandIns.peek(POLICY.id)).toBeUndefined();
      } finally {
        pending.resolve(null);
        await observed;
      }
    },
  );

  it.each(['found', 'rejected'] as const)(
    'consumes a late %s policy without adopting it, then retries',
    async (late) => {
      const test = setup();
      const pending = Promise.withResolvers<unknown>();

      test.get.mockReturnValue(pending.promise);

      vi.spyOn(console, 'warn').mockReturnValue();

      vi.useFakeTimers();
      let result: Awaited<ReturnType<typeof getPolicy>> | undefined;
      const observed = (async () => {
        result = await getPolicyForPointer(test.bindings, test.runtime, POINTER);
      })();
      try {
        await vi.advanceTimersByTimeAsync(READ_MS + 1);

        expect(result?.kind).toBe('unavailable');

        if (late === 'found') pending.resolve(POLICY);
        else pending.reject(new Error('late policy failure'));
        await vi.advanceTimersByTimeAsync(0);

        expect(test.runtime.memory.policies.peek(POLICY.id)).toBeUndefined();
        expect(test.runtime.memory.policyStandIns.peek(POLICY.id)).toBeUndefined();

        test.get.mockResolvedValue(POLICY);

        await expect(
          getPolicyForPointer(test.bindings, test.runtime, POINTER),
        ).resolves.toMatchObject({
          kind: 'found',
          policy: POLICY,
          source: 'exact',
        });
        expect(test.get).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        pending.resolve(POLICY);
        await observed;
      }
    },
  );

  it.each(['selected', 'held'] as const)(
    'keeps the %s policy free of KV reads and timers',
    async (kind) => {
      const test = setup(kind === 'held');

      const pointer = kind === 'selected' ? { ...POINTER, selectedPolicy: POLICY } : POINTER;
      vi.useFakeTimers();

      await expect(
        getPolicyForPointer(test.bindings, test.runtime, pointer),
      ).resolves.toMatchObject({
        kind: 'found',
        policy: POLICY,
        source: 'exact',
      });
      expect(test.get).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['exact', 'default-pointer', 'builtin'] as const)(
    'preserves a successful %s policy resolution and clears its timers',
    async (source) => {
      const test = setup();
      const policyId = source === 'builtin' ? DEFAULT_DELIVERY_POLICY.id : POLICY.id;
      const expected = {
        exact: POLICY,
        'default-pointer': FALLBACK,
        builtin: DEFAULT_DELIVERY_POLICY,
      }[source];

      test.get.mockImplementation((key) => {
        if (source === 'exact') return Promise.resolve(POLICY);
        if (key === KV_DEFAULT_POLICY_KEY) return Promise.resolve({ policyId: FALLBACK.id });
        return Promise.resolve(key === kvPolicyKey(FALLBACK.id) ? FALLBACK : null);
      });

      vi.spyOn(console, 'warn').mockReturnValue();

      vi.useFakeTimers();

      await expect(getPolicy(test.bindings, test.runtime, policyId)).resolves.toMatchObject({
        kind: 'found',
        policy: expected,
        source,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('lets a legacy pointer prerequisite use the existing safe policy after a KV timeout', async () => {
    const test = setup();
    const pending = Promise.withResolvers<unknown>();

    test.get.mockReturnValue(pending.promise);

    const ctx = createExecutionContext();
    const request = navigation('/');

    vi.spyOn(console, 'warn').mockReturnValue();

    vi.useFakeTimers();
    let answered = false;
    const response = (async () => {
      const value = await servePointerRequest(
        {
          request,
          url: new URL(request.url),
          env: test.bindings,
          runtime: test.runtime,
          ctx,
          host: standaloneHost(env),
          pointer: POINTER,
          pointerMs: 0,
          privateDelivery: false,
          cspReportingPath: undefined,
        },
        async (routing) => {
          if (!('policyReady' in routing)) throw new Error('deferred policy expected');

          const ready = await routing.policyReady();
          return new Response(
            `${ready.state.policy.assets.backend}/${ready.state.policy.runtimeCache?.generations}`,
          );
        },
      );
      answered = true;
      return value;
    })();
    try {
      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      expect(answered).toBe(true);

      const value = await response;

      await expect(value.text()).resolves.toBe('passthrough/off');
      expect(test.runtime.memory.policies.peek(POLICY.id)).toBeUndefined();
    } finally {
      pending.resolve(POLICY);
      const value = await response;
      if (!value.bodyUsed) await value.body?.cancel();
      await waitOnExecutionContext(ctx);
    }
  });

  it('gives each sequential stand-in read its own budget instead of claiming a total two seconds', async () => {
    const test = setup();
    const direct = Promise.withResolvers<unknown>();
    const pointer = Promise.withResolvers<unknown>();
    const fallback = Promise.withResolvers<unknown>();

    test.get.mockImplementation((key) => {
      if (key === kvPolicyKey(POLICY.id)) return direct.promise;
      return key === KV_DEFAULT_POLICY_KEY ? pointer.promise : fallback.promise;
    });

    vi.spyOn(console, 'warn').mockReturnValue();

    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof getPolicy>> | undefined;
    const observed = (async () => {
      result = await getPolicy(test.bindings, test.runtime, POLICY.id);
    })();
    try {
      await vi.advanceTimersByTimeAsync(READ_MS - 1);
      direct.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(READ_MS - 1);
      pointer.resolve({ policyId: FALLBACK.id });
      await vi.advanceTimersByTimeAsync(0);

      expect(test.get).toHaveBeenCalledTimes(3);
      expect(result).toBeUndefined();

      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      expect(result?.kind).toBe('unavailable');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      direct.resolve(null);
      pointer.resolve(null);
      fallback.resolve(null);
      await observed;
    }
  });
});
