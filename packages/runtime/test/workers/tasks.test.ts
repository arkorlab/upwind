import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { installTaskScheduler, TASK_TIMER } from '../../src/tasks.ts';

/**
 * The scheduler Next.js's prerender tasks run on under workerd: a task runs after every
 * immediate scheduled before it, the ones those scheduled included, and tasks keep their order.
 * Run in the Workers pool, so what is asserted is workerd's ordering, not Node.js's.
 */

describe('the task scheduler', () => {
  it('cancels counted immediates without running their callbacks or retaining pending work', async () => {
    const scheduler = installTaskScheduler();
    const order: string[] = [];
    const cancelled = setImmediate(() => {
      order.push('cancelled');
    });
    clearImmediate(cancelled);
    clearImmediate(cancelled);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(order).toStrictEqual([]);
    expect(scheduler.pendingImmediates()).toBe(0);
  });

  it('runs a task after the immediates scheduled before it, those they scheduled included', async () => {
    const scheduler = installTaskScheduler();
    const order: string[] = [];

    const done = new Promise<void>((resolve) => {
      scheduler.taskTimer(() => {
        order.push('task 1');
        setImmediate(() => {
          order.push('immediate from task 1');
        });
      }, 0);
      scheduler.taskTimer(() => {
        order.push('task 2');
      }, 0);
      scheduler.taskTimer(() => {
        order.push('task 3');
        resolve();
      }, 0);
    });
    setImmediate(() => {
      order.push('immediate 1');
      setImmediate(() => {
        order.push('immediate 1.1');
      });
    });
    await done;

    expect(order).toStrictEqual([
      'immediate 1',
      'immediate 1.1',
      'task 1',
      'immediate from task 1',
      'task 2',
      'task 3',
    ]);
    expect(scheduler.pendingImmediates()).toBe(0);
  });

  it('is installed once, as the global hook the adapter patch calls', () => {
    const scheduler = installTaskScheduler();

    expect(installTaskScheduler()).toBe(scheduler);
    expect(Reflect.get(globalThis, TASK_TIMER)).toBe(scheduler.taskTimer);
  });

  it('skips a cleared task, and reads like a Node.js timer to the group', async () => {
    const scheduler = installTaskScheduler();
    const order: string[] = [];

    const first = scheduler.taskTimer(() => {
      order.push('first');
    }, 0);
    const done = new Promise<void>((resolve) => {
      scheduler.taskTimer(() => {
        order.push('second');
        resolve();
      }, 0);
    });
    clearTimeout(first as unknown as ReturnType<typeof setTimeout>);
    await done;

    expect(first._idleStart).toBe(0);
    expect(order).toStrictEqual(['second']);
  });

  it('gives an immediate a promise form, counted like any other immediate', async () => {
    const scheduler = installTaskScheduler();
    const order: string[] = [];
    const immediate = promisify(setImmediate);

    const promised = (async () => {
      order.push(`immediate: ${await immediate('value')}`);
    })();
    const done = new Promise<void>((resolve) => {
      scheduler.taskTimer(() => {
        order.push('task');
        resolve();
      }, 0);
    });
    await Promise.all([promised, done]);

    expect(order).toStrictEqual(['immediate: value', 'task']);
    expect(scheduler.pendingImmediates()).toBe(0);
  });

  it('refuses a promised immediate once its signal aborts, and leaves nothing for a task to wait on', async () => {
    const scheduler = installTaskScheduler();
    const immediate = promisify(setImmediate);
    const before = new AbortController();
    before.abort('early');
    const during = new AbortController();

    const refused = immediate('value', { signal: during.signal });
    during.abort('late');

    await expect(immediate('value', { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
      cause: 'early',
    });
    await expect(refused).rejects.toMatchObject({ name: 'AbortError', cause: 'late' });
    expect(scheduler.pendingImmediates()).toBe(0);
  });
});
