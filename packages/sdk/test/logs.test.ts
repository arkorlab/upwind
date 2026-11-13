import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLogContext, type LogContext } from '../src/logs.ts';

describe('setLogContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits one structured marker synchronously and snapshots authenticated identifiers', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue(undefined);
    const context = { userId: 'usr_42', tenantId: 'tenant_7' };
    const result = setLogContext(context);
    context.userId = 'changed';

    expect(result).toBe(true);
    expect(log).toHaveBeenCalledExactlyOnceWith({
      message: 'upwind.custom-context.v1',
      __upwindLogContext: 1,
      context: { userId: 'usr_42', tenantId: 'tenant_7' },
    });
  });

  it('keeps no context between calls and leaves ordinary console calls alone', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue(undefined);

    expect(setLogContext({ userId: 'user-a' })).toBe(true);
    expect(setLogContext({ tenantId: 'tenant-b' })).toBe(true);

    // eslint-disable-next-line no-console -- verifies that the SDK did not install a console wrapper.
    console.log('ordinary application message');

    expect(log).toHaveBeenNthCalledWith(1, {
      message: 'upwind.custom-context.v1',
      __upwindLogContext: 1,
      context: { userId: 'user-a' },
    });
    expect(log).toHaveBeenNthCalledWith(2, {
      message: 'upwind.custom-context.v1',
      __upwindLogContext: 1,
      context: { tenantId: 'tenant-b' },
    });
    expect(log).toHaveBeenNthCalledWith(3, 'ordinary application message');
  });

  it('returns false without logging malformed, accessor, or oversized context', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue(undefined);
    const getter = vi.fn(() => 'not-read');
    const accessor = Object.defineProperty({}, 'userId', { enumerable: true, get: getter });
    const oversized = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [String(index), '😀'.repeat(100)] as const),
    );

    for (const input of [null, { userId: 42 }, accessor, oversized]) {
      expect(setLogContext(input as LogContext)).toBe(false);
    }

    expect(log).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it('contains console failures without replacing the application result', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('logging unavailable');
    });

    expect(setLogContext({ userId: 'usr_42' })).toBe(false);
  });
});
