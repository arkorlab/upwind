import { PRIMARY_FUNCTION } from '@stayingupwind/core/bundle';
import type { SpliceOutcome } from '@stayingupwind/host/splice';

import { routeSuspectKey } from '../memory/caches.ts';
import type { ContinuationFailureKind, MismatchKind, RouteReport } from '../reports.ts';
import { encodingMarker, type ShellDelivery } from './document-headers.ts';
import type { DocumentInput } from './document.ts';
import type { Dispatched } from './upstream.ts';

/** What a document's splice outcome means for the project: the reports made and the metric written. */

/** Every mismatch the splice reports as an outcome kind; `empty-suffix` is derived below. */
type SpliceMismatchKind = Exclude<MismatchKind, 'empty-suffix'>;
type FailureKind = Extract<
  ContinuationFailureKind,
  'upstream-error' | 'timeout' | 'unterminated' | 'bad-upstream-response'
>;

const SET_COOKIE_OBSERVED = 'set-cookie-observed';
const EMPTY_SUFFIX: MismatchKind = 'empty-suffix';
const BEHAVIORAL_HEADER_OBSERVED = 'behavioral-header-observed';
const MISMATCH_KINDS: ReadonlySet<string> = new Set<SpliceMismatchKind>([
  BEHAVIORAL_HEADER_OBSERVED,
  // A cookie the resume set is already lost: the headers went out before the render began, so the
  // app's own login or CSRF token silently fails to stick. That is a correctness break, not a slow
  // response, so the route is condemned and the next request for it goes to the Worker instead.
  SET_COOKIE_OBSERVED,
]);
/** Named once: the outcome is matched in three places now that its status is recorded too. */
const BAD_UPSTREAM = 'bad-upstream-response';
const FAILURE_KINDS: ReadonlySet<string> = new Set<FailureKind>([
  BAD_UPSTREAM,
  'timeout',
  'unterminated',
  'upstream-error',
]);

function isMismatchKind(kind: SpliceOutcome['kind']): kind is SpliceMismatchKind {
  return MISMATCH_KINDS.has(kind);
}

/**
 * A resume that sends nothing at all has stopped completing its shell. Told apart from one that
 * was interrupted part way, which is a failure of this request rather than of the route.
 */
function mismatchFor(outcome: SpliceOutcome): MismatchKind | undefined {
  if (outcome.kind === 'unterminated') {
    return outcome.receivedSuffixBytes === 0 ? EMPTY_SUFFIX : undefined;
  }
  return isMismatchKind(outcome.kind) ? outcome.kind : undefined;
}

function isFailureKind(kind: SpliceOutcome['kind']): kind is FailureKind {
  return FAILURE_KINDS.has(kind);
}

function wasRecovered(outcome: SpliceOutcome): boolean {
  return 'recovered' in outcome && outcome.recovered;
}

