import { isReserved, type RouteEntry } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import {
  BYPASS_QUERY_KEYS,
  BYPASS_QUERY_PREFIXES,
  bypassForHolds,
  dataRequestHeaders,
  DEPLOYMENT_ID_QUERY,
  DEPLOYMENT_ID_REQUEST_HEADER,
  hasBypassCookie,
  INTERNAL_REQUEST_HEADERS,
  NEXT_DATA_HEADER,
  NEXT_RESUME_HEADER,
  NEXT_RESUME_STATE_LENGTH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  parseCookieHeader,
  RSC_CACHE_BUSTING_QUERY,
  RSC_HEADER,
  SKEW_PROTECTION_COOKIE,
  wantsBlockingMetadata,
} from '@stayingupwind/core/request';
import { runtimeCacheOf } from '@stayingupwind/host/delivery';

import {
  type CheckedStack,
  type KeptMiddlewareResult,
  EDGE_HEADER,
  failed,
  keptFailure,
  middlewareCovers,
  skipped,
  unrunFailure,
  type Verdict,
  edgeReads,
} from './answers.ts';
import {
  bypassedVerdict,
  claimedAsLeft,
  landingOf,
  type SentRequest,
  unprovedVerdict,
} from './landings.ts';
import type { Part, PartKind } from './part-marks.ts';
import type { Reading } from './reading.ts';

/**
 * A part of a route the edge handed on to the Function rather than answer it (`part-verdicts.ts`):
 * for a reason it gives that kind of part, which holds for the request — the application's then —
 * as the edge gives each (`hosted-parts.ts`, `hosted-document.ts`, `classifyRequest` in the edge).
 */

/**
 * Whether Next.js renders a part's request itself, which the edge hands on (`bypassed` in the edge):
 * a draft mode's cookie stands, or its route's `bypassFor` holds for the request as the middleware
 * left it.
 */
export function bypassedFor(
  stack: CheckedStack,
  part: Part,
  read: {
    readonly decided: MiddlewareResult | undefined;
    readonly asked: Readonly<Record<string, string>>;
  },
): boolean {
  const { decided } = read;
  const left =
    decided?.kind === 'continue'
      ? { url: decided.url, headers: decided.requestHeaders }
      : { url: part.url, headers: edgeReads(read.asked) };
  return (
    hasBypassCookie(left.headers) ||
    bypassForHolds(part.route, left.url, left.headers, stack.manifest)
  );
}

/** Why a part asked for is the application's to answer, and judged no further. */
export const APPLICATIONS =
  "the application's: its middleware answered or moved it, or the Function did";
/**
 * What the edge says of a part it handed on only once the middleware covering the request ran
 * (`routeHostedDocument`): for want of the part, or of a route, or for its route's `bypassFor`, or
 * as its route is off the edge. Any other it hands on before, and the Function runs the middleware
 * itself — a page's props among them (`pages-data`).
 */
const HANDED_ON_PAST_MIDDLEWARE =
  /^passthrough;reason=(?:segment-prefetch|rsc-payload|bypass-for|demoted|suspect)(?:;|$)/u;

/** What the edge says of a request it handed on for want of a route: a navigation's alone. */
const UNPROVED = /^passthrough;reason=route-not-proved(?:;|$)/u;
/** Document handoffs that require a captured middleware decision before judging their reason. */
export const DOCUMENT_HANDOFFS =
  /^passthrough;reason=(?:route-not-proved|bypass-for|rewrite-status)(?:;|$)/u;
/** What the edge says of a request it hands on as the middleware failed, before the cause. */
const MIDDLEWARE_FAILED = 'middleware-failed';
/** Why the edge hands any part on, as its account says: its route's state, or a pattern's cost. */
const ANY_PART_HANDOFFS = ['bypass-for', 'demoted', 'suspect', 'pattern-budget'];
/**
 * Why the edge hands a part on that no part of this stack's is handed on for, in a verdict's words
 * — as no document of it is (`documents.ts`): its route demoted, which the pointer the stack
 * publishes says of none (`deployBundle`); its route condemned in the edge's isolate, which only a
 * document's outcome the edge took for a mismatch does (`collectReports`); a pattern of the
 * application's too costly to run against the request, which the check cannot run as the edge does
 * (`budgetPatterns` bounds every test in an isolate for good).
 */
