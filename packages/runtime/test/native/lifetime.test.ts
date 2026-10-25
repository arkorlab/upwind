/* eslint-disable @typescript-eslint/require-await -- Next.js handler fixtures retain their async contract when completing synchronously. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, it } from 'vitest';

import { TaskGroup } from '../../src/native/lifetime.ts';

describe('native task lifetime', () => {
  it('drains nested work rather than only the initial snapshot', async () => {
    const group = new TaskGroup(() => assert.fail('unexpected rejection'));
    let nested = false;
    async function completeNested(): Promise<void> {
      await delay(15);
      nested = true;
    }
    async function completeOuter(): Promise<void> {
      await delay(5);
      group.waitUntil(completeNested());
    }
    group.waitUntil(completeOuter());
    assert.equal(await group.drain(1000), true);
    assert.equal(nested, true);
    assert.equal(group.size, 0);
  });

  it('reports rejecting tasks and contains a failing reporter', async () => {
    let reported = 0;
    const group = new TaskGroup(() => {
      reported += 1;
      throw new Error('report failed');
    });
    group.waitUntil(Promise.reject(new Error('task failed')));
    assert.equal(await group.drain(1000), true);
    assert.equal(reported, 1);
    assert.equal(group.size, 0);
  });

  it('reports expired drain without pretending to cancel application work', async () => {
    const group = new TaskGroup(() => {
      /* No host task/reporting action is needed by this fixture. */
    });
    const { promise, resolve } = Promise.withResolvers<undefined>();
    group.waitUntil(promise);
    assert.equal(await group.drain(10), false);
    assert.equal(group.size, 1);
    resolve(undefined);
    assert.equal(await group.drain(1000), true);
  });

  it('validates the deadline and drains an empty group immediately', async () => {
    const group = new TaskGroup(() => {
      /* No host task/reporting action is needed by this fixture. */
    });
    assert.equal(await group.drain(0), true);
    await assert.rejects(group.drain(-1), RangeError);
    await assert.rejects(group.drain(Infinity), RangeError);
  });

  it('contains a reporter returning a rejecting promise', async () => {
    const group = new TaskGroup(async () => {
      throw new Error('async reporter failed');
    });
    group.waitUntil(Promise.reject(new Error('task failed')));
    assert.equal(await group.drain(1000), true);
    await delay(10);
  });

  it('does not make a pending error reporter part of the task lifetime', async () => {
    const report = Promise.withResolvers<undefined>();
    const group = new TaskGroup(() => report.promise);
    group.waitUntil(Promise.reject(new Error('task failed')));
    assert.equal(await group.drain(100), true);
    assert.equal(group.size, 0);
    report.resolve(undefined);
  });
});
