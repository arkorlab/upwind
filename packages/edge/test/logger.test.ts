import { afterEach, describe, expect, it, vi } from 'vitest';

import { logWarn } from '../src/observability/logger.ts';

/** A warning the edge logs: one line of JSON, its level and message first, then what it names. */
describe('a warning logged', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps its own level and message, first, whatever its fields name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Read below, not printed.
    });

    logWarn('record copy write failed', { key: 'k' });
    logWarn('record copy write failed', { level: 'debug', message: 'another', key: 'k' });

    expect(warn.mock.calls).toStrictEqual([
      ['{"level":"warn","message":"record copy write failed","key":"k"}'],
      ['{"level":"warn","message":"record copy write failed","key":"k"}'],
    ]);
  });
});
