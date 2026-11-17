import type { TerminalObserver } from './gate-input.ts';
import { observeTerminal } from './handlers/observer.ts';
import { serviceUnavailableResponse } from './handlers/responses.ts';
import type { EdgeMetric } from './observability/metrics.ts';
import type { ManifestRoutingInput } from './preview/pointer-request.ts';
import { coloOf } from './request-context.ts';

/**
 * How routing says a request ended at the edge, answered by nothing past it — no Function, and no
 * gate that let it through — with the same context of the request each time.
 */

/** The same request context accompanies every terminal routing outcome. */
export function observeTerminalFor(
  input: ManifestRoutingInput,
  pathname: string,
  outcomeKind: string,
  extra?: Partial<EdgeMetric>,
): void {
  const { request, state } = input;
  observeTerminal(input.host, {
    projectId: state.projectId,
    pathname,
    outcomeKind,
    colo: coloOf(request) ?? '',
    manifestId: state.manifestId,
    policyId: state.policy.id,
    pointerLookupMs: input.timings.pointerMs,
    manifestLookupMs: input.timings.manifestMs,
    ...extra,
  });
}

/** How a request's gate says it ended where the gate answered it (`gateInputOf`). */
export function terminalObserver(input: ManifestRoutingInput): TerminalObserver {
  return (pathname, outcome, extra) => {
    observeTerminalFor(input, pathname, outcome, extra);
  };
}

/** The edge's answer that it has nowhere to send the request, for `reason`, said as it ends. */
export function answeredUnavailable(
  input: ManifestRoutingInput,
  reason: string,
): Promise<Response> {
  observeTerminalFor(input, input.url.pathname, reason);
  return Promise.resolve(serviceUnavailableResponse(reason));
}
