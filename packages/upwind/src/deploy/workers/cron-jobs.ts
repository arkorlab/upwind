import { CRON_SCHEDULE_HEADER, CRON_USER_AGENT, type CronRun } from './protocol.ts';

/**
 * The cron jobs a trigger fires, as the edge runs them (`edge.ts`'s `scheduled`): each a GET of its
 * path on the site, handed to the edge as a visitor's request is (`send`), so that it reaches the
 * route as one would.
 */

/** What a firing is: the trigger, and what the edge's version was given to fire it with. */
export interface CronFiring {
  /** The Cloudflare Cron Trigger that fired, as written. */
  readonly trigger: string;
  /** The deployment's jobs by trigger, as JSON, in the parts the edge holds them in (`CRONS`…). */
  readonly tables: readonly string[];
  /** The hostnames the edge is reached on, comma-separated (`HOSTNAMES`). */
  readonly hostnames: string | undefined;
  /** What each job is sent as a bearer token, where the project set it (`CRON_SECRET`). */
  readonly secret: string | undefined;
  /** A request handed to the edge, and its answer. */
  readonly send: (request: Request) => Promise<Response>;
}

/** The jobs of a trigger in every part of the table, read loosely: a part that cannot be read has none. */
export function jobsOn(tables: readonly string[], trigger: string): CronRun[] {
  return tables.flatMap((table) => jobsIn(table, trigger));
}

function jobsIn(table: string, trigger: string): CronRun[] {
  try {
    const parsed: unknown = JSON.parse(table);
    const jobs: unknown =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, trigger) : undefined;
    return Array.isArray(jobs)
      ? jobs.filter((job): job is CronRun => {
          return (
            typeof job === 'object' &&
            job !== null &&
            typeof Reflect.get(job, 'path') === 'string' &&
            typeof Reflect.get(job, 'schedule') === 'string'
          );
        })
      : [];
  } catch {
    return [];
  }
}

/**
 * One job: a GET of its path, on the first of the edge's hostnames, with what Vercel sends a job
 * with — the schedule it fired on, and the project's secret as a bearer token where it set one —
 * read to its end, since a job is done when its answer is, and letting the answer go would cancel
 * what the route is still doing.
 */
async function fire(firing: CronFiring, job: CronRun): Promise<number> {
  const host = firing.hostnames?.split(',', 1)[0]?.trim() ?? '';
  if (host === '') {
    throw new Error('the edge is reached on no hostname to send it to');
  }
  const headers = new Headers({
    'user-agent': CRON_USER_AGENT,
    [CRON_SCHEDULE_HEADER]: job.schedule,
  });
  if (firing.secret !== undefined && firing.secret !== '') {
    headers.set('authorization', `Bearer ${firing.secret}`);
  }
  const response = await firing.send(
    new Request(new URL(job.path, `https://${host}`), { headers }),
  );
  // Into a sink that keeps nothing: the answer is read to its end, and held nowhere.
  await response.body?.pipeTo(new WritableStream());
  return response.status;
}

/** Every job of the trigger, at once; each said, with what it was answered or why it was not. */
export async function fireCronJobs(firing: CronFiring): Promise<void> {
  const jobs = jobsOn(firing.tables, firing.trigger);
  if (jobs.length === 0) {
    console.warn(`upwind cron: this deployment has no job on "${firing.trigger}"`);
    return;
  }
  const outcomes = await Promise.allSettled(jobs.map((job) => fire(firing, job)));
  for (const [index, outcome] of outcomes.entries()) {
    const job = jobs[index];
    const said = `upwind cron: GET ${job?.path ?? ''} on "${job?.schedule ?? ''}"`;
    if (outcome.status === 'fulfilled') {
      console.log(`${said} answered ${outcome.value}`);
    } else {
      console.error(`${said} failed: ${String(outcome.reason)}`);
    }
  }
}
