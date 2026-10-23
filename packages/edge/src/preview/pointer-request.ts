import type { ProjectManifest } from '@stayingupwind/core/manifest';
import type { EdgePointer } from '@stayingupwind/host/delivery';

import type { EdgeBindings } from '../bindings.ts';
import type { EdgeHost } from '../edge-host.ts';
import type { EdgeRuntime } from '../edge-runtime.ts';
import type { IncomingRequest } from '../request-context.ts';
import type { RoutingInput } from '../route.ts';
import type { StaticFileContext } from '../strategies/context.ts';
import { getManifest, getPolicyForPointer, type PolicyLookup } from './manifest.ts';
import { usableManifest } from './pointer.ts';
import { manifestStateFromPointer, policyFromPointer, type PreviewState } from './state.ts';
import { heldBehind, type Lookup, MISSING } from './storage.ts';

/** Routing that can answer before the lookups its response does not need. */
export interface DeferredRoutingInput extends Omit<RoutingInput, 'state'> {
  readonly state: Omit<PreviewState, 'policy'> & { readonly policy: StaticFileContext['policy'] };
  readonly policyReady: () => Promise<RoutingInput>;
  /** The remaining read, for an invalidation of a host's scope other than its deployment id. */
  readonly manifestReady?: Promise<ProjectManifest | undefined>;
}

export type ManifestRoutingInput = RoutingInput | DeferredRoutingInput;

/** The policy and the manifest a pointer names, read side by side (`startReads`). */
export interface PointerReads {
  readonly policyLookup: Promise<PolicyLookup>;
  readonly manifestLookup: Promise<Lookup<ProjectManifest>>;
}

/** The policy and the manifest the pointer names, read together; neither rejects. */
export function startReads(input: {
  readonly env: EdgeBindings;
  readonly ctx: ExecutionContext;
  readonly runtime: EdgeRuntime;
  readonly pointer: EdgePointer;
}): PointerReads {
  const { env, ctx, runtime, pointer } = input;
  return {
    policyLookup: getPolicyForPointer(env, runtime, pointer, heldBehind(ctx)),
    manifestLookup:
      pointer.manifestId === undefined
        ? Promise.resolve(MISSING)
        : getManifest(env, runtime, pointer.manifestId, {
            namedSince: pointer.updatedAt,
            keep: heldBehind(ctx),
          }),
  };
}

/** A request the host has read the pointer for and let through, with what it decided of it. */
export interface PointerRequest {
  readonly request: IncomingRequest;
  readonly url: URL;
  readonly env: EdgeBindings;
  readonly ctx: ExecutionContext;
  readonly runtime: EdgeRuntime;
  readonly host: EdgeHost;
  readonly pointer: EdgePointer;
  /** The host's native handler entry, for cumulative document timings (`RequestTimings`). */
  readonly requestStartedAt?: number | undefined;
  /** How long the pointer's lookup took (`RequestTimings`). */
  readonly pointerMs: number;
  /** What the host says of the project: its responses are for the visitor let through alone. */
  readonly privateDelivery: boolean;
  /** The host's CSP collector path for the deployment, where it has one (`EdgeContext`). */
  readonly cspReportingPath: string | undefined;
  readonly servedAgain?: RoutingInput['servedAgain'];
  readonly observePassthrough?: RoutingInput['observePassthrough'];
}

/**
 * Live traffic: the two KV reads the pointer names, the manifest and the policy, overlap, so a
 * cold isolate pays one round trip for the pair rather than two in series. `reads` are the pair
 * where the host started them already, beside a wait of its own (`startReads`).
 */
export async function servePointerRequest(
  input: PointerRequest,
  serve: (input: ManifestRoutingInput) => Promise<Response>,
  reads?: PointerReads,
): Promise<Response> {
  const { request, url, env, ctx, runtime, host, pointer } = input;
  const manifestStarted = runtime.now();
  const { policyLookup, manifestLookup } = reads ?? startReads(input);
  const answeredPolicy = (async () => {
    const lookup = await policyLookup;
    return { lookup, completedAt: runtime.now() };
  })();
  // A shipped file can leave before this read lands; let it fill memory for later requests.
  ctx.waitUntil(answeredPolicy);
  // A non-read request cannot be answered from a shipped file, image or page. One Worker needs
  // no routing tables to receive it, and runs the application's middleware itself. Keep the read
  // for its response's cache invalidations without putting it before dispatch or the first byte.
  const independent =
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    pointer.app !== undefined &&
    pointer.app.functions === undefined;
  const manifestReady = independent
    ? (async () => {
        const stored = await manifestLookup;
        return usableManifest(pointer, stored.kind === 'found' ? stored.value : undefined);
      })()
    : undefined;
  if (manifestReady !== undefined) {
    ctx.waitUntil(manifestReady);
  }
  const stored = independent ? MISSING : await manifestLookup;
  const manifestMs = runtime.now() - manifestStarted;
  const state = {
    ...manifestStateFromPointer({
      runtime,
      pointer,
      stored,
      pathname: url.pathname,
      privateDelivery: input.privateDelivery,
      cspReportingPath: input.cspReportingPath,
    }),
    // The pointer selected this name. A shipped file uses none of the policy's settings.
    policy: { id: pointer.policyId },
  };
  const timings = {
    requestStartedAt: input.requestStartedAt,
    pointerMs: input.pointerMs,
    manifestMs,
    manifestOnlyMs: manifestMs,
    middlewareMs: undefined,
  };
  let ready: Promise<RoutingInput> | undefined;
  const initial = {
    request,
    url,
    env,
    ctx,
    runtime,
    host,
    state,
    timings,
    servedAgain: input.servedAgain,
    observePassthrough: input.observePassthrough,
  };
  const routing: DeferredRoutingInput = {
    ...initial,
    ...(manifestReady !== undefined && { manifestReady }),
    policyReady: () => {
      ready ??= (async () => {
        const { lookup, completedAt } = await answeredPolicy;
        return {
          ...initial,
          state: { ...state, policy: policyFromPointer(lookup, pointer) },
          // Documents, images and matching middleware still wait on both concurrent reads.
          timings: {
            ...timings,
            prerequisiteMs:
              input.requestStartedAt === undefined
                ? undefined
                : runtime.now() - input.requestStartedAt,
            manifestMs: Math.max(manifestMs, completedAt - manifestStarted),
            policyMs: completedAt - manifestStarted,
          },
        };
      })();
      return ready;
    },
  };
  return serve(routing);
}
