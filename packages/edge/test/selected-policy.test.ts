import {
  builtinDeliveryPolicies,
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  deliveryPolicySchema,
  type EdgePointer,
  edgePointerSchema,
} from '@stayingupwind/host/delivery';
import { kvPolicyKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { getPolicy, getPolicyForPointer } from '../src/preview/manifest.ts';
import { startReads } from '../src/preview/pointer-request.ts';
import { createPointerReader } from '../src/preview/pointer.ts';
import { standaloneRuntime } from '../src/standalone/index.ts';

const POLICY: DeliveryPolicy = { ...DEFAULT_DELIVERY_POLICY, id: 'selected-policy' };
const POINTER: EdgePointer = {
  v: 1,
  projectId: 'site',
  originHost: 'site.example',
  mode: 'edge',
  policyId: POLICY.id,
  updatedAt: '2026-10-18T00:00:00.000Z',
};

/** A real runtime with each policy read observable, without changing the ambient binding. */
function setup() {
  const get = vi.fn<(key: string) => Promise<unknown>>(() => Promise.resolve(POLICY));
  const bindings: EdgeBindings = {
    ...env,
    EDGE_STATE: { get } as unknown as KVNamespace,
  };
  const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) });
  return { get, bindings, runtime };
}

describe('the immutable policy copied into a pointer', () => {
  it.each(builtinDeliveryPolicies())(
    'selects $id without a snapshot parse, copy or KV read',
    async (policy) => {
      const { get, bindings, runtime } = setup();
      const pointer = { ...POINTER, policyId: policy.id, selectedPolicy: 'builtin' };
      const parse = vi.spyOn(deliveryPolicySchema, 'safeParse');
      try {
        const read = await getPolicyForPointer(bindings, runtime, pointer);

        expect(read.kind === 'found' ? read.policy : undefined).toBe(policy);
        expect(get).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
        expect(runtime.memory.policies.peek(policy.id)).toBeUndefined();
      } finally {
        parse.mockRestore();
      }
    },
  );

  it('answers a cold lookup without KV and leaves the shared policy cache untouched', async () => {
    const { get, bindings, runtime } = setup();
    const chosen = { ...POLICY, middleware: { cpuMs: 11, subRequests: 2, timeoutMs: 900 } };
    const pointer = edgePointerSchema.parse({ ...POINTER, selectedPolicy: chosen });

    await expect(getPolicyForPointer(bindings, runtime, pointer)).resolves.toStrictEqual({
      kind: 'found',
      source: 'exact',
      policy: chosen,
    });
    expect(get).not.toHaveBeenCalled();
    expect(runtime.memory.policies.peek(POLICY.id)).toBeUndefined();

    // A validation or an unrelated legacy pointer still resolves its own document for that id.
    await expect(getPolicy(bindings, runtime, POLICY.id)).resolves.toMatchObject({
      policy: POLICY,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(kvPolicyKey(POLICY.id), {
      type: 'json',
      cacheTtl: 60,
    });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['incomplete', {}],
    ['malformed', { ...POLICY, middleware: { cpuMs: -1 } }],
    ['another id', { ...POLICY, id: 'another-policy' }],
    ['unknown built-in', 'builtin'],
  ])(
    'keeps a pointer with an %s hint readable and resolves its policy as before',
    async (_, hint) => {
      const { get, bindings, runtime } = setup();
      const pointer = edgePointerSchema.parse({ ...POINTER, selectedPolicy: hint });

      await expect(getPolicyForPointer(bindings, runtime, pointer)).resolves.toStrictEqual({
        kind: 'found',
        source: 'exact',
        policy: POLICY,
      });
      expect(get).toHaveBeenCalledExactlyOnceWith(kvPolicyKey(POLICY.id), {
        type: 'json',
        cacheTtl: 60,
      });
    },
  );

  it('uses the snapshot in the live request’s prerequisite reads', async () => {
    const { get, bindings, runtime } = setup();
    const ctx = createExecutionContext();
    const reads = startReads({
      env: bindings,
      runtime,
      ctx,
      pointer: { ...POINTER, selectedPolicy: POLICY },
    });

    await expect(reads.policyLookup).resolves.toMatchObject({ policy: POLICY, source: 'exact' });
    await expect(reads.manifestLookup).resolves.toStrictEqual({ kind: 'missing' });
    expect(get).not.toHaveBeenCalled();

    await waitOnExecutionContext(ctx);
  });

  it.each([
    ['valid', POLICY],
    ['malformed', {}],
  ])('validates a %s snapshot only once when its pointer is reused', async (_, hint) => {
    const { bindings, runtime } = setup();
    const pointer = { ...POINTER, selectedPolicy: hint };
    const parse = vi.spyOn(deliveryPolicySchema, 'safeParse');
    try {
      await getPolicyForPointer(bindings, runtime, pointer);
      await getPolicyForPointer(bindings, runtime, pointer);

      expect(parse.mock.calls.filter(([input]) => input === hint)).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('refreshes a live pointer without reading ahead a policy it already carries', async () => {
    const { get, bindings } = setup();
    const clock = { now: Date.now() };
    const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => clock.now) });
    const reader = createPointerReader<EdgePointer, never>({
      parse: (raw) => {
        const parsed = edgePointerSchema.safeParse(raw);
        return parsed.success ? parsed.data : undefined;
      },
    });
    const key = 'pointer:selected-policy';
    get.mockResolvedValue({ ...POINTER, selectedPolicy: POLICY });
    const kept: Promise<void>[] = [];
    const live = {
      holdRefresh: (work: Promise<void>): void => {
        kept.push(work);
      },
    };
    await reader.get(bindings, runtime, key, live);
    clock.now += 10_001;

    await reader.get(bindings, runtime, key, live);
    await Promise.all(kept);

    expect(get.mock.calls.map(([read]) => read)).toStrictEqual([key, key]);
  });
});
