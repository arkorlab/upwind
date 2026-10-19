import type { EdgeHost } from '../edge-host.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import type { RouteReport, RouteReports } from '../reports.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { storageReadsOf, type ShellLoadResult } from '../strategies/shell-loader.ts';
import type { MiddlewareOutcome } from './middleware.ts';
import type { PassthroughWait } from './passthrough.ts';

/**
 * What the host is told of an answer (`EdgeHost.observer`), told so that the telling can never
 * touch the answer.
 *
 * The observer is the host's own code, and an observer that throws is the host's to mend: a throw
 * let through would fail an answer already composed, end a request as an exception, or — inside a
 * `try` that guards something else — be taken for that something failing. So each call is made in
 * a `try` of its own, and a throw is logged and goes no further. A `try` costs an answer nothing
 * while the observer keeps to its part.
 */

type Observer = EdgeHost['observer'];

function observe(
  host: Pick<EdgeHost, 'observer'>,
  told: string,
  tell: (observer: Observer) => void,
): void {
  try {
    tell(host.observer);
  } catch (error) {
    logWarn('the host observer threw', {
      told,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One request's measurements, once it has an outcome (`EdgeObserver.metric`). */
export function observeMetric(host: Pick<EdgeHost, 'observer'>, metric: EdgeMetric): void {
  observe(host, 'metric', (observer) => {
    observer.metric(metric);
  });
}

/** Count storage already started, behind the answer, before writing its single delivery point. */
export async function observeMetricAfterRequests(
  host: Pick<EdgeHost, 'observer'>,
  metric: EdgeMetric,
  requests: Promise<number>,
): Promise<void> {
  const spent = await requests;
  observeMetric(host, { ...metric, subrequests: metric.subrequests + spent });
}

/** One request's discarded shell reads; record/member metadata reads keep their existing exclusion. */
export interface AbandonedShellReads {
  readonly ctx: ExecutionContext;
  seen?: WeakSet<Promise<ShellLoadResult>>;
  requests?: Promise<number>;
}

interface ShellAccountingInput {
  readonly edge: EdgeContext;
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome,
    route?: string,
    waited?: PassthroughWait,
  ) => Promise<Response>;
}

/** Install shared accounting only where a speculative shell actually exists, before routing can fail. */
export function withShellAccounting<Input extends ShellAccountingInput>(input: Input): Input {
  if (input.edge.abandonedShells !== undefined) return input;
  const abandonedShells: AbandonedShellReads = { ctx: input.edge.ctx };
  return {
    ...input,
    edge: { ...input.edge, abandonedShells },
    passthrough: (
      reason: string,
      middleware?: MiddlewareOutcome,
      route?: string,
      waited?: PassthroughWait,
    ) => {
      const response = input.passthrough(reason, middleware, route, { ...waited, abandonedShells });
      return response;
    },
  };
}

async function shellRequests(read: Promise<ShellLoadResult>): Promise<number> {
  try {
    return storageReadsOf(await read);
  } catch {
    // A shell load failing after it started is a failed backend read, as storageReadsOf reports.
    return 1;
  }
}

async function combinedRequests(first: Promise<number>, second: Promise<number>): Promise<number> {
  const [one, two] = await Promise.all([first, second]);
  return one + two;
}

/** Keep warming memory and count each discarded shell promise once, including a repeated catch path. */
export function abandonShellRead(
  edge: EdgeContext,
  read: Promise<ShellLoadResult> | undefined,
): void {
  if (read === undefined) return;
  edge.ctx.waitUntil(read);
  const accounting = edge.abandonedShells;
  if (accounting === undefined || accounting.seen?.has(read) === true) return;
  accounting.seen ??= new WeakSet<Promise<ShellLoadResult>>();
  accounting.seen.add(read);
  const requests = shellRequests(read);
  accounting.requests =
    accounting.requests === undefined ? requests : combinedRequests(accounting.requests, requests);
}

/** The final point waits only in the background, after independent detached/static counts compose. */
export function observeRequestMetric(
  edge: Pick<EdgeContext, 'host' | 'ctx' | 'abandonedShells'>,
  metric: EdgeMetric,
  otherRequests?: Promise<number>,
): void {
  const shells = edge.abandonedShells?.requests;
  const requests =
    otherRequests === undefined
      ? shells
      : shells === undefined
        ? otherRequests
        : combinedRequests(shells, otherRequests);
  if (requests === undefined) {
    observeMetric(edge.host, metric);
  } else {
    edge.ctx.waitUntil(observeMetricAfterRequests(edge.host, metric, requests));
  }
}

/** A delivery record read from storage to answer a request (`EdgeObserver.recordServed`). */
export function observeServed(host: Pick<EdgeHost, 'observer'>, bytes: number): void {
  observe(host, 'recordServed', (observer) => {
    observer.recordServed(bytes);
  });
}

/** An image the service transformed for a request (`EdgeObserver.imageTransformed`). */
export function observeTransformed(host: Pick<EdgeHost, 'observer'>): void {
  observe(host, 'imageTransformed', (observer) => {
    observer.imageTransformed();
  });
}

/**
 * A route's report, handed to the host (`RouteReports.report`) as the observer is told: the host's
 * code, in a `try` of its own, so a report that throws can neither fail the answer nor change it —
 * the whole document a missing shell is answered with, a resume let go. What it answers is the
 * delivery, kept alive behind the response by the caller; `undefined` where nothing is sent.
 */
export function sendReport(
  reports: RouteReports | undefined,
  report: RouteReport,
): Promise<void> | undefined {
  try {
    // Keep a host's synchronous opt-out synchronous; delivery alone belongs behind the response.
    // eslint-disable-next-line unicorn/prefer-await
    return reports?.report(report)?.catch((error: unknown) => {
      reportFailed(report, error);
    });
  } catch (error) {
    reportFailed(report, error);
    return undefined;
  }
}

function reportFailed(report: RouteReport, error: unknown): void {
  logWarn('the host reports threw', {
    kind: report.kind,
    detail: error instanceof Error ? error.message : String(error),
  });
}
