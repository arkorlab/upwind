/**
 * What the edge reports of a route as it serves it, for a host to act on: a resume that broke the
 * document it completed, a continuation that failed, a document that recovered. The edge itself
 * acts on the first at once — it stops splitting the route in this isolate — and tells its host, so
 * that the host can demote it on the pointer and stop splitting it everywhere.
 */

/** A resume whose answer the document could not take. */
export type MismatchKind =
  /** The resume set a cookie, which the committed headers could not carry. */
  | 'set-cookie-observed'
  /** The committed shell headers cannot preserve the browser response behavior it asked for. */
  | 'behavioral-header-observed'
  /** The resume closed without sending anything: the route no longer completes its shell. */
  | 'empty-suffix';

/** A continuation that did not complete the document, and why. */
export type ContinuationFailureKind =
  | 'upstream-error'
  | 'timeout'
  /** The continuation ended before `</body></html>`. */
  | 'unterminated'
  | 'bad-upstream-response'
  | 'shell-missing'
  | 'shell-corrupt'
  | 'shell-unavailable';

/** The route a report is about, as the request found it. */
interface RouteRef {
  readonly projectId: string;
  readonly manifestId: string;
  readonly pathname: string;
  readonly colo: string | undefined;
}

export type RouteReport = RouteRef &
  (
    | {
        readonly kind: 'mismatch';
        readonly reason: MismatchKind;
        readonly detail: string | undefined;
      }
    | {
        readonly kind: 'continuation-failure';
        readonly reason: ContinuationFailureKind;
        readonly detail: string | undefined;
      }
    | { readonly kind: 'recovery' }
  );

/**
 * Where reports go. `report` is called where the edge decides, synchronously; what it answers is
 * the delivery, which the edge keeps alive behind the response and never waits for — or nothing,
 * where the host sends nothing for this one (it may count reports rather than send each).
 */
export interface RouteReports {
  report(report: RouteReport): Promise<void> | undefined;
}
