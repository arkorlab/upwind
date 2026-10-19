import type { EdgeHost } from '../edge-host.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import type { RouteReport, RouteReports } from '../reports.ts';

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
