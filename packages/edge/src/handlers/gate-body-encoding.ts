import type { EdgeGates } from '../edge-host.ts';

/** Gate adapters whose Workers Fetcher supplies automatically decoded response bodies. */
const FETCHED_GATES = new WeakSet<EdgeGates>();

/** The SDK's service-binding adapter, whose fetch uses Workers' automatic response-body mode. */
export function fetchedGateBodies(gates: EdgeGates): EdgeGates {
  FETCHED_GATES.add(gates);
  return gates;
}

/** Exact content codings Workers fetch decodes; deflate and coding lists remain raw. */
export function gateBodyDecodedByFetch(gates: EdgeGates | undefined, encoding: string): boolean {
  return (
    gates !== undefined && FETCHED_GATES.has(gates) && (encoding === 'gzip' || encoding === 'br')
  );
}
