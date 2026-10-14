import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../src/logger.ts';

describe('a log line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is written as it always was, the record first and the fields after it', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Read below.
    });

    createLogger({ scopeId: 'scope' }).warn('settle failed', { detail: 'timeout' });

    expect(warned).toHaveBeenCalledWith(
      '{"level":"warn","msg":"settle failed","component":"cache","scopeId":"scope","detail":"timeout"}',
    );
  });

  /**
   * A processor reads a line's level and message to classify it, and its component to know whose
   * it is: a field that shares a name with one of them changes none of them.
   */
  it('says the level, the message and the component it was written with, whatever its fields say', () => {
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {
      // Read below.
    });

    createLogger({ component: 'gateway', level: 'info' }).error('request failed', {
      level: 'info',
      msg: 'nothing happened',
      component: 'elsewhere',
      detail: 'timeout',
    });

    expect(failed).toHaveBeenCalledWith(
      '{"level":"error","msg":"request failed","component":"gateway","detail":"timeout"}',
    );
  });
});
