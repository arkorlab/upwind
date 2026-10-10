import * as z from '../schema/index.ts';
import { cronExpressionError } from './expression.ts';

/**
 * A project's cron jobs, as a build declares them.
 *
 * The shape is Vercel's (`vercel.json`'s `crons`): a path and a schedule, and nothing else
 * (https://vercel.com/docs/cron-jobs, read 2026-09-23). What the platform does with one — a GET to
 * the project's own hostname, once, on a schedule read in UTC — is in the README under
 * "Cron jobs"; this file is only what may be written down.
 */

/** As many as Vercel allows a project, on every plan. */
export const MAX_CRONS_PER_PROJECT = 100;
/** A path long enough for any route with its parameters filled in, and short enough to store. */
const MAX_CRON_PATH_LENGTH = 512;

/**
 * Where a cron job is sent.
 *
 * A path, not a URL: the platform decides the host, and a job that could name one would be a way
 * to make this platform fetch anything on a schedule. Held to printable ASCII with no space so
 * that it goes into a request line as written — a path that needed escaping would be sent
 * differently than it reads here, and the route it reached would not be the one written down.
 */
const cronPathSchema = z
  .string()
  .min(1)
  .max(MAX_CRON_PATH_LENGTH)
  .regex(/^\/[\u{21}-\u{7E}]*$/u, 'expected a path beginning with "/"')
  .refine((path) => !path.startsWith('//'), 'expected a path, not a protocol-relative URL');

export const cronJobSchema = z.object({
  path: cronPathSchema,
  schedule: z.string().superRefine((schedule, ctx) => {
    const reason = cronExpressionError(schedule);
    if (reason !== undefined) {
      ctx.addIssue({ code: 'custom', message: reason });
    }
  }),
});
export type CronJob = z.infer<typeof cronJobSchema>;

/**
 * Every cron job of one project.
 *
 * The same path may be scheduled more than once — that is what `x-vercel-cron-schedule` is for —
 * but the same path on the same schedule twice is one job written twice, and the platform stores
 * it once; refused here so that a build says so rather than a deployment quietly dropping one.
 */
export const cronsSchema = z
  .array(cronJobSchema)
  .max(MAX_CRONS_PER_PROJECT)
  .superRefine((crons, ctx) => {
    const seen = new Set<string>();
    for (const [index, cron] of crons.entries()) {
      const key = `${cron.path}\n${cron.schedule}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `${cron.path} is scheduled twice on "${cron.schedule}"`,
          path: [index],
        });
      }
      seen.add(key);
    }
  });
