import type { AppRuntime } from '@stayingupwind/core/manifest';
import type { LocaleRequest } from '@stayingupwind/core/paas';
import type { ForwardingContext } from '@stayingupwind/core/request';
import type { CspNonceMode, DeliveryPolicy } from '@stayingupwind/host/delivery';

import type { EdgeBindings } from '../bindings.ts';
import type { EdgeHost } from '../edge-host.ts';
import type { EdgeRuntime } from '../edge-runtime.ts';
import type { AbandonedShellReads } from '../handlers/observer.ts';
import type { DemotedRoutes } from '../preview/pointer.ts';

/**
 * What a request waited on before the document was composed, in milliseconds: the pointer's lookup,
 * the manifest's with the policy's beside it, and the application's middleware. Each is `undefined`
 * where the request made no such wait — a validation request reads the pointer only when its header
 * does not say whether the project mints nonces, and most requests run no middleware — and none of
 * them is a wait of its own: they are the lookups' own times, taken as they finished, and go out on
 * the document's `Server-Timing` and in the metric the edge hands its host (`EdgeObserver.metric`),
 * which records it where it will, or nowhere.
 */
export interface RequestTimings {
  /**
   * The host's native request-handler entry, before pointer/access/manifest reads. Absent where
   * the host supplies no clock boundary; never inferred from the individual lookup durations.
   * Cloudflare's clock advances after I/O, so this excludes isolate/module startup before entry
   * and does not measure CPU. All elapsed intervals can overlap and must not be added.
   */
  readonly requestStartedAt?: number | undefined;
  /** Handler entry until the pointer/access/manifest/policy prerequisites were ready. */
  readonly prerequisiteMs?: number | undefined;
  readonly pointerMs: number | undefined;
  /**
   * The manifest's lookup and the policy's, read side by side and waited on together
   * (`serveFromPointer`) where settings are needed: the policy's can lengthen it. A shipped file
   * with no matching middleware waits only for the manifest.
   */
  readonly manifestMs: number | undefined;
  /** Manifest-only elapsed read, before `manifestMs` also accounts for the parallel policy. */
  readonly manifestOnlyMs?: number | undefined;
  /** Parallel policy read from the same start boundary; `manifestMs` is their maximum. */
  readonly policyMs?: number | undefined;
  readonly middlewareMs: number | undefined;
  /** Native middleware dispatch until its response headers, inside the outer middleware wait. */
  readonly middlewareDispatchMs?: number | undefined;
}

/** Everything a strategy may touch; passed as the generic context of the core strategy contracts. */
export interface EdgeContext {
  readonly env: EdgeBindings;
  readonly ctx: ExecutionContext;
  readonly runtime: EdgeRuntime;
  /** What the host decided for the edge: its names, its credentials, and what it is told. */
  readonly host: EdgeHost;
  readonly forwarding: ForwardingContext;
  /**
   * The Workers the deployment runs as: every request the edge does not answer itself is
   * dispatched to them. `undefined` only before the first deployment has activated, when there is
   * nothing to dispatch to and nothing to serve either.
   */
  readonly app: AppRuntime | undefined;
  /** The URL the client asked for, when a middleware rewrote the request being served. */
  readonly originalUrl: string | undefined;
  /** Original root locale inputs; never reconstructed from middleware-overridden headers. */
  readonly localeRequest?: LocaleRequest | undefined;
  readonly policy: DeliveryPolicy;
  /** The project handed CSP nonces to the edge, so every document gets one minted here. */
  readonly cspNonce: boolean;
  /** Where nonce additions are checked; existing enforcing nonce values always follow the body. */
  readonly cspNonceMode: CspNonceMode;
  /** `'strict-dynamic'` goes beside each nonce minted (`EdgePointer.cspStrictDynamic`). */
  readonly cspStrictDynamic: boolean;
  /** The host's CSP report collector path, where it has one; absent on validation. */
  readonly cspReportingPath?: string | undefined;
  /**
   * The project keeps its pages in this data center's Cache API beside KV (`EdgePointer.cacheApi`):
   * whether a delivery record may be read from, and copied to, the data center's copy. Never for a
   * validation request, which reads no record at all.
   */
  readonly cacheApi: boolean;
  /**
   * Most bytes of an immutable asset the edge will read in order to measure it, from the manifest's
   * own `assetPolicy`. A subrequest carries no `Content-Length`, so this bounds the read rather than
   * a header, which makes it the isolate's memory budget for one asset.
   */
  readonly assetMaxBytes: number;
  readonly projectId: string;
  readonly manifestId: string;
  readonly colo: string | undefined;
  /** This request selected its manifest and policy with a signed validation header. */
  readonly validated: boolean;
  /**
   * Routes the pointer demotes: each is handed to the deployment's Worker whole until the moment
   * it names (`EdgePointer.demotedRoutes`). `undefined` when there are none, and always for a
   * validation request, which proves a candidate whole.
   */
  readonly demotedRoutes: DemotedRoutes | undefined;
  /**
   * What the project serves is for the visitor it was let through to alone, as the host says of the
   * project: kept by no browser, even a document every visitor is served alike
   * (`documentCacheControl`).
   */
  readonly privateDelivery: boolean;
  readonly timings: RequestTimings;
  /** Shared only when a speculative document shell can be discarded; never awaited before the response. */
  readonly abandonedShells?: AbandonedShellReads | undefined;
  /**
   * The request routed again from the pointer KV holds now, for a dispatch the edge makes itself
   * that finds the Workers it was sent to gone (`RoutingInput.servedAgain`): a foreground
   * regeneration's, as a passthrough's. Absent where there is no second try.
   */
  readonly whenGone?: (() => Promise<Response | undefined>) | undefined;
}

/**
 * A shipped file needs the policy's selected name for its account, but none of its settings.
 * Its middleware, if any, receives a full context only after that policy has been read.
 */
export type StaticFileContext = Omit<EdgeContext, 'policy'> & {
  readonly policy: Pick<DeliveryPolicy, 'id'>;
};
