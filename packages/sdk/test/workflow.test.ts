import { afterEach, describe, expect, it } from 'vitest';

import { workflow } from '../src/named.ts';
import { workflowBinding, type CloudflareWorkflowRequest } from '../src/workflow-binding.ts';
import sole from '../src/workflow.ts';

const KEY = Symbol.for('upwind.resources');
const BEFORE = Object.getOwnPropertyDescriptor(globalThis, KEY);

function publish(binding: unknown) {
  Object.defineProperty(globalThis, KEY, {
    configurable: true,
    value: {
      version: 1,
      resources: {
        JOBS: { type: 'workflow', binding },
        DB: { type: 'd1', binding },
      },
    },
  });
}

describe('scoped Cloudflare Workflow access', () => {
  afterEach(() => {
    if (BEFORE === undefined) Reflect.deleteProperty(globalThis, KEY);
    else Object.defineProperty(globalThis, KEY, BEFORE);
  });

  it('does no work during lookup and hydrates native-shaped handles with synchronous IDs', async () => {
    const requests: CloudflareWorkflowRequest[] = [];
    publish({
      invoke: (request: CloudflareWorkflowRequest) => {
        requests.push(request);
        return Promise.resolve(
          request.method === 'status' ? { status: 'waiting' } : { id: 'job-1' },
        );
      },
    });
    const jobs = workflow<{ order: number }>('JOBS');

    expect(jobs).toBeDefined();
    expect(workflow('DB')).toBeUndefined();
    expect(workflow('MISSING')).toBeUndefined();
    expect(requests).toHaveLength(0);

    const run = await jobs!.create({ id: 'job-1', params: { order: 8 } });

    expect(run.id).toBe('job-1');
    await expect(run.status()).resolves.toStrictEqual({ status: 'waiting' });

    await run.pause();
    await run.resume();
    await run.restart();
    await run.sendEvent({ type: 'approved', payload: true });
    await run.terminate();

    expect(requests).toStrictEqual([
      { method: 'create', options: { id: 'job-1', params: { order: 8 } } },
      { method: 'status', id: 'job-1' },
      { method: 'pause', id: 'job-1' },
      { method: 'resume', id: 'job-1' },
      { method: 'restart', id: 'job-1' },
      { method: 'sendEvent', id: 'job-1', options: { type: 'approved', payload: true } },
      { method: 'terminate', id: 'job-1' },
    ]);
  });

  it('uses the same bridge for the sole accessor and ownership-checked get', async () => {
    const requests: CloudflareWorkflowRequest[] = [];
    publish({
      invoke: (request: CloudflareWorkflowRequest) => {
        requests.push(request);
        return Promise.resolve({ id: request.id });
      },
    });
    const run = await sole.get('known');

    expect(run.id).toBe('known');
    expect(requests).toStrictEqual([{ method: 'get', id: 'known' }]);
  });

  it('hydrates legacy batches and preserves partial-success batch metadata', async () => {
    const batch = workflowBinding({
      invoke: () => Promise.resolve([{ id: 'one' }, { id: 'two' }]),
    });

    expect((await batch.createBatch([{}, {}])).map((run) => run.id)).toStrictEqual(['one', 'two']);

    const partial = workflowBinding({
      invoke: () => Promise.resolve({ created: [{ id: 'one' }], errors: ['two failed'] }),
    });

    await expect(partial.createBatch([])).resolves.toMatchObject({
      created: [{ id: 'one' }],
      errors: ['two failed'],
    });
  });

  it('refuses malformed handles and propagates host authorization errors', async () => {
    await expect(workflowBinding({ invoke: () => Promise.resolve({}) }).create()).rejects.toThrow(
      'invalid instance handle',
    );
    await expect(
      workflowBinding({ invoke: () => Promise.resolve({}) }).createBatch([]),
    ).rejects.toThrow('invalid batch');

    const error = new Error('workflow_forbidden');

    await expect(
      workflowBinding({ invoke: () => Promise.reject(error) }).get('foreign'),
    ).rejects.toBe(error);
  });
});