const OFF_THE_EDGE: Readonly<Record<string, string>> = {
  demoted: "as its route is demoted, though the stack's pointer demotes none",
  suspect:
    'as its route is condemned in the isolate, for a mismatch the edge met in a document of it',
  'pattern-budget':
    "for a pattern of the application's too costly to run against the request, as a document so handed on fails",
};
/**
 * What the edge says of a request of the router's it turns away before any route, in a verdict's
 * words (`classifyRequest`, `pinOf`): a segment prefetch's alone, as a payload and props are taken
 * for no part of a page first (`rsc`, `next-internal`).
 */
const TURNED_AWAY: Readonly<Record<string, string>> = {
  'internal-header': 'a header only a platform sends',
  'bypass-cookie': "a draft mode's cookie",
  'vdpl-mismatch': 'a cookie that pins another deployment',
  'bypass-query': 'a query key that asks for another answer',
  'dpl-mismatch': 'another deployment, named in its query or by the router',
};
/**
 * Why the edge hands each kind of part on, as its account says, each a reason it gives one
 * (`hosted-parts.ts`, `hosted-document.ts`, `classifyRequest` in the edge): for want of the part or
 * of a route (`segment-prefetch`, `rsc-payload`, `pages-data`); a router's request it turns away
 * (`TURNED_AWAY`) or takes for no part (`rsc`, `next-internal`, `generalHandoffFailure`); the
 * middleware failing, which a page's props it hands on ahead of; its route's `bypassFor`, its route
 * off the edge, or a pattern too costly to run (`ANY_PART_HANDOFFS`).
 */
const HANDOFFS: Readonly<Record<PartKind, ReadonlySet<string>>> = {
  segment: new Set([
    MIDDLEWARE_FAILED,
    'segment-prefetch',
    ...Object.keys(TURNED_AWAY),
    ...ANY_PART_HANDOFFS,
  ]),
  payload: new Set([MIDDLEWARE_FAILED, 'rsc', 'rsc-payload', ...ANY_PART_HANDOFFS]),
  data: new Set(['next-internal', 'pages-data', ...ANY_PART_HANDOFFS]),
};

/**
 * The headers a router's request is turned away for, but the deployment it names, which only a
 * platform sends, by name or by prefix (`hasInternalDocumentHeader` in the edge).
 */
const PLATFORMS_HEADERS = new Set([
  NEXT_RESUME_HEADER,
  NEXT_RESUME_STATE_LENGTH_HEADER,
  ...INTERNAL_REQUEST_HEADERS.filter((name) => name !== 'host' && name !== 'x-real-ip'),
]);
const PLATFORMS_PREFIXES = ['x-middleware-', 'x-prerender-'];

/**
 * Whether a router's request carries a header only a platform sends (`PLATFORMS_HEADERS`) — but,
 * on a request for a page's props, the mark the Pages Router puts on every one (`x-nextjs-data`).
 */
function platformsHeaderOn(headers: Headers, props: boolean): boolean {
  for (const name of headers.keys()) {
    if (props && name === NEXT_DATA_HEADER) {
      continue;
    }
    if (PLATFORMS_HEADERS.has(name) || PLATFORMS_PREFIXES.some((p) => name.startsWith(p))) {
      return true;
    }
  }
  return false;
}

/**
 * What a router's request asks for that the deployment may not hold, as the edge reads it in
 * order (`classifyByPins` in the edge) — a draft mode's cookie, a pin to another deployment's, a
 * query key that asks for another answer, another deployment named in its query or by the router —
 * by the reason the edge hands it on for, or none.
 */
