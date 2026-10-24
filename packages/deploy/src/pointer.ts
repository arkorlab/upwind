import type { DeploymentFingerprint } from '@stayingupwind/core/deployment';
import type { AppRuntime } from '@stayingupwind/core/manifest';
import type { CspNonceMode, EdgePointer } from '@stayingupwind/host/delivery';

/** What an edge pointer serves: a deployment's manifest under its delivery policy, and its runtime. */
export interface EdgePointerPayload {
  readonly fingerprint: DeploymentFingerprint;
  readonly manifestId: string;
  /** Whether the manifest this pointer names declares at least one route gate. */
  readonly requiresGate?: boolean | undefined;
  readonly policyId: string;
  /** The deployment's Functions; absent for a site whose pointer sends requests to an origin. */
  readonly app?: AppRuntime | undefined;
  readonly cspNonce: boolean;
  readonly cspNonceMode?: CspNonceMode | undefined;
  readonly cspStrictDynamic?: boolean | undefined;
}

/** The site a pointer is for: what the edge reads its deployment's manifest and origin by. */
export interface PointerSite {
  readonly projectId: string;
  readonly originHost: string;
}

/**
 * A pointer's share of a site's nonce setting: nothing while off, and only what is not the default
 * while on. One fact has one representation, so a site that never opted in and one that opted out
 * carry the same pointer — and the keyword is never written without the nonce it is beside.
 */
export function cspNoncePointerFields(
  enabled: boolean,
  mode: CspNonceMode | undefined,
  strictDynamic: boolean | undefined,
): Pick<EdgePointer, 'cspNonce' | 'cspNonceMode' | 'cspStrictDynamic'> {
  if (!enabled) {
    return {};
  }
  return {
    cspNonce: true,
    ...(mode === 'report-only' && { cspNonceMode: mode }),
    ...(strictDynamic === true && { cspStrictDynamic: true }),
  };
}

/**
 * The pointer that has the edge serve a site from `payload`'s manifest. The nonce's mode is named
 * only where it is not the one a pointer without it means, so a pointer that enforces says nothing
 * more than one written before modes existed. Its fields are in the order the pointer's schema
 * writes them (`edgePointerSchema`), so one stored as it is handed back is the bytes one stored
 * from a parse of it would be.
 */
export function edgePointerOf(
  site: PointerSite,
  payload: EdgePointerPayload,
  now: number,
): Omit<EdgePointer, 'selectedPolicy'> {
  return {
    v: 1,
    projectId: site.projectId,
    originHost: site.originHost,
    mode: 'edge',
    manifestId: payload.manifestId,
    ...(payload.requiresGate === true && { requiresGate: true }),
    policyId: payload.policyId,
    deployment: payload.fingerprint,
    ...cspNoncePointerFields(payload.cspNonce, payload.cspNonceMode, payload.cspStrictDynamic),
    ...(payload.app !== undefined && { app: payload.app }),
    // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
    updatedAt: new Date(now).toISOString(),
  };
}
