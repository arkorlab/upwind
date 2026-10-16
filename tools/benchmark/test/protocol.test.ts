import { describe, expect, it } from 'vitest';

import { failedSample, planOf, SETTINGS } from '../src/protocol.ts';
import { runScenario } from '../src/run.ts';

describe('paired measurement protocol', () => {
  it('warms both sides twenty times and alternates measured first side', () => {
    const plan = planOf(SETTINGS);

    expect(plan.filter((step) => step.warmup)).toHaveLength(40);
    expect(plan.filter((step) => step.warmup && step.side === 'vercel')).toHaveLength(20);
    expect(plan.filter((step) => step.warmup && step.side === 'arkor')).toHaveLength(20);
    expect(plan.filter((step) => !step.warmup)).toHaveLength(60);
    expect(plan.slice(40, 44)).toStrictEqual([
      { side: 'vercel', warmup: false },
      { side: 'arkor', warmup: false },
      { side: 'arkor', warmup: false },
      { side: 'vercel', warmup: false },
    ]);
  });

  it('keeps a pair whose second request the budget prevented', async () => {
    let now = 0;
    const seen: string[] = [];
    const sample = failedSample('timed out');
    const run = await runScenario(
      'new-connection',
      { ...SETTINGS, warmup: 0, budgetMs: 10 },
      (side) => {
        seen.push(side);
        now += 11;
        return Promise.resolve(sample);
      },
      { now: () => now, sleep: () => Promise.resolve() },
    );

    expect(seen).toStrictEqual(['vercel']);
    expect(run.truncated).toBe(true);
    expect(run.pairs).toStrictEqual([
      {
        first: 'vercel',
        vercel: sample,
        arkor: failedSample('not made: the budget ran out first'),
      },
    ]);
  });

  it('checks the deadline after spacing and never overlaps requests', async () => {
    let now = 0;
    let active = false;
    const seen: string[] = [];
    const run = await runScenario(
      'reused-connection',
      { ...SETTINGS, pairs: 2, warmup: 0, spacingMs: 10, budgetMs: 25 },
      async (side) => {
        expect(active).toBe(false);

        active = true;
        await Promise.resolve();
        seen.push(side);
        now += 1;
        active = false;
        return failedSample('network');
      },
      {
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      },
    );

    expect(seen).toStrictEqual(['vercel', 'arkor', 'arkor']);
    expect(run.pairs).toHaveLength(2);
    expect(run.pairs[1]?.vercel.error).toBe('not made: the budget ran out first');
  });
});