function pinOf(stack: CheckedStack, url: URL, headers: Headers): string | undefined {
  if (hasBypassCookie(headers)) {
    return 'bypass-cookie';
  }
  const deployed = stack.manifest.deployment.dplId;
  const pairs = parseCookieHeader(headers.get('cookie'));
  if (pairs.some(({ name, value }) => name === SKEW_PROTECTION_COOKIE && value !== deployed)) {
    return 'vdpl-mismatch';
  }
  const query = url.searchParams;
  const keys = [...query.keys()];
  const bypassing =
    (query.has(RSC_CACHE_BUSTING_QUERY) && headers.get(RSC_HEADER) !== '1') ||
    BYPASS_QUERY_KEYS.some((key) => query.has(key)) ||
    keys.some((key) => BYPASS_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix)));
  if (bypassing) {
    return 'bypass-query';
  }
  const named = headers.get(DEPLOYMENT_ID_REQUEST_HEADER);
  const elsewhere =
    query.getAll(DEPLOYMENT_ID_QUERY).some((value) => value !== deployed) ||
    (named !== null && named !== deployed);
  return elsewhere ? 'dpl-mismatch' : undefined;
}

/**
 * Why the edge turns a router's request away before any route, as it reads one in order
 * (`classifyRequest`): a header only a platform sends, and then what it asks for that the
 * deployment may not hold (`pinOf`) — or none.
 */
function turnedAwayFor(
  stack: CheckedStack,
  url: URL,
  read: { readonly headers: Headers; readonly props: boolean },
): string | undefined {
  return platformsHeaderOn(read.headers, read.props)
    ? 'internal-header'
    : pinOf(stack, url, read.headers);
}

/** Why the edge says it handed a request on (`passthrough;reason=…`). */
function handoffReasonOf(answered: string): string {
  return (answered.split(';', 2)[1] ?? '').slice('reason='.length);
}

/** A part's request the edge handed on, as the check read it. */
interface HandedOn {
  /** What the edge's account says (`x-arkor-edge`). */
  readonly answered: string;
  /** What the middleware decided for the request, where the stack kept it. */
  readonly decided: KeptMiddlewareResult | undefined;
  /** Whether a matcher of the build covers the request, which the edge runs the middleware for. */
  readonly covered: boolean;
  /** The headers it was asked with. */
  readonly asked: Readonly<Record<string, string>>;
}

/**
 * Why a segment prefetch the edge says it turned away before any route (`TURNED_AWAY`) should not
 * have been: the request carries nothing it turns one away for, or another thing than it says.
 */
function turnedAwayFailure(
  stack: CheckedStack,
  part: Part,
  read: { readonly reason: string; readonly asked: Headers },
): string | undefined {
  const { reason } = read;
  const given = turnedAwayFor(stack, part.url, { headers: read.asked, props: false });
  if (given === reason) {
    return undefined;
  }
  const said = `turned away for ${TURNED_AWAY[reason] ?? reason}`;
  return given === undefined
    ? `${said}, though the request carries nothing the edge turns one away for`
    : `${said}, though the edge turns the request away for ${TURNED_AWAY[given] ?? given}`;
}

/**
 * Why a part the edge took for no part of a page (`rsc`, `next-internal`), or turned away before any
 * route (`TURNED_AWAY`), should have been answered as one (`classifyRequest`): a page's whole
 * payload is taken for none only where its route holds neither the payload nor a record it could
 * compose one from, the request is turned away (`turnedAwayFor`), or a rule claims it as it was
 * sent (`payloadRequest`); a page's props, where its route holds none, the request is turned away —
 * a prefetch that tells the middleware so among them — or a rule claims it (`pagesDataRequest`); a
 * segment prefetch is turned away for what the request carries.
 */
function generalHandoffFailure(
  stack: CheckedStack,
  part: Part,
  read: HandedOn & { readonly reason: string },
): string | undefined {
  const { manifest } = stack;
  const { route, url } = part;
  const asked = edgeReads(read.asked);
  switch (read.reason) {
    case 'bypass-for': {
      return bypassHandoffFailure(stack, part, read);
    }
    case MIDDLEWARE_FAILED: {
      return failedMiddlewareFailure(read);
    }
    case 'segment-prefetch':
    case 'rsc-payload':
    case 'pages-data': {
      return unheldHandoffFailure(stack, part, read);
    }
    case 'rsc': {
      const generic =
        (route.payload === undefined &&
          (manifest.cache === undefined || route.cache?.kind !== 'app-page')) ||
        turnedAwayFor(stack, url, { headers: asked, props: false }) !== undefined ||
        isReserved(manifest, url, asked, true);
      return generic
        ? undefined
        : 'taken for no part of a page, though its route holds its whole payload, nothing turns the request away, and no rule claims it';
    }
    case 'next-internal': {
      const generic =
        route.pagesData === undefined ||
        turnedAwayFor(stack, url, { headers: asked, props: true }) !== undefined ||
        isReserved(manifest, url, dataRequestHeaders(asked), true);
      return generic
        ? undefined
        : "taken for no page's props, though its route holds them, nothing turns the request away, and no rule claims it";
    }
    default: {
      if (Object.hasOwn(OFF_THE_EDGE, read.reason)) {
        return OFF_THE_EDGE[read.reason];
      }
      return Object.hasOwn(TURNED_AWAY, read.reason)
        ? turnedAwayFailure(stack, part, { reason: read.reason, asked })
        : undefined;
    }
  }
}

