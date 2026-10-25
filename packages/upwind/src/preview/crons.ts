import {
  type CronExpression,
  type CronJob,
  nextFireAfter,
  parseCronExpression,
} from '@stayingupwind/core/cron';

import { fireCronJobs } from '../deploy/workers/cron-jobs.ts';

/**
 * The build's cron jobs, fired on their schedules while a preview serves, as a deployed edge fires
 * them on its Cron Triggers (`deploy/workers/cron-jobs.ts`, whose firing this is): each a GET of
 * its path on the site, with the headers Vercel sends a job with, and the project's `CRON_SECRET`
 * as a bearer token where the secrets hold one. In UTC, as Vercel's schedules are written.
 *
 * Only when asked for (`--crons`): a preview beside a deployment of the same project would run each
 * job twice, against whatever both of them reach.
 */

/** The longest a timer waits at once: Node's own bound, past which it would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

export interface CronJobsInput {
  readonly jobs: readonly CronJob[];
  /** Where the preview serves. */
  readonly site: URL;
  /** `CRON_SECRET`, where the secrets hold one. */
  readonly secret: string | undefined;
  /** The clock: `Date.now`, but in a test. */
  readonly now?: (() => number) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface RunningCronJobs {
  /** Each schedule, and when it fires first. */
  readonly next: readonly { readonly schedule: string; readonly at: number }[];
  /** Fire nothing more, and let go of what is under way. */
  stop(): Promise<void>;
}

/** The jobs by the schedule each fires on, in the order the build declares them. */
function bySchedule(jobs: readonly CronJob[]): Map<string, CronJob[]> {
  const grouped = new Map<string, CronJob[]>();
  for (const job of jobs) {
    grouped.set(job.schedule, [...(grouped.get(job.schedule) ?? []), job]);
  }
  return grouped;
}

/** Arm a timer for each of the build's schedules, until the preview stops. */
export function startCronJobs(input: CronJobsInput): RunningCronJobs {
  const now = input.now ?? Date.now;
  const fetchImpl = input.fetchImpl ?? fetch;
  const stopping = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const firing = new Set<Promise<void>>();
  const grouped = bySchedule(input.jobs);
  // The jobs as a deployed edge holds them, by trigger: here each schedule is its own.
  const table = JSON.stringify(Object.fromEntries(grouped));
  // What the edge's firing sends to the site's first hostname goes to the preview instead, as a
  // visitor's request would: through its edge, and not following a redirect.
  const send = (request: Request): Promise<Response> => {
    const { pathname, search } = new URL(request.url);
    return fetchImpl(new URL(`${pathname}${search}`, input.site), {
      headers: request.headers,
      redirect: 'manual',
      signal: stopping.signal,
    });
  };
  const fire = async (schedule: string): Promise<void> => {
    const run = fireCronJobs({
      trigger: schedule,
      tables: [table],
      hostnames: input.site.host,
      secret: input.secret,
      send,
    });
    firing.add(run);
    try {
      await run;
    } finally {
      firing.delete(run);
    }
  };
  const arm = (schedule: string, expression: CronExpression, at: number): void => {
    const wait = Math.min(Math.max(at - now(), 0), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopping.signal.aborted) {
        return;
      }
      // A wait longer than a timer holds is waited in parts.
      if (now() < at) {
        arm(schedule, expression, at);
        return;
      }
      void fire(schedule).catch(() => {
        // Each job's answer, or why there was none, is `fireCronJobs`'s to say.
      });
      // From now, where a sleeping machine woke late: a missed firing is not made up, as a
      // trigger's is not.
      const following = nextFireAfter(expression, Math.max(at, now()));
      if (following !== undefined) {
        arm(schedule, expression, following);
      }
    }, wait);
    timers.add(timer);
  };
  const next: { schedule: string; at: number }[] = [];
  for (const schedule of grouped.keys()) {
    const expression = parseCronExpression(schedule);
    const at = nextFireAfter(expression, now());
    if (at !== undefined) {
      arm(schedule, expression, at);
      next.push({ schedule, at });
    }
  }
  return {
    next,
    stop: async () => {
      stopping.abort();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      await Promise.allSettled(firing);
    },
  };
}
