import {
  cloudflareCronExpressionError,
  cloudflareScheduleOf,
  type CronJob,
  nextCloudflareFireAfterExpression,
  nextFireAfterExpression,
} from '@stayingupwind/core/cron';
import { compareCodeUnits } from '@stayingupwind/core/util';

import { type AccountScope, getSchedules, putSchedules } from './cloudflare/workers.ts';
import type { CronTable } from './workers/protocol.ts';

export type { CronTable } from './workers/protocol.ts';

/**
 * A deployment's cron jobs, as `upwind deploy` runs them: each a GET of its path on the site,
 * fired by a Cloudflare Cron Trigger on the edge.
 *
 * A job is declared in Vercel's dialect, which Cloudflare reads differently — its days of the week
 * count from 1 — so each schedule is written as the trigger that fires when it does
 * (`cloudflareScheduleOf`), and jobs whose schedules select the same minutes share one. The edge's
 * version for the deployment holds the jobs by trigger (`CRONS`), and runs those of the trigger it
 * is invoked on (`workers/edge.ts`).
 *
 * The triggers are the edge Worker's, not a version's: they are set to the live deployment's once
 * its version has the traffic, by a deploy and by a rollback alike, so a rollback goes back with its
 * deployment's jobs. Until then the version before runs the jobs it knows, and any trigger it does
 * not know it leaves alone.
 */

/** How many firings of a schedule its trigger is held to, before a deploy relies on it. */
const FIRINGS_CHECKED = 24;

/** The deployment's jobs by the trigger each fires on. */
export function cronTableOf(crons: readonly CronJob[] | undefined): CronTable {
  const table: Record<string, { path: string; schedule: string }[]> = {};
  if (crons === undefined) {
    return table;
  }
  for (const { path, schedule } of crons) {
    const trigger = cloudflareScheduleOf(schedule);
    const jobs = table[trigger] ?? [];
    jobs.push({ path, schedule });
    table[trigger] = jobs;
  }
  return table;
}

/** The triggers of a table, in one order. */
export function triggersOf(table: CronTable): string[] {
  return Object.keys(table).toSorted(compareCodeUnits);
}

/** The first firings of an expression after a moment, as one calculator finds them. */
function firingsOf(
  next: (source: string, afterMs: number) => number | undefined,
  source: string,
  fromMs: number,
): number[] {
  const firings: number[] = [];
  let after = fromMs;
  while (firings.length < FIRINGS_CHECKED) {
    const at = next(source, after);
    if (at === undefined) {
      break;
    }
    firings.push(at);
    after = at;
  }
  return firings;
}

/**
 * Why a job's trigger cannot be relied on to fire when its schedule does; nothing where it can.
 * Every schedule a build accepts is written as one that does, so this is the check of that writing
 * rather than of the project: Cloudflare's reading of the trigger, held to the schedule's own over
 * its next firings.
 */
export function cronProblems(crons: readonly CronJob[] | undefined, nowMs: number): string[] {
  const problems: string[] = [];
  if (crons === undefined) {
    return problems;
  }
  for (const { path, schedule } of crons) {
    const trigger = cloudflareScheduleOf(schedule);
    const refused = cloudflareCronExpressionError(trigger);
    const same =
      refused === undefined &&
      firingsOf(nextCloudflareFireAfterExpression, trigger, nowMs).join(',') ===
        firingsOf(nextFireAfterExpression, schedule, nowMs).join(',');
    if (!same) {
      const why = refused === undefined ? 'fires at other times' : `refuses: ${refused}`;
      problems.push(
        `the cron job of ${path} on "${schedule}" would be the Cron Trigger "${trigger}", which Cloudflare ${why}`,
      );
    }
  }
  return problems;
}

/**
 * The edge's Cron Triggers set to these, where they are not already: read first, so a deploy of a
 * project with no jobs, on an edge with none, writes nothing.
 */
export async function scheduleCrons(
  scope: AccountScope,
  edge: string,
  triggers: readonly string[],
): Promise<boolean> {
  const now = await getSchedules(scope, edge);
  if (
    now.toSorted(compareCodeUnits).join('\n') === triggers.toSorted(compareCodeUnits).join('\n')
  ) {
    return false;
  }
  await putSchedules(scope, edge, triggers);
  return true;
}

/**
 * The live deployment's triggers set, once its version has the traffic: whether they were. A
 * failure leaves the deployment live, its edge on the triggers it had, and is said — the jobs do not
 * fire as declared until they are set, which a deploy of the live deployment does again.
 */
export async function holdCrons(
  scope: AccountScope,
  edge: string,
  table: CronTable,
  deploymentId: string,
): Promise<boolean> {
  const triggers = triggersOf(table);
  try {
    if (await scheduleCrons(scope, edge, triggers)) {
      const quoted = triggers.map((trigger) => JSON.stringify(trigger)).join(', ');
      console.log(
        triggers.length === 0
          ? `upwind: ${edge} fires no Cron Trigger now`
          : `upwind: ${edge} fires on ${quoted}; Cloudflare may take up to 15 minutes to fire on a trigger it was just given`,
      );
    }
    return true;
  } catch (error) {
    console.error(
      `upwind: ${deploymentId} is live, and the edge's Cron Triggers were not set to its cron jobs: ${error instanceof Error ? error.message : String(error)}; until a deploy of it sets them, they are the ones before`,
    );
    return false;
  }
}
