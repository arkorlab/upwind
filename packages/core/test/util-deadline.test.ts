import { afterEach, describe, expect, it, vi } from 'vitest';

import { isDeadlineError, withDeadline } from '../src/util/deadline.ts';

/** Give a late rejection an event-loop turn, so the runner detects an unhandled one. */
function turn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('ownership of work passed to a deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, -1])('rejects an expired %s budget and observes already-started work', async (ms) => {
    const input = Promise.withResolvers<never>();

    await expect(withDeadline(input.promise, ms, 'body read')).rejects.toSatisfy(isDeadlineError);

    input.reject(new Error('cancelled pending native read'));
    await turn();
  });

  it('keeps a timely value and clears the original timer', async () => {
    vi.useFakeTimers();
    const input = Promise.withResolvers<string>();
    const result = withDeadline(input.promise, 50, 'body read');
    input.resolve('complete');

    await expect(result).resolves.toBe('complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an input rejection identity before a positive deadline', async () => {
    vi.useFakeTimers();
    const input = Promise.withResolvers<never>();
    const failure = new Error('read failed');
    const result = withDeadline(input.promise, 50, 'body read');
    input.reject(failure);

    await expect(result).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues to observe a late rejection after its existing positive timer expires', async () => {
    vi.useFakeTimers();
    const input = Promise.withResolvers<never>();
    const result = withDeadline(input.promise, 50, 'body read');

    await Promise.all([
      expect(result).rejects.toSatisfy(isDeadlineError),
      vi.advanceTimersByTimeAsync(51),
    ]);

    input.reject(new Error('read failed after timeout'));
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });
});
