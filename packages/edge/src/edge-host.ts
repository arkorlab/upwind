import type { ScopeSignals } from '@stayingupwind/host/cache';
import type { HostCredentials } from '@stayingupwind/host/credentials';

import type { EdgeMetric } from './observability/metrics.ts';

/**
 * Names the edge keeps things under between requests, which are the host's to choose. Each keys
 * what a data center holds, so a host keeps its names as they are: a new one is a cold cache in
 * every data center at once.
 */
interface EdgeNames {
  /**
   * The host the Cache API keys of shells and of delivery-record copies are made under. Never a
   * hostname a site is served on, so no request can be answered with one of those entries.
   */
  readonly cacheKeyHost: string;
  /** The Cache API cache an admitted immutable asset is kept in. */
  readonly assetCache: string;
  /** The Cache API cache a transformed image is kept in, and the origin its keys are made under. */
  readonly imageCache: string;
  readonly imageKeyOrigin: string;
  /** The Cache API cache a data center's copy of a delivery record is kept in. */
  readonly recordCache: string;
  /**
   * The Cache API cache a data center's copy of where a scope stands is kept in
   * (`cache/scope-signal.ts`).
   */
  readonly signalCache: string;
}

/**
 * Where the edge asks what moved in a scope (`cache/scope-signal.ts`): the authority's answer
 * (`ScopeSignals`), and the tag the host purges the data centers' copies of it by, where it does.
 */
export interface ScopeSignalSource {
  scopeSignals(scopeId: string, since: number | null): Promise<ScopeSignals>;
  /** The `Cache-Tag` a copy of the scope's signals is kept under, for the host's purges. */
  cacheTagOf(scopeId: string): string;
}

/**
 * What the edge tells its host as it goes. Every call is made on the way to, or right after, a
 * response, so each is synchronous and none is awaited: it may record, and not wait.
 */
interface EdgeObserver {
  /** One request's measurements, once it has an outcome. */
  metric(metric: EdgeMetric): void;
  /** A delivery record read from storage to answer a request, by its bytes; one held is not. */
  recordServed(bytes: number): void;
  /** An image the Images binding transformed for a request; one answered from the cache is not. */
  imageTransformed(): void;
}

/** What a host decides for the edge: fixed for an environment, read on every request. */
export interface EdgeHost {
  readonly names: EdgeNames;
  /**
   * The domain the sites are served under, as one forwarded request is told it: a cookie a
   * Function sets for it, rather than for the site's own hostname, is not passed on to the visitor.
   */
  readonly sharedDomain: string;
  /** The domains the host answers on itself: an image source under one is never fetched. */
  readonly ownDomains: readonly string[];
  /**
   * Hostnames the host answers on itself, each as it is, and not the names beneath it, which may
   * be served from elsewhere: an image source on one is never fetched either. None, absent.
   */
  readonly ownHostnames?: readonly string[] | undefined;
  readonly credentials: HostCredentials;
  /**
   * Whether a dispatch failed because the Function it named no longer exists — a deployment
   * retired while a request still named it — rather than for any reason of its own.
   */
  readonly functionGone: (error: unknown) => boolean;
  readonly observer: EdgeObserver;
  /**
   * Where the edge asks what moved in a scope, so an invalidation reaches every isolate it serves
   * the scope from within a moment — and the Functions behind it, told where the scope stands
   * (`SCOPE_REVISION_HEADER`). Absent, an isolate hears of an invalidation through what it reads,
   * as before.
   */
  readonly scopeSignals?: ScopeSignalSource | undefined;
  /**
   * Looks up a delivery record newer than the supplied afterRevision at the authority; zero
   * requests initial discovery when no record is held. Background checks can overlap response
   * preparation. Optional for hosts whose records
   * reach the edge only through KV. Ordinary fresh
   * generation delivery never calls it. Partial-fallback completions also check on their hold
   * cadence to observe newer generations and invalidations while the held record remains fresh.
   * Returned bytes are held to their identity, digests and revision before use.
   */
  readonly currentRecord?:
    | ((
        scopeId: string,
        entryId: string,
        afterRevision: number,
      ) => Promise<ArrayBuffer | undefined>)
    | undefined;
}
