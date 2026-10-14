import type { EdgeHost } from '../edge-host.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeMetric } from '../observability/metrics.ts';

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
