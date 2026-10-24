import { describe, expect, it } from 'vitest';

import { localEntries } from '../src/resources/local-bindings.ts';
import { failedOwnerNames } from '../src/resources/local-failure.ts';
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

  it('rejects Workflow names shared with another resource instead of shadowing them', () => {
    expect(() => localEntries(['JOBS'], [], ['JOBS'])).toThrow(
      'Cloudflare Workflow binding JOBS conflicts',
    );
    expect(() => localEntries([], [{ name: 'JOBS', type: 'ai' }], ['JOBS'])).toThrow(
      'Cloudflare Workflow binding JOBS conflicts',
    );
  });

  it('identifies only registered native worker service prefixes during startup recovery', () => {
    const error = new Error(
      'service core:user:upwind-workflow-BROKEN: Uncaught Error: upwind-workflow-HEALTHY\nservice core:user:upwind-object-ROOM: Uncaught Error: failed',
    );

    expect([...failedOwnerNames(error, ['BROKEN', 'HEALTHY'], 'workflow')]).toStrictEqual([
      'BROKEN',
    ]);
    expect([...failedOwnerNames(error, ['ROOM'])]).toStrictEqual(['ROOM']);

    const structured = new Error(
      JSON.stringify({ message: 'service core:user:upwind-workflow-BROKEN: bad export' }),
    );

    expect([...failedOwnerNames(structured, ['BROKEN'], 'workflow')]).toStrictEqual(['BROKEN']);
    expect([
      ...failedOwnerNames(
        new Error('Uncaught Error: upwind-workflow-BROKEN'),
        ['BROKEN'],
        'workflow',
      ),
    ]).toStrictEqual([]);
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
      createBatch: () => {
        return Promise.resolve({
          created: [native],
          errors: [{ index: 1, code: 1, message: 'duplicate' }],
        });
      },
    });

    await expect(bridge.invoke({ method: 'create' })).resolves.toStrictEqual({ id: 'local' });
    await expect(bridge.invoke({ method: 'status', id: 'local' })).resolves.toStrictEqual({
      status: 'waiting',
    });

    await bridge.invoke({ method: 'terminate', id: 'local', options: { rollback: true } });

    expect(calls).toStrictEqual([{ rollback: true }]);
    await expect(
      bridge.invoke({ method: 'createBatch', options: { count: 2 } }),
    ).resolves.toStrictEqual({
      created: [{ id: 'local' }],
      errors: [{ index: 1, code: 1, message: 'duplicate' }],
    });
  });
});
