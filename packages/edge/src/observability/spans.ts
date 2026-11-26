import type { EdgeRuntime } from '../edge-runtime.ts';

type DeliverySpan =
  | 'edge.asset'
  | 'edge.cache_record'
  | 'edge.image'
  | 'edge.manifest'
  | 'edge.middleware'
  | 'edge.passthrough'
  | 'edge.policy'
  | 'edge.route_gate'
  | 'edge.shell'
  | 'edge.static_file';

/** Start the operation in the active span, retaining synchronous entry and streaming results. */
export function inEdgeSpan<T>(
  runtime: Pick<EdgeRuntime, 'tracing'>,
  name: DeliverySpan,
  operation: () => T,
): T {
  return runtime.tracing === undefined ? operation() : runtime.tracing.enterSpan(name, operation);
}

/** Binding calls expose their own promise to callers that account for pending dispatches. */
export function inDispatchSpan(
  tracing: NonNullable<EdgeRuntime['tracing']>,
  name: 'edge.dispatch' | 'edge.resume',
  dispatch: () => Promise<Response>,
): Promise<Response> {
  return tracing.startActiveSpan(name, (span) => {
    let answer: Promise<Response>;
    // A binding can throw synchronously before returning its promise.
    // eslint-disable-next-line sonarjs/no-try-promise
    try {
      answer = dispatch();
    } catch (error) {
      span.end();
      throw error;
    }
    // Observe settlement alongside the caller. Returning the chained promise here adds a hop
    // before response headers and loses the host's original promise identity.
    if (span.isTraced) {
      const end = (): void => {
        span.end();
      };
      // Both outcomes close the same span in one reaction.
      // eslint-disable-next-line unicorn/prefer-then-catch
      void answer.then(end, end);
    } else {
      span.end();
    }
    return answer;
  });
}
