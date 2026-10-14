import type { AppRuntime, ProjectManifest } from '@stayingupwind/core/manifest';
import {
  type CspNonceMode,
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  type DeliveryPolicy,
  type EdgePointer,
} from '@stayingupwind/host/delivery';

import type { EdgeRuntime } from '../edge-runtime.ts';
import type { PolicyLookup } from './manifest.ts';
import {
  type DemotedRoutes,
  demotedRoutesOf,
  isSuspect,
  pointerPassthroughReason,
  usableManifest,
} from './pointer.ts';
import type { Lookup } from './storage.ts';

/**
 * What the edge knows about the project for this request, however it came to know it: from the
 * pointer a hostname resolves to (`stateFromPointer`), or from whatever else a host serves by — a
 * candidate it is proving, say. Nothing downstream needs to know which.
 */

export interface PreviewState {
  readonly projectId: string;
  readonly mode: EdgePointer['mode'];
  /** The project handed CSP nonces to the edge, so every document gets one minted here. */
  readonly cspNonce: boolean;
  readonly cspNonceMode: CspNonceMode;
  /** `'strict-dynamic'` goes beside each nonce minted; never without `cspNonce`. */
  readonly cspStrictDynamic: boolean;
  readonly cspReportingPath?: string | undefined;
  /** The project keeps its pages in each data center's Cache API beside KV; see `EdgeContext`. */
  readonly cacheApi: boolean;
  /** What the project serves is for the visitor it was let through to alone; see `EdgeContext`. */
  readonly privateDelivery: boolean;
  readonly manifestId: string;
  readonly manifest: ProjectManifest | undefined;
  /** The Workers the deployment runs as; `undefined` until the first one has activated. */
  readonly app: AppRuntime | undefined;
  readonly policy: DeliveryPolicy;
  readonly originHost: string;
  readonly validated: boolean;
  /** Why requests are proxied when the project is not served from the edge (debug header only). */
  readonly passthroughReason: string;
  /** Routes of the manifest the pointer demotes; `undefined` when it demotes none. */
  readonly demotedRoutes: DemotedRoutes | undefined;
  /**
   * The app Worker a validation probe of a split deployment names: a request the edge hands to the
   * application goes there, whatever the tables say. Only ever from a signed header; a visitor's
   * request has none.
   */
  readonly function?: string | undefined;
}

/**
 * The policy this request is served under.
 *
 * A pointer naming a built-in policy — the default, or one retired, which a pointer written under
 * it names until its project deploys again — resolves to it by design, document or none
 * (`builtinDeliveryPolicy`), so that is the policy that was asked for, not a stand-in. What is a
 * stand-in is a *named* policy the edge could not read: live traffic still gets an answer, but
 * under settings the operator did not choose. Such a request must not leave anything behind. A
 * project that chose passthrough did so because its `/_next/static/` is not the same for everyone,
 * and one momentary KV failure would otherwise put a single visitor's copy in every cache
 * downstream as `immutable`, for a year, where reading the policy again cannot reach it.
 * Passthrough stores nothing. Nor does the stand-in serve from the runtime cache's records
 * (`generations`), which the default turns on: a project may have turned them off, and records read
 * under it would be held, copied into the data center and regenerated under settings nobody chose.
 * The build's shell answers instead.
 */
function policyOf(lookup: PolicyLookup, pointer: EdgePointer): DeliveryPolicy {
  if (lookup.kind === 'found') {
    if (lookup.source === 'exact') {
      return lookup.policy;
    }
    // The built-in the pointer names, which the lookup resolved it to; not a stand-in for another.
    if (lookup.source === 'builtin' && lookup.policy.id === pointer.policyId) {
      return lookup.policy;
    }
  }
  return {
    ...DEFAULT_DELIVERY_POLICY,
    assets: { ...DEFAULT_DELIVERY_POLICY.assets, backend: 'passthrough' },
    runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'off' },
  };
}

/**
 * An application nothing has been deployed to yet: the pointer names no Workers, so there is
 * nowhere to send the request — the only host the edge knows for the project is this very route.
 * The same whichever hostname it came in on.
 */
export function notDeployed(target: { readonly app?: AppRuntime | undefined }): boolean {
  return target.app === undefined;
}

export interface PointerStateInput {
  readonly runtime: EdgeRuntime;
  readonly pointer: EdgePointer;
  readonly stored: Lookup<ProjectManifest>;
  readonly lookup: PolicyLookup;
  readonly pathname: string;
  /** What the host says of the project: its responses are for the visitor let through alone. */
  readonly privateDelivery: boolean;
  /** The host's CSP collector path for the deployment, where it has one (`EdgeContext`). */
  readonly cspReportingPath: string | undefined;
}

export function stateFromPointer(input: PointerStateInput): PreviewState {
  const { runtime, pointer, stored, lookup, pathname, privateDelivery } = input;
  const manifest = usableManifest(pointer, stored.kind === 'found' ? stored.value : undefined);
  const suspect = isSuspect(runtime, pointer, pathname);
  return {
    projectId: pointer.projectId,
    mode: manifest === undefined || suspect ? 'passthrough' : pointer.mode,
    manifestId: pointer.manifestId ?? '',
    manifest,
    app: pointer.app,
    policy: policyOf(lookup, pointer),
    cspNonce: pointer.cspNonce ?? false,
    cspNonceMode: pointer.cspNonce === true ? (pointer.cspNonceMode ?? 'enforce') : 'enforce',
    cspStrictDynamic: pointer.cspNonce === true && pointer.cspStrictDynamic === true,
    cspReportingPath: pointer.app === undefined ? undefined : input.cspReportingPath,
    // Only `false` is written; a pointer that says nothing is a project that has not turned it off.
    cacheApi: pointer.cacheApi !== false,
    privateDelivery,
    originHost: pointer.originHost,
    validated: false,
    passthroughReason: pointerPassthroughReason(pointer, stored, suspect),
    demotedRoutes: demotedRoutesOf(pointer),
  };
}
