import { describe, expect, it } from 'vitest';

import { localEntries } from '../src/resources/local-bindings.ts';
import { localWorkflowBridge } from '../src/resources/local-workflows.ts';

describe('local Workflow bridge', () => {
  it('keeps default persistence identities while reserving Workflow names', () => {
    const entries = localEntries([], [], ['UPWIND_KV']);
    expect(entries.filter((entry) => entry.name === 'UPWIND_KV')).toStrictEqual([
      { name: 'UPWIND_KV', type: 'workflow' },
    ]);
    expect(entries.find((entry) => entry.type === 'kv_namespace')).toMatchObject({
      storageName: 'UPWIND_KV',
    });
  });

  it('forwards operations and preserves structured batch errors', async () => {
    const calls: unknown[] = [];
    const native = {
      id: 'local',
      status: () => Promise.resolve({ status: 'waiting' }),
      terminate: (options: unknown) => {
        calls.push(options);
        return Promise.resolve();
      },
    };
    const bridge = localWorkflowBridge({
      create: () => Promise.resolve(native),
      get: () => Promise.resolve(native),
      createBatch: () =>
        Promise.resolve({
          created: [native],
          errors: [{ index: 1, code: 1, message: 'duplicate' }],
        }),
    });
    expect(await bridge.invoke({ method: 'create' })).toStrictEqual({ id: 'local' });
    expect(await bridge.invoke({ method: 'status', id: 'local' })).toStrictEqual({
      status: 'waiting',
    });
    await bridge.invoke({ method: 'terminate', id: 'local', options: { rollback: true } });
    expect(calls).toStrictEqual([{ rollback: true }]);
    expect(await bridge.invoke({ method: 'createBatch', options: { count: 2 } })).toStrictEqual({
      created: [{ id: 'local' }],
      errors: [{ index: 1, code: 1, message: 'duplicate' }],
    });
  });
});