/**
 * Why a part handed on as the middleware failed should not have been (`runMiddlewareIn` in the
 * edge): no matcher of the build covers the request, so the edge ran no middleware to fail; or the
 * stack kept what the middleware answered, which a run that threw, or reached none, leaves it nothing
 * of — but a run that outran its time, whose answer may come after the edge stopped waiting.
 */
function failedMiddlewareFailure(read: HandedOn): string | undefined {
  if (!read.covered) {
    return 'as the middleware failed, though no matcher of the build covers the request';
  }
  const timedOut = read.answered.split(';').includes('cause=timeout');
  return timedOut || read.decided === undefined
    ? undefined
    : 'as the middleware failed, though the stack kept what it answered';
}

/**
 * Whether the edge may answer a part of `route` from a generation the runtime rendered since: where
 * the deployment has a runtime cache the route has a record in, and the stack's policy serves from
 * records (`generationKeyOf` in the edge). Else it answers one from what the build wrote alone.
 */
export function generationsServed(stack: CheckedStack, route: RouteEntry): boolean {
  return (
    stack.manifest.cache !== undefined &&
    route.cache !== undefined &&
    runtimeCacheOf(stack.policy).generations === 'on'
  );
}

/**
 * Whether the request for a part, as the middleware left it, still asks for the part (`composeSegment`,
 * `composePayload` in the edge): a segment by the path it was asked by — one the middleware named
 * another by is another segment, which the build may not have written — a page's whole payload
 * with none named.
 */
function stillAsks(part: Part, left: Headers): boolean {
  const named = left.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER);
  const routers = left.get(RSC_HEADER) === '1';
  switch (part.kind) {
    case 'segment': {
      const asked = new Headers(part.headers).get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER);
      return routers && named !== null && named !== '' && named === asked;
    }
    case 'payload': {
      return routers && named === null;
    }
    case 'data': {
      return true;
    }
  }
}

/**
 * Why a part handed on for want of it (`segment-prefetch`, `rsc-payload`, `pages-data`) should not
 * have been: the request, as the middleware left it, still asks for it, on a route — the one the
 * middleware left it on, or its own — whose part the build wrote, and whose parts the edge answers
 * from what the build wrote alone (`generationsServed`), which it serves wherever it holds them
 * (`answerPart` in the edge). A page's props it hands on as well where the middleware covers them,
 * before it runs (`routeHostedDocument`); and any part a rule claims, or the middleware left on no
 * route of the build's (`entryFor`, `unprovedRoute`).
 */
function unheldHandoffFailure(stack: CheckedStack, part: Part, read: HandedOn): string | undefined {
  const { decided } = read;
  const sent = { route: part.route, url: part.url, headers: read.asked, exact: part.exact };
  if ((part.kind === 'data' && read.covered) || claimedAsLeft(stack, sent, decided)) {
    return undefined;
  }
  const moved = decided?.kind === 'continue';
  const route = moved ? landingOf(stack, decided.url, decided) : part.route;
  const left = moved ? decided.requestHeaders : edgeReads(read.asked);
  if (
    route === undefined ||
    !stillAsks(part, left) ||
    generationsServed(stack, route) ||
    part.builtOn(route) === undefined
  ) {
    return undefined;
  }
  return 'for want of the part, though the build wrote it for the route the request is on, which the edge answers from what the build wrote alone';
}

/**
 * Why a part handed on for Next.js to render itself (`bypass-for`) should not have been: its route's
 * `bypassFor` holds not for the request as the middleware left it — on the route it left it on — nor
 * does a draft mode's cookie stand (`bypassed` in the edge); nor, for a member of a class, is its
 * agent sent blocking metadata (`serveMemberWithoutShell`).
 */
