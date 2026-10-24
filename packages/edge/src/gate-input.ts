import type { ProjectManifest } from '@stayingupwind/core/manifest';
import type { ForwardingContext } from '@stayingupwind/core/request';

import type { GateInput } from './handlers/gate.ts';
import { gateObservation } from './handlers/observer.ts';
import { headersToClassify } from './handlers/routing-headers.ts';
import type { EdgeMetric } from './observability/metrics.ts';
import type { ManifestRoutingInput } from './preview/pointer-request.ts';

/**
 * What a request of a deployment that declares a gate brings to it (`routeThroughGate`), and the
 * dispatch of its gate, counted once for the request however its routing goes on after.
 */

/** A routing input whose gate's dispatch is counted once for the request (`countedGateInput`). */
export interface GateObservationInput {
  readonly gatePassed?: (() => void) | undefined;
}

export type GateObservedRoutingInput = GateObservationInput & ManifestRoutingInput;

/** How the routing says a request ended where the gate answered it: its route, its outcome. */
export type TerminalObserver = (
  pathname: string,
  outcomeKind: string,
  extra: Partial<EdgeMetric>,
) => void;

/** One request keeps its gate's dispatch even where later routing falls back on a pattern budget. */
export function countedGateInput(input: ManifestRoutingInput): GateObservedRoutingInput {
  if (
    input.state.manifest?.gates === undefined ||
    input.state.validated ||
    (input.request.method !== 'GET' && input.request.method !== 'HEAD')
  )
    return input;
  const observed = gateObservation(input.host);
  return { ...input, host: observed.host, gatePassed: observed.passed };
}

/**
 * What a request of a deployment that declares a gate brings to it (`routeThroughGate`): the
 * request as the classification reads it, what the deployment's state says of its delivery, the
 * isolate's memory of the gates that decide documents alone, and how a terminal answer is observed
 * (`observe`).
 */
export function gateInputOf(
  input: GateObservedRoutingInput,
  manifest: ProjectManifest,
  forwarding: ForwardingContext,
  observe: TerminalObserver,
): GateInput {
  const { request, url, host, state } = input;
  return {
    request,
    url,
    manifest,
    // Read as the classification reads the request (`headersToClassify`), so the route the gate is
    // asked about is the route the request would be served.
    routedHeaders: headersToClassify(manifest, request.headers, host.credentials, forwarding),
    host,
    forwarding,
    validated: state.validated,
    privateDelivery: state.privateDelivery,
    cspReportingPath: state.app === undefined ? undefined : state.cspReportingPath,
    cspNonce: state.cspNonce
      ? { mode: state.cspNonceMode, strictDynamic: state.cspStrictDynamic }
      : undefined,
    now: input.runtime.now,
    documentGates: { memory: input.runtime.memory.documentGates, manifestId: state.manifestId },
    passed: input.gatePassed,
    terminal: (response, route, elapsed, dispatched): void => {
      observe(route ?? url.pathname, `gate-${String(response.status)}`, {
        originFirstByteMs: elapsed,
        subrequests: Number(dispatched),
      });
    },
  };
}
