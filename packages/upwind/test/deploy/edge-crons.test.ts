import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CronFiring, fireCronJobs } from '../../src/deploy/workers/cron-jobs.ts';

/**
 * The cron jobs a trigger fires on the edge (`workers/cron-jobs.ts`): which jobs, and the request
 * each is, as the edge it is handed to sees it. That the shipped edge fires them from `scheduled`
 * is `workers/edge.test.ts`'s.
 */

const TABLE = {
  '0 9 * * 2': [
    { path: '/api/weekly', schedule: '0 9 * * 1' },
    { path: '/api/report?kind=week', schedule: '0 9 * * 1' },
  ],
  '0 * * * *': [{ path: '/api/tick', schedule: '0 * * * *' }],
};

describe("the edge's cron jobs", () => {
  const logged: string[] = [];
  let sent: Request[];
  let answer: () => Response;

  function firing(trigger: string, overrides: Partial<CronFiring> = {}): CronFiring {
    return {
      trigger,
      tables: [JSON.stringify(TABLE)],
      hostnames: 'shop.example.com,shop-edge.example.workers.dev',
      secret: undefined,
      send: (request) => {
        sent.push(request);
        return Promise.resolve(answer());
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    sent = [];
    answer = () => new Response('done');
    logged.length = 0;
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((text: string) => {
        logged.push(text);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires every job of the trigger as a GET on the first hostname, once', async () => {
    await fireCronJobs(firing('0 9 * * 2'));

    expect(sent.map((request) => [request.method, request.url])).toStrictEqual([
      ['GET', 'https://shop.example.com/api/weekly'],
      ['GET', 'https://shop.example.com/api/report?kind=week'],
    ]);

    const [weekly] = sent;

    expect(weekly?.headers.get('user-agent')).toBe('upwind-cron/1.0');
    expect(weekly?.headers.get('x-vercel-cron-schedule')).toBe('0 9 * * 1');
    expect(weekly?.headers.has('authorization')).toBe(false);
    expect(logged).toContain('upwind cron: GET /api/weekly on "0 9 * * 1" answered 200');
  });

  it("joins a trigger's jobs across the parts the table is held in", async () => {
    const tables = [
      JSON.stringify({ '0 * * * *': [{ path: '/api/one', schedule: '0 * * * *' }] }),
      '{not json',
      JSON.stringify({
        '0 * * * *': [{ path: '/api/two', schedule: '0 */1 * * *' }],
        '0 9 * * 2': [{ path: '/api/weekly', schedule: '0 9 * * 1' }],
      }),
    ];
    await fireCronJobs(firing('0 * * * *', { tables }));

    expect(sent.map((request) => new URL(request.url).pathname)).toStrictEqual([
      '/api/one',
      '/api/two',
    ]);
  });

  it('sends the secret as a bearer token where the project set one', async () => {
    await fireCronJobs(firing('0 * * * *', { secret: 's3cret' }));

    expect(sent[0]?.headers.get('authorization')).toBe('Bearer s3cret');
  });

  it('fires nothing on a trigger the deployment has no job on, or with no jobs at all', async () => {
    await fireCronJobs(firing('*/5 * * * *'));
    await fireCronJobs(firing('0 * * * *', { tables: [] }));
    await fireCronJobs(firing('0 * * * *', { tables: ['{not json'] }));

    expect(sent).toStrictEqual([]);
    expect(logged.filter((line) => line.includes('has no job on'))).toHaveLength(3);
  });

  it('reads each answer to its end, and says what a job that fails failed with', async () => {
    let pulled = 0;
    answer = () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled > 3) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array([pulled]));
          },
        }),
        { status: 500 },
      );
    };
    await fireCronJobs(firing('0 * * * *'));

    expect(pulled).toBe(4);
    expect(logged).toContain('upwind cron: GET /api/tick on "0 * * * *" answered 500');

    answer = () => {
      throw new Error('the Function is gone');
    };
    await fireCronJobs(firing('0 * * * *'));

    expect(logged).toContain(
      'upwind cron: GET /api/tick on "0 * * * *" failed: Error: the Function is gone',
    );
  });

  it('fires nothing, and says so, for an edge reached on no hostname', async () => {
    await fireCronJobs(firing('0 * * * *', { hostnames: '' }));

    expect(sent).toStrictEqual([]);
    expect(logged).toContainEqual(expect.stringContaining('reached on no hostname'));
  });
});