function bypassHandoffFailure(
  stack: CheckedStack,
  part: Part,
  read: {
    readonly decided: MiddlewareResult | undefined;
    readonly asked: Readonly<Record<string, string>>;
  },
): string | undefined {
  const { decided } = read;
  const moved = decided?.kind === 'continue' ? landingOf(stack, decided.url, decided) : undefined;
  const route = moved ?? part.route;
  const agent =
    decided?.kind === 'continue'
      ? decided.requestHeaders.get('user-agent')
      : (read.asked['user-agent'] ?? null);
  const blocking = route.pathname.includes('[') && wantsBlockingMetadata(agent, stack.manifest);
  return blocking || bypassedFor(stack, { ...part, route }, read)
    ? undefined
    : "for its route's bypassFor, which holds not for the request, nor does a draft mode's cookie stand";
}

/**
 * A part the edge handed on to the Function: the application's — but a failure where the edge hands
 * it on only once the middleware covering it ran, and it did not; for a reason the edge gives no
 * request of the router's (`ROUTER_HANDOFFS`); and, handed on for want of a route, which the edge
 * says of a navigation alone (`classifyRequest`), a failure but where a rule claims it as the
 * middleware left it, as such a document is judged (`unprovedVerdict`).
 */
export function handedOnVerdict(stack: CheckedStack, part: Part, read: HandedOn): Verdict {
  const { answered, decided } = read;
  if (UNPROVED.test(answered)) {
    const sent = { route: part.route, url: part.url, headers: read.asked, exact: part.exact };
    return (
      unprovedVerdict(stack, sent, decided) ??
      failed(
        `handed on for want of a route, though the build proves its own (${EDGE_HEADER}: ${answered})`,
      )
    );
  }
  const reason = handoffReasonOf(answered);
  if (reason === 'rewrite-status') {
    return rewriteStatusVerdict(decided, read.covered);
  }
  if (!HANDOFFS[part.kind].has(reason)) {
    return failed(
      `handed on for a reason the edge gives no request of the router's (${EDGE_HEADER}: ${answered})`,
    );
  }
  const general = generalHandoffFailure(stack, part, { ...read, reason });
  if (general !== undefined) {
    return failed(`handed on, ${general} (${EDGE_HEADER}: ${answered})`);
  }
  const unrun = HANDED_ON_PAST_MIDDLEWARE.test(answered)
    ? unrunFailure(decided, read.covered, 'handed it on')
    : undefined;
  return unrun === undefined ? skipped(APPLICATIONS) : failed(unrun);
}

/** A document handed on for its route or a captured middleware rewrite's status. */
export function documentHandedOnVerdict(
  stack: CheckedStack,
  sent: SentRequest,
  read: {
    readonly answer: Reading;
    readonly answered: string;
    readonly decided: KeptMiddlewareResult | undefined;
  },
): Verdict | undefined {
  const { answer, answered, decided } = read;
  switch (handoffReasonOf(answered)) {
    case 'route-not-proved': {
      return unprovedVerdict(stack, sent, decided);
    }
    case 'bypass-for': {
      return keptFailure(answer, decided) === undefined
        ? bypassedVerdict(stack, decided, sent)
        : undefined;
    }
    case 'rewrite-status': {
      const covered = middlewareCovers(stack, sent.url, sent.headers);
      const unkept = keptFailure(answer, decided, covered);
      return unkept === undefined ? rewriteStatusVerdict(decided, covered) : failed(unkept);
    }
    default: {
      return undefined;
    }
  }
}

/** A document or part handed on under the non-200 status of a captured middleware rewrite. */
export function rewriteStatusVerdict(
  decided: KeptMiddlewareResult | undefined,
  covered: boolean,
): Verdict {
  if (!covered) {
    return failed('handed on for a rewrite status, though no middleware matcher covers it');
  }
  if (decided?.kind !== 'continue' || decided.rewriteStatus === undefined) {
    return failed('handed on for a rewrite status, though no such middleware rewrite was kept');
  }
  return skipped("the application's middleware gave its rewrite a status");
}
