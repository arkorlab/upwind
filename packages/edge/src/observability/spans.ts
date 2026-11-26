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
