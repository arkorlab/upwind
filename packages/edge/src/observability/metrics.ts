/**
 * What the edge measured of one request: what it was, what it went to, and how long each part of it
 * took. A host is told it once the request has an outcome (`EdgeObserver.metric`) and records it as
 * it chooses; each field says what it is for.
 */
export interface EdgeMetric {
  readonly projectId: string;
  readonly kind: 'document' | 'asset' | 'passthrough' | 'segment' | 'payload' | 'data';
  readonly pathname: string;
  readonly shellStrategy: string;
  readonly shellSource: string;
  readonly outcomeKind: string;
  readonly colo: string;
  readonly originCacheHeader: string;
  readonly manifestId: string;
  readonly policyId: string;
  /**
   * How long the middleware took. Left out — recorded as 0 — where none ran: an asset is answered
   * without one, as is a file or an image whose path the middleware's matchers leave out.
   *
   * The budget it is held to (`policy.middleware.timeoutMs`) is a guess until something measures
   * against it: a cold isolate of a large bundle can come close to it, and the distribution of this
   * is the only thing that tells a budget which is too small from a middleware which has genuinely
   * hung.
   */
  readonly middlewareMs?: number | undefined;
  /**
   * What the application's Worker answered a continuation with, where the splice would not take it.
   *
   * The reason it is here: a deployment can fail on every route with `bad-upstream-response`, which
   * `splice.ts` raises when the answer is not HTML or has no body, and the status says at once
   * whether the Worker had thrown, answered the wrong route or sent the wrong type — where the
   * outcome alone would leave each cause to be ruled out in turn. 0 where there was no bad answer
   * to report.
   */
  readonly upstreamStatus?: number | undefined;
  /**
   * The opening of what the application answered a refused continuation with.
   *
   * A status alone does not say which error an error page reports. Bounded by the splice before it
   * ever reaches here, and empty for every outcome but this one.
   */
  readonly upstreamBody?: string | undefined;
  /**
   * The names of the headers that refused continuation came with, sorted and comma-joined.
   *
   * A body alone may not settle it either: `Internal Server Error` can be both what the runtime's
   * catch answers and what a host's `dispatchApp` answers for a Worker that never ran, and a 500
   * that arrives in under a millisecond is too fast for a render to have failed. The header names
   * tell the two apart, and a rendered error page from either. Names only, never values; empty for
   * every outcome but this one.
   */
  readonly upstreamHeaders?: string | undefined;
  /**
   * How a document went out: its `content-encoding`, with `-live` when it was compressed on the
   * way out rather than from a pre-compressed shell, and `br-br` for a brotli rendering sent under
   * a second layer that compresses its suffix; empty for anything but a document.
   */
  readonly encoding: string;
  /**
   * Which app Worker answered, for a deployment split across several: the bundle's name for it,
   * `app` for the first. Empty for a deployment that was not split, and for a kind that asked no
   * Worker. What a cold start is read per Worker by.
   */
  readonly fn?: string | undefined;
  /**
   * 1 where the Worker first asked answered that the route was another's and the request was sent
   * on: what a table that placed it wrongly cost, one more hop. 0 everywhere else.
   */
  readonly redispatch?: number | undefined;
  /**
   * Which router prefetch a request handed on was, as Next.js's client numbers them in
   * `next-router-prefetch`: `1` static, `2` a link's own (`<Link prefetch>`), `3` an App Shell
   * that needed the session. Empty for a request that was no prefetch — a navigation's — and for
   * every kind but `passthrough`; `other` for a value Next.js does not send.
   *
   * All three reach the application's Function, and the reason they are counted apart: a link
   * whose prefetch carries the page's data wakes it once for each such link on a screen, where an
   * App Shell is once per route, and only this says which of the two a rise in `rsc` is.
   */
  readonly prefetch?: string | undefined;
  readonly ttfbInternalMs: number;
  readonly shellLookupMs: number;
  readonly originFirstByteMs: number;
  readonly originTotalMs: number;
  readonly shellBytes: number;
  readonly suffixBytes: number;
  readonly recovery: number;
  readonly retry: number;
  readonly assetHit: number;
  readonly subrequests: number;
  /**
   * The pointer's lookup, and the manifest's with the policy's beside it (`RequestTimings`); the
   * middleware's is above.
   */
  readonly pointerLookupMs?: number | undefined;
  readonly manifestLookupMs?: number | undefined;
  /** The delivery record's read, served or not (`RecordTiming`). */
  readonly recordLookupMs?: number | undefined;
}
