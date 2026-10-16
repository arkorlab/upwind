import { describe, expect, it, vi } from 'vitest';

import { measureRun } from '../src/run.ts';
import { SAMPLE } from './helpers.ts';

vi.mock(import('../src/measure.ts'), async (original) => {
  return {
    ...(await original()),
    timeRequest: () => Promise.resolve(SAMPLE),
  };
});

describe('measurement execution context', () => {
  const clock = { now: () => 0, sleep: () => Promise.resolve() };

  it('labels local repetitions as local and requires an explicit GitHub vantage', async () => {
    const local = await measureRun(undefined, clock);
    const github = await measureRun('github', clock);

    expect(local.vantage).toBe('local');
    expect(github.vantage).toBe('github');
    expect(local.scenarios).toStrictEqual(github.scenarios);
  });
});
