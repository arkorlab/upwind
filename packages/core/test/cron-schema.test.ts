import { describe, expect, it } from 'vitest';

import { cronJobSchema, cronsSchema, MAX_CRONS_PER_PROJECT } from '../src/cron/schema.ts';

describe('cronJobSchema', () => {
  it('takes what a Vercel project declares', () => {
    expect(cronJobSchema.parse({ path: '/api/cron', schedule: '0 5 * * *' })).toStrictEqual({
      path: '/api/cron',
      schedule: '0 5 * * *',
    });
    // A dynamic route with its parameter filled in, which is how Vercel's own docs schedule one.
    expect(
      cronJobSchema.safeParse({ path: '/api/sync-slack-team/T0CAQ10TZ', schedule: '0 5 * * *' })
        .success,
    ).toBe(true);
  });

  it.each([
    ['a relative path', 'api/cron'],
    ['an absolute URL', 'https://example.test/api/cron'],
    ['a protocol-relative URL', '//example.test/api/cron'],
    ['a path with a space', '/api/ cron'],
    ['a path with a newline', '/api/cron\n'],
    ['an empty path', ''],
  ])('refuses %s', (_case, path) => {
    expect(cronJobSchema.safeParse({ path, schedule: '0 5 * * *' }).success).toBe(false);
  });

  it('refuses a schedule it cannot run, saying why', () => {
    const result = cronJobSchema.safeParse({ path: '/api/cron', schedule: '0 0 * * MON' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/invalid cron expression/u);
  });
});

/** One of many jobs, each on its own path: what fills a project up to its allowance. */
function job(index: number): { path: string; schedule: string } {
  return { path: `/api/cron/${index}`, schedule: '0 5 * * *' };
}

describe('cronsSchema', () => {
  it('takes one path on more than one schedule', () => {
    const crons = [
      { path: '/api/sync', schedule: '*/5 * * * *' },
      { path: '/api/sync', schedule: '0 0 * * *' },
    ];

    expect(cronsSchema.parse(crons)).toStrictEqual(crons);
  });

  it('refuses the same path on the same schedule twice', () => {
    const result = cronsSchema.safeParse([
      { path: '/api/sync', schedule: '0 0 * * *' },
      { path: '/api/sync', schedule: '0 0 * * *' },
    ]);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/scheduled twice/u);
  });

  it('takes as many as Vercel allows a project, and no more', () => {
    const allowed = Array.from({ length: MAX_CRONS_PER_PROJECT }, (_value, index) => job(index));

    expect(cronsSchema.safeParse(allowed).success).toBe(true);
    expect(cronsSchema.safeParse([...allowed, job(MAX_CRONS_PER_PROJECT)]).success).toBe(false);
  });
});