function outcomeDetail(outcome: SpliceOutcome): string | undefined {
  switch (outcome.kind) {
    case 'upstream-error': {
      return outcome.detail;
    }
    case 'unterminated': {
      return `forwarded ${outcome.forwarded}`;
    }
    case BAD_UPSTREAM: {
      return `status ${outcome.status}`;
    }
    case 'timeout': {
      return outcome.phase;
    }
    case BEHAVIORAL_HEADER_OBSERVED: {
      return outcome.header;
    }
    case SET_COOKIE_OBSERVED: {
      return outcome.names.join(',');
    }
    case 'client-cancelled':
    case 'ok': {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
}

export interface OutcomeReport {
  readonly input: DocumentInput;
  readonly outcome: SpliceOutcome;
  readonly shell: ShellDelivery;
  /** Requests the resume made: one, or none for a document complete in itself. */
  readonly subrequests: number;
  /** A `HEAD`, answered with the document's headers alone: recorded as `head`, nothing sent. */
  readonly head?: boolean | undefined;
  /** Where the resume went, for a deployment split across app Workers (`dispatchedSoFar`). */
  readonly dispatched?: Dispatched | undefined;
}

/**
 * The reports a document's outcome makes, handed to the host (`RouteReports`): the delivery of
 * each it sends, kept behind the response and never waited on before it.
 */
function collectReports(report: OutcomeReport): Promise<void>[] {
  const { input, outcome } = report;
  const { edge, entry } = input;
  // Shadow candidates share the active manifest during policy validation. Their failures must
  // remain validation results, without condemning the live manifest or its routes.
  if (edge.validated) {
    return [];
  }
  const route = {
    projectId: edge.projectId,
    manifestId: edge.manifestId,
    pathname: entry.pathname,
    colo: edge.colo,
  };
  const work: Promise<void>[] = [];
  const send = (made: RouteReport): void => {
    const sent = edge.runtime.reports?.report(made);
    if (sent !== undefined) {
      work.push(sent);
    }
  };
  const mismatch = mismatchFor(outcome);
  if (mismatch !== undefined) {
    // Every kind condemns the route, never the manifest: a cookie or a browser behavior belongs to
    // the route that asked for it, and a resume that sent nothing failed this route's document.
    // Whether the manifest is at fault is the host's to judge, from more than one report.
    const key = routeSuspectKey(edge.projectId, edge.manifestId, entry.pathname);
    edge.runtime.memory.suspects.set(key, true);
    // The route's report is what lets the host stop splitting it everywhere.
    send({ ...route, kind: 'mismatch', reason: mismatch, detail: outcomeDetail(outcome) });
  }
  // Not exclusive of the above: an empty suffix is both the reason to condemn the route and a
  // continuation that did not complete, which a host may count among the route's failures.
  if (isFailureKind(outcome.kind)) {
    send({
      ...route,
      kind: 'continuation-failure',
      reason: outcome.kind,
      detail: outcomeDetail(outcome),
    });
  }
  if (wasRecovered(outcome)) {
    send({ ...route, kind: 'recovery' });
  }
  return work;
}

/** The app Worker a split deployment's document asked, as the metric names it. */
function workerOf(report: OutcomeReport): string | undefined {
  const { edge, entry } = report.input;
  if (report.subrequests === 0 || edge.app?.functions === undefined) {
    return undefined;
  }
  return report.dispatched?.fn ?? entry.function ?? PRIMARY_FUNCTION;
}

export async function reportOutcome(report: OutcomeReport): Promise<void> {
  const { edge, entry, resolved } = report.input;
  const { outcome } = report;
  const work = collectReports(report);
  const record = report.input.generation ?? report.input.recordRead;
  edge.host.observer.metric({
    projectId: edge.projectId,
    kind: 'document',
    pathname: entry.pathname,
    shellStrategy: resolved.shell.id,
    shellSource: report.shell.source,
    outcomeKind: report.head === true ? 'head' : outcome.kind,
    upstreamStatus: outcome.kind === BAD_UPSTREAM ? outcome.status : undefined,
    upstreamBody: outcome.kind === BAD_UPSTREAM ? outcome.body : undefined,
    upstreamHeaders: outcome.kind === BAD_UPSTREAM ? outcome.headers : undefined,
    colo: edge.colo ?? '',
    originCacheHeader: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    encoding: encodingMarker(report.shell),
    // The Worker that answered the resume, where the deployment was split across several: the
    // one its route names, unless that one named another. None for a document the edge served
    // whole, which asked no Worker.
    fn: workerOf(report),
    redispatch: report.dispatched?.redispatched === true ? 1 : 0,
    ttfbInternalMs: report.shell.lookupMs,
    shellLookupMs: report.shell.lookupMs,
    originFirstByteMs: outcome.kind === 'ok' ? outcome.originFirstByteMs : 0,
    originTotalMs: outcome.kind === 'ok' ? outcome.totalMs : 0,
    // The bytes that went out first: a record's own where the document came from one, which a
    // regeneration made a size of its own, and a member's record has no build shell to measure by.
    shellBytes:
      report.head === true
        ? 0
        : (report.input.generation?.pack.header.htmlLength ?? entry.shell.byteLength),
    suffixBytes: outcome.kind === 'ok' ? outcome.suffixBytes : 0,
    recovery: wasRecovered(outcome) ? 1 : 0,
    retry: 0,
    assetHit: 0,
    subrequests: report.subrequests + (report.dispatched?.redispatched === true ? 1 : 0),
    pointerLookupMs: edge.timings.pointerMs,
    manifestLookupMs: edge.timings.manifestMs,
    // The same number the document's `Server-Timing` names `mw` (`document-headers.ts`): taken
    // around the run in `hosted-document.ts`, not off the outcome, so the header and the metric
    // cannot drift apart.
    middlewareMs: edge.timings.middlewareMs,
    recordLookupMs: record?.lookupMs,
  });
  await Promise.all(work);
}
