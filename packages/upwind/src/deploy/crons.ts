import {
  cloudflareCronExpressionError,
  cloudflareScheduleOf,
  type CronJob,
  nextCloudflareFireAfterExpression,
  nextFireAfterExpression,
} from '@stayingupwind/core/cron';
import { compareCodeUnits } from '@stayingupwind/core/util';

import { type AccountScope, getSchedules, putSchedules } from './cloudflare/workers.ts';
import type { DeploySettings } from './config.ts';
import { readSecret, reservedNames } from './env.ts';
import { CRON_SECRET, CRONS_PART_BYTES, type CronRun, type CronTable } from './workers/protocol.ts';

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

/** How many bytes a part of the table takes, as the binding holds it. */
function bytesOf(part: CronTable): number {
  return Buffer.byteLength(JSON.stringify(part), 'utf8');
}

/**
 * The table in parts each one binding can hold (`CRONS_PART_BYTES`), in the order of its triggers,
 * a trigger's jobs carried on into the next part where they do not fit in one: the edge reads every
 * part and joins each trigger's jobs (`workers/cron-jobs.ts`). A project's hundred jobs, each on a
 * path as long as one may be, take a dozen.
 */
export function cronTableParts(table: CronTable): string[] {
  const parts: Record<string, CronRun[]>[] = [];
  let current: Record<string, CronRun[]> = {};
  for (const trigger of triggersOf(table)) {
    const jobs = table[trigger];
    if (jobs === undefined) {
      continue;
    }
    for (const job of jobs) {
      const grown = { ...current, [trigger]: [...(current[trigger] ?? []), job] };
      if (Object.keys(current).length > 0 && bytesOf(grown) > CRONS_PART_BYTES) {
        parts.push(current);
        current = { [trigger]: [job] };
      } else {
        current = grown;
      }
    }
  }
  if (Object.keys(current).length > 0) {
    parts.push(current);
  }
  return parts.map((part) => JSON.stringify(part));
}

/** The secret a deployment's cron jobs are sent with: the project's, where it has one with a value. */
export function cronSecretIn(secrets: ReadonlyMap<string, string>): string | undefined {
  const secret = secrets.get(CRON_SECRET);
  return secret === undefined || secret === '' ? undefined : secret;
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
    if (bytesOf({ [trigger]: [{ path, schedule }] }) > CRONS_PART_BYTES) {
      problems.push(
        `the cron job of ${path} on "${schedule}" is over the ${CRONS_PART_BYTES} bytes the edge holds of one job; shorten its path or its schedule`,
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

/**
 * The secret a rollback sends its deployment's jobs with: `CRON_SECRET` as a deploy reads it, from
 * the environment where `deploy.secrets` names it, else from the `--env-file`s — the value the
 * deployment's Functions were deployed with, unless it has changed since. Nothing else of the files
 * is read or held to anything (`readSecret`): a rollback binds no other.
 */
export async function rollbackCronSecret(
  envFiles: readonly string[],
  settings: Pick<DeploySettings, 'secrets' | 'storage'>,
): Promise<string | undefined> {
  const secret = await readSecret({
    name: CRON_SECRET,
    files: envFiles,
    names: settings.secrets,
    env: process.env,
    reserved: reservedNames(settings.storage),
  });
  return secret === undefined || secret === '' ? undefined : secret;
}

/**
 * What a rollback uploads the edge's version with for its deployment's jobs: the jobs, and the
 * secret it read; or, where it read none, the one the edge's newest version holds, kept — which is
 * the last deploy's, or one that failed its checks since, so it is said.
 */
export function rollbackCrons(
  crons: readonly CronJob[] | undefined,
  cronSecret: string | undefined,
): {
  readonly crons: CronTable;
  readonly cronSecret: string | undefined;
  readonly keepSecrets: boolean;
} {
  const table = cronTableOf(crons);
  if (cronSecret === undefined && Object.keys(table).length > 0) {
    console.warn(
      `upwind: warning: ${CRON_SECRET} is in neither the environment nor an --env-file, so the cron jobs are sent with the one the edge's newest version holds, if it holds one`,
    );
  }
  return { crons: table, cronSecret, keepSecrets: cronSecret === undefined };
}
