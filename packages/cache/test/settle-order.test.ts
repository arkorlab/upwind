import { describe, expect, it, vi } from 'vitest';

import { chainSettlePhases } from '../src/scope/settle-schedule.ts';

const IDLE = { projected: Promise.resolve(), done: Promise.resolve() };

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function deferred() {
  return Promise.withResolvers<undefined>();
}

/** Observe an unfinished phase without starting a wall-clock wait. */
function watched(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise
    .finally(() => {
      state.settled = true;
    })
    .catch(() => {
      // This observer also records rejection; the caller checks its outcome separately.
    });
  return state;
}

async function observedResult(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
  }
}

describe('ordered projection and history phases', () => {
  it('projects and acknowledges the next change while earlier history is blocked', async () => {
    const history = deferred();
    const historyStarted = deferred();
    const events: string[] = [];
    const first = chainSettlePhases(
      IDLE,
      logger(),
      () => {
        events.push('project first');
        return Promise.resolve({ early: true });
      },
      async () => {
        events.push('history first');
        historyStarted.resolve(undefined);
        await history.promise;
        events.push('finish first');
      },
    );
    await historyStarted.promise;
    const nextHistory = vi.fn(() => Promise.resolve());
    const next = chainSettlePhases(
      first,
      logger(),
      () => {
        events.push('project next');
        return Promise.resolve({ early: true });
      },
      nextHistory,
    );
    const firstDone = watched(first.done);
    const nextDone = watched(next.done);

    try {
      await next.answered;

      expect(events).toStrictEqual(['project first', 'history first', 'project next']);
      expect(nextHistory).not.toHaveBeenCalled();
      expect(firstDone.settled).toBe(false);
      expect(nextDone.settled).toBe(false);
    } finally {
      history.resolve(undefined);
      await next.done;
    }

    expect(events).toStrictEqual([
      'project first',
      'history first',
      'project next',
      'finish first',
    ]);
    expect(nextHistory).toHaveBeenCalledExactlyOnceWith({ early: true });
  });

  it('does not use an AT_ONCE acknowledgment to start a later projection', async () => {
    const projection = deferred();
    const began = deferred();
    const first = chainSettlePhases(
      IDLE,
      logger(),
      async () => {
        began.resolve(undefined);
        await projection.promise;
        return { early: true };
      },
      () => Promise.resolve(),
    );
    first.answerNow();
    await first.answered;
    await began.promise;
    const nextProjection = vi.fn(() => Promise.resolve({ early: true }));
    const next = chainSettlePhases(first, logger(), nextProjection, () => Promise.resolve());
    const projected = watched(first.projected);

    try {
      await microtasks();

      expect(projected.settled).toBe(false);
      expect(nextProjection).not.toHaveBeenCalled();
    } finally {
      projection.resolve(undefined);
      await next.done;
    }

    expect(nextProjection).toHaveBeenCalledExactlyOnceWith();
  });

  it('keeps a change without early publication waiting for its own finish', async () => {
    const finish = deferred();
    const began = deferred();
    const first = chainSettlePhases(
      IDLE,
      logger(),
      () => Promise.resolve({ early: false }),
      async () => {
        began.resolve(undefined);
        await finish.promise;
      },
    );
    await began.promise;
    const answer = watched(first.answered);
    const next = chainSettlePhases(
      first,
      logger(),
      () => Promise.resolve({ early: true }),
      () => Promise.resolve(),
    );

    try {
      await next.answered;

      expect(answer.settled).toBe(false);
    } finally {
      finish.resolve(undefined);
      await next.done;
    }

    await expect(first.answered).resolves.toBeUndefined();
  });

  it('orders history and retry completion while the full drain waits for both', async () => {
    const history = deferred();
    const alarm = deferred();
    const historyStarted = deferred();
    const alarmStarted = deferred();
    const events: string[] = [];
    const first = chainSettlePhases(
      IDLE,
      logger(),
      () => Promise.resolve({ early: true }),
      async () => {
        events.push('history first');
        historyStarted.resolve(undefined);
        await history.promise;
        events.push('retry first');
        alarmStarted.resolve(undefined);
        await alarm.promise;
        events.push('finished first');
      },
    );
    await historyStarted.promise;
    const next = chainSettlePhases(
      first,
      logger(),
      () => Promise.resolve({ early: true }),
      () => {
        events.push('history next');
        return Promise.resolve();
      },
    );
    const drain = watched(next.done);

    try {
      await next.answered;

      expect(drain.settled).toBe(false);

      history.resolve(undefined);
      await alarmStarted.promise;
      await microtasks();

      expect(events).toStrictEqual(['history first', 'retry first']);
      expect(drain.settled).toBe(false);
    } finally {
      history.resolve(undefined);
      alarm.resolve(undefined);
      await next.done;
    }

    expect(events).toStrictEqual([
      'history first',
      'retry first',
      'finished first',
      'history next',
    ]);
  });

  it('continues after a projection rejects and reports that change as failed', async () => {
    const fault = new Error('record projection failed');
    const log = logger();
    const firstHistory = vi.fn(() => Promise.resolve());
    const first = chainSettlePhases(IDLE, log, () => Promise.reject(fault), firstHistory);
    const answered = observedResult(first.answered);
    const done = observedResult(first.done);
    const nextHistory = vi.fn(() => Promise.resolve());
    const next = chainSettlePhases(first, log, () => Promise.resolve({ early: true }), nextHistory);

    await expect(next.answered).resolves.toBeUndefined();

    await next.done;

    await expect(answered).resolves.toBe(fault);
    await expect(done).resolves.toBe(fault);

    expect(firstHistory).not.toHaveBeenCalled();
    expect(nextHistory).toHaveBeenCalledExactlyOnceWith({ early: true });
    expect(log.warn).toHaveBeenCalledWith('previous settle interrupted', { detail: fault.message });
  });

  it('continues after earlier history or retry scheduling rejects', async () => {
    const finishing = deferred();
    const started = deferred();
    const fault = new Error('retry alarm refused');
    const log = logger();
    const first = chainSettlePhases(
      IDLE,
      log,
      () => Promise.resolve({ early: true }),
      async () => {
        started.resolve(undefined);
        await finishing.promise;
        throw fault;
      },
    );
    const done = observedResult(first.done);
    await started.promise;
    const nextHistory = vi.fn(() => Promise.resolve());
    const next = chainSettlePhases(first, log, () => Promise.resolve({ early: true }), nextHistory);

    await next.answered;

    expect(nextHistory).not.toHaveBeenCalled();

    finishing.resolve(undefined);
    await next.done;

    await expect(done).resolves.toBe(fault);

    await expect(first.answered).resolves.toBeUndefined();
    expect(nextHistory).toHaveBeenCalledExactlyOnceWith({ early: true });
    expect(log.error).toHaveBeenCalledWith('settle failed after the answer', {
      detail: fault.message,
    });
    expect(log.warn).toHaveBeenCalledWith('previous settle interrupted', { detail: fault.message });
  });

  it('keeps the full drain transitive across a rejected intermediate projection', async () => {
    const history = deferred();
    const began = deferred();
    const first = chainSettlePhases(
      IDLE,
      logger(),
      () => Promise.resolve({ early: true }),
      async () => {
        began.resolve(undefined);
        await history.promise;
      },
    );
    await began.promise;
    const fault = new Error('intermediate projection failed');
    const middle = chainSettlePhases(
      first,
      logger(),
      () => Promise.reject(fault),
      () => Promise.resolve(),
    );
    const middleAnswer = observedResult(middle.answered);
    const middleDone = observedResult(middle.done);
    const lastHistory = vi.fn(() => Promise.resolve());
    const last = chainSettlePhases(
      middle,
      logger(),
      () => Promise.resolve({ early: true }),
      lastHistory,
    );
    const drain = watched(last.done);

    try {
      await last.answered;
      await microtasks();

      expect(drain.settled).toBe(false);
      expect(lastHistory).not.toHaveBeenCalled();
    } finally {
      history.resolve(undefined);
      await last.done;

      await expect(middleAnswer).resolves.toBe(fault);
      await expect(middleDone).resolves.toBe(fault);
    }

    expect(lastHistory).toHaveBeenCalledExactlyOnceWith({ early: true });
  });
});
