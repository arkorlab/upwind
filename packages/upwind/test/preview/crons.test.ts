import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startCronJobs } from '../../src/preview/crons.ts';

/**
 * A preview's cron jobs on a clock of the test's own: when each fires, at what, with what, and that
 * a stop leaves none to fire.
 */

const SITE = new URL('http://localhost:3000/');
/** A Monday, 12:03:30 in UTC. */
const START = Date.UTC(2026, 9, 26, 12, 3, 30);
const MINUTE = 60_000;

interface Asked {
  readonly url: string;
  readonly at: number;
  readonly headers: Readonly<Record<string, string>>;
}

describe("a preview's cron jobs", () => {
  let asked: Asked[];
  const fetchImpl: typeof fetch = (input, init) => {
    asked.push({
      url: input instanceof Request ? input.url : String(input),
      at: Date.now(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return Promise.resolve(new Response('done'));
  };

  beforeEach(() => {
    asked = [];
    vi.useFakeTimers({ now: START });
    vi.spyOn(console, 'log').mockImplementation(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fire each on its schedule, as a deployed edge sends it, at the preview', async () => {
    const running = startCronJobs({
      jobs: [{ path: '/api/sweep?all=1', schedule: '*/5 * * * *' }],
      site: SITE,
      secret: 'cron-secret',
      fetchImpl,
    });

    expect(running.next).toStrictEqual([{ schedule: '*/5 * * * *', at: START + 90_000 }]);

    await vi.advanceTimersByTimeAsync(90_000 + 5 * MINUTE);

    expect(asked).toStrictEqual([
      {
        url: 'http://localhost:3000/api/sweep?all=1',
        at: START + 90_000,
        headers: {
          authorization: 'Bearer cron-secret',
          'user-agent': 'upwind-cron/1.0',
          'x-vercel-cron-schedule': '*/5 * * * *',
        },
      },
      {
        url: 'http://localhost:3000/api/sweep?all=1',
        at: START + 90_000 + 5 * MINUTE,
        headers: {
          authorization: 'Bearer cron-secret',
          'user-agent': 'upwind-cron/1.0',
          'x-vercel-cron-schedule': '*/5 * * * *',
        },
      },
    ]);

    await running.stop();
  });

  it('fire the jobs of one schedule together, and send no secret the project has none of', async () => {
    const running = startCronJobs({
      jobs: [
        { path: '/a', schedule: '0 13 * * *' },
        { path: '/b', schedule: '0 13 * * *' },
        { path: '/c', schedule: '30 12 * * *' },
      ],
      site: SITE,
      secret: undefined,
      fetchImpl,
    });

    await vi.advanceTimersByTimeAsync(Date.UTC(2026, 9, 26, 13, 0, 0) - START);

    expect(asked.map(({ url, at }) => [new URL(url).pathname, at])).toStrictEqual([
      ['/c', Date.UTC(2026, 9, 26, 12, 30, 0)],
      ['/a', Date.UTC(2026, 9, 26, 13, 0, 0)],
      ['/b', Date.UTC(2026, 9, 26, 13, 0, 0)],
    ]);
    expect(asked.every(({ headers }) => headers['authorization'] === undefined)).toBe(true);

    await running.stop();
  });

  it('wait a schedule further off than a timer holds, in parts, and fire it then', async () => {
    // The 29th of February: in 2028, past the longest a single timer waits.
    const running = startCronJobs({
      jobs: [{ path: '/leap', schedule: '0 0 29 2 *' }],
      site: SITE,
      secret: undefined,
      fetchImpl,
    });
    const leap = Date.UTC(2028, 1, 29);

    expect(running.next).toStrictEqual([{ schedule: '0 0 29 2 *', at: leap }]);

    await vi.advanceTimersByTimeAsync(leap - START - MINUTE);

    expect(asked).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(asked.map(({ at }) => at)).toStrictEqual([leap]);

    await running.stop();
  });

  it('fire nothing once stopped', async () => {
    const running = startCronJobs({
      jobs: [{ path: '/every-minute', schedule: '* * * * *' }],
      site: SITE,
      secret: undefined,
      fetchImpl,
    });

    await running.stop();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    expect(asked).toStrictEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
