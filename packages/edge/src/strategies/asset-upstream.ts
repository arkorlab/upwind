import {
  type AssetRejection,
  refusalAllowsStorage,
  screenImmutableAsset,
} from '@stayingupwind/core/assets';
import {
  EDGE_DEBUG_HEADER,
  HOP_BY_HOP_HEADERS,
  NO_STORE_CACHE_CONTROL,
  PLATFORM_HEADER_PREFIX,
} from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';
import type { AssetKeepOutcome } from '@stayingupwind/host/delivery';

import { applyCspReporting } from '../handlers/csp-reporting-headers.ts';
import {
  nominatedBy,
  removeSharedCacheOverrides,
  safeDiagnosticField,
} from '../handlers/responses.ts';
import type { EdgeContext } from './context.ts';
import { listsTag } from './entity-tags.ts';

/** Request headers forwarded for asset fetches: no cookies, no conditionals, no ranges. */
export const FORWARDED_ASSET_HEADERS: readonly string[] = [
  'accept',
  'user-agent',
  'accept-language',
];
const NOT_MODIFIED_STATUS = 304;
const CACHE_CONTROL_HEADER = 'cache-control';

export function assetUpstreamRequest(
  request: Request,
  originUrl: URL,
  ctx: EdgeContext,
  init: RequestInit = {},
): Request {
  const headers = new Headers();
  for (const name of FORWARDED_ASSET_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  // The same host every other upstream request carries: an application may put host-aware
  // middleware in front of `/_next/static/`.
  headers.set('x-forwarded-host', ctx.forwarding.previewHost);
  headers.set('x-forwarded-proto', 'https');
  // No `accept-encoding`: a Worker subrequest carries no `content-length` whatever it asks for,
  // so pinning `identity` only asked for more bytes over the hop. Left to itself the runtime
  // negotiates compression and decodes what comes back, and a response that still names an
  // encoding is refused rather than measured (`screenImmutableAsset`).
  headers.set('via', '1.1 arkor-edge');
  return new Request(originUrl.href, { method: 'GET', headers, redirect: 'manual', ...init });
}

/**
 * `cache-control` for an asset the caches after the edge may keep.
 *
 * `max-age` is what the browser sees: the asset is content-addressed and will never change.
 * `s-maxage` bounds shared-cache entries independently. Workers Cache in front of the edge should
 * be off; the origin-scoped Cache API checks the current policy on each request and re-applies
 * these values.
 *
 * Not only for admitted responses. An asset the edge refused for its size is still content-
 * addressed, and forcing every visitor to re-fetch it would be a refusal the origin never made.
 */
export function storableAssetCacheControl(ctx: EdgeContext): string {
  // Validation must never leave a response in a shared cache, including a hit populated by live
  // traffic. The next candidate must reach the Worker to exercise its own policy.
  if (ctx.validated) {
    return NO_STORE_CACHE_CONTROL;
  }
  const { ttlSeconds, sharedTtlSeconds } = ctx.policy.assets;
  return `public, max-age=${ttlSeconds}, s-maxage=${sharedTtlSeconds}, immutable`;
}

/**
 * The `x-arkor-edge` value of an asset response. Every strategy builds it here so the shape is one
 * thing, and `policy` lets validation assert that it exercised the candidate it asked for rather
 * than a cache entry some earlier policy left behind.
 */
export function assetDebug(ctx: EdgeContext, strategyId: string, verdict: string): string {
  return `asset;strategy=${strategyId};${verdict};project=${safeDiagnosticField(ctx.projectId)};policy=${ctx.policy.id}`;
}

/**
 * Read the copy of the body the client is not reading, and do something with it.
 *
 * A callback rather than a returned stream, because a branch nobody reads is a branch that keeps
 * every byte it was given: the runtime lets whichever side reads faster pull the source along, and
 * queues what the other has not taken. Consuming the copy is not optional. What it returns is
 * reported, never thrown.
 */
type AssetKeeper = (
  body: ReadableStream<Uint8Array>,
  response: Response,
) => Promise<AssetKeepOutcome>;

export interface ShapeAssetOptions {
  readonly strategyId: string;
  /** Absent when there is nothing to keep a copy for: shadow validation, or a strategy that stores nothing. */
  readonly keep: AssetKeeper | undefined;
}

export interface ShapedAsset {
  readonly response: Response;
  readonly admitted: boolean;
  /** Why the origin's answer was refused, when it was. */
  readonly rejection: AssetRejection | undefined;
  /** What became of the copy, for a response that had one kept; see `AssetKeeper`. */
  readonly kept: Promise<AssetKeepOutcome> | undefined;
}

/**
 * The origin's headers, minus the ones it does not get to decide for the edge — and the edge's own
 * (`PLATFORM_HEADER_PREFIX`): what a runtime tells the edge on an answer, of invalidations, of
 * routing, of its caches, is for no client to read and for no copy the edge keeps to carry, as an
 * answer the edge proxies is rid of them (`forwardedResponse`). The edge sets its own account of
 * the answer (`EDGE_DEBUG_HEADER`) after. So, too, what the answer says of its own hop: the
 * hop-by-hop headers, and the ones its `Connection` names (`nominatedBy`).
 */
export function assetHeaders(originHeaders: Headers): Headers {
  const headers = new Headers(originHeaders);
  const nominated = nominatedBy(originHeaders);
  // Names read from the origin's: deleting from the headers being iterated would skip entries.
  for (const [name] of originHeaders) {
    if (
      name.startsWith(PLATFORM_HEADER_PREFIX) ||
      HOP_BY_HOP_HEADERS.includes(name) ||
      nominated?.has(name) === true
    ) {
      headers.delete(name);
    }
  }
  // These outrank `Cache-Control` for any cache that reads them, so leaving one in place would let
  // the origin overrule the lifetime its caller decides — including the refusal to store a response
  // admission turned down.
  removeSharedCacheOverrides(headers);
  return headers;
}

/**
 * Decide admission for an origin response and shape the client response accordingly.
 *
 * The headers answer every question but size, and they are answered on the headers alone: a
 * response they turn down is proxied through untouched, and one they admit goes to the client as
 * it arrives. The edge used to read the whole body first, because the length is the verdict on
 * whether a copy can be kept and a Worker subrequest carries no `Content-Length` — but that put
 * the whole download in front of the client's first byte, on exactly the request that had nothing
 * cached. The counting now happens behind the response, on a second reading of the same stream.
 */
export function shapeAssetResponse(
  request: Request,
  originResponse: Response,
  ctx: EdgeContext,
  options: ShapeAssetOptions,
): ShapedAsset {
  const { strategyId } = options;
  // Keep refused cookies until the handler chooses the transparent proxy path. Screening can reject
  // a response for another reason first, so its verdict alone cannot preserve the cookie.
  const headers = assetHeaders(originResponse.headers);
  const refuse = (
    body: ReadableStream<Uint8Array> | null,
    rejection: AssetRejection,
  ): ShapedAsset => {
    applyCspReporting(headers, ctx.cspReportingPath);
    headers.set(EDGE_DEBUG_HEADER, assetDebug(ctx, strategyId, `admit=0;reason=${rejection}`));
    // Refusing to hold an asset is not refusing to let anyone hold it. `content-encoding` is a
    // statement about this edge, made over headers the origin declared immutable, so the browser
    // keeps its year and shared caches keep their bounded share of it.
    headers.set(
      CACHE_CONTROL_HEADER,
      refusalAllowsStorage(rejection) ? storableAssetCacheControl(ctx) : NO_STORE_CACHE_CONTROL,
    );
    const response = new Response(body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers,
    });
    return { response, admitted: false, rejection, kept: undefined };
  };

  const rejection = screenImmutableAsset({
    method: request.method,
    requestHeaders: request.headers,
    status: originResponse.status,
    responseHeaders: originResponse.headers,
  });
  if (rejection !== undefined) {
    return refuse(originResponse.body, rejection);
  }
  // The lifetime comes from the active policy so it is one of the things a candidate policy can
  // change and a measurement can compare, rather than a constant every backend reimplements.
  headers.set(CACHE_CONTROL_HEADER, storableAssetCacheControl(ctx));
  headers.set(EDGE_DEBUG_HEADER, assetDebug(ctx, strategyId, 'admit=1'));
  // Before the read, not after: a client that already holds this asset is answered from the
  // validator alone, and pulling a body in order to drop it would spend the budget for nothing.
  const notModified = notModifiedIfMatches(request, headers);
  if (notModified !== undefined) {
    releaseStream(originResponse.body, 'not modified');
    return { response: notModified, admitted: true, rejection: undefined, kept: undefined };
  }
  const init = {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers,
  };
  // A body of `null` is nothing to read and nothing to keep. It used to be kept anyway, as an
  // empty entry that every later request for this URL would then have been served.
  if (options.keep === undefined || originResponse.body === null) {
    return {
      response: new Response(originResponse.body, init),
      admitted: true,
      rejection: undefined,
      kept: undefined,
    };
  }
  // Two readings of one body. The client's goes out now; the copy is read behind it, to the end,
  // whatever the client does — which is the point, and what a pipe hung off the client's stream
  // could not do.
  //
  // The runtime does not pace a tee at its slower side: measured, a branch read two hundred times
  // pulled the source two hundred chunks along while the other was never read, and those chunks
  // wait in that branch's queue. So a slow client is left holding what the copy pulled past it, on
  // top of the copy's own bytes — bounded, both of them, because the copy stops at the manifest's
  // asset budget and lets its branch go, and a branch nothing reads ahead of queues nothing after
  // that. Two of those budgets is the same order this held when it read the whole body before
  // answering, and the reason that budget is a memory budget (`MAX_IMMUTABLE_ASSET_BYTES`).
  //
  // Keeping the copy first and the client second would bound it too, and would be the whole of
  // what this path exists to stop: the first byte behind the last one the origin sends.
  //
  // `tee()` is typed as the runtime declares the body, which is `any` either side of it.
  const [toClient, toKeep] = originResponse.body.tee() as [
    ReadableStream<Uint8Array>,
    ReadableStream<Uint8Array>,
  ];
  const response = new Response(toClient, init);
  return { response, admitted: true, rejection: undefined, kept: options.keep(toKeep, response) };
}

/** Whether the request's `If-None-Match` names the entity tag the response would carry (`listsTag`). */
export function validatorMatches(request: Request, etag: string | null): boolean {
  const ifNoneMatch = request.headers.get('if-none-match');
  return ifNoneMatch !== null && listsTag(ifNoneMatch, etag);
}

const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
/** The days of the week as IMF-fixdate and asctime name them, in `getUTCDay` order. */
const WEEKDAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** And as the RFC 850 form names them. */
const RFC_850_WEEKDAYS: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** IMF-fixdate, the form every sender generates: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE =
  /^(?<weekday>[A-Z][a-z]{2}), (?<day>\d{2}) (?<month>[A-Z][a-z]{2}) (?<year>\d{4}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/u;
/** The obsolete RFC 850 form, which a recipient still accepts: `Sunday, 06-Nov-94 08:49:37 GMT`. */
const RFC_850_DATE =
  /^(?<weekday>[A-Z][a-z]{5,8}), (?<day>\d{2})-(?<month>[A-Z][a-z]{2})-(?<year>\d{2}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/u;
/** The obsolete asctime form, in GMT though it names no zone: `Sun Nov  6 08:49:37 1994`. */
const ASCTIME_DATE =
  /^(?<weekday>[A-Z][a-z]{2}) (?<month>[A-Z][a-z]{2}) (?<day>[ \d]\d) (?<time>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/u;

/** The three forms of an HTTP-date (RFC 9110 §5.6.7), each with its names for the days of the week. */
const HTTP_DATE_FORMS: readonly {
  readonly form: RegExp;
  readonly weekdays: readonly string[];
}[] = [
  { form: IMF_FIXDATE, weekdays: WEEKDAYS },
  { form: RFC_850_DATE, weekdays: RFC_850_WEEKDAYS },
  { form: ASCTIME_DATE, weekdays: WEEKDAYS },
];

const LAST_HOUR = 23;
const LAST_MINUTE = 59;
/** The second `23:59:60` names: the one leap second an HTTP-date's grammar allows. */
const LEAP_SECOND = 60;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1000;
const YEARS_PER_CENTURY = 100;
/** How far ahead of this year an RFC 850 date's two-digit year is read, at most (RFC 9110 §5.6.7). */
const MOST_YEARS_AHEAD = 50;

/**
 * A year as an HTTP-date writes it: four digits, or the RFC 850 form's two, read in this century
 * unless the date would then be more than fifty years ahead of now, and in the last otherwise (RFC
 * 9110 §5.6.7). The whole date and time say so, not the year alone: fifty years on from this year,
 * a date is read back once it is past this moment then.
 */
function fullYear(digits: string, month: number, day: number, seconds: number): number {
  const year = Number(digits);
  if (digits.length !== 2) {
    return year;
  }
  // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
  const latest = new Date();
  const thisYear = latest.getUTCFullYear();
  latest.setUTCFullYear(thisYear + MOST_YEARS_AHEAD);
  const read = thisYear - (thisYear % YEARS_PER_CENTURY) + year;
  // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
  const instant = Date.UTC(read, month, day) + seconds * MS_PER_SECOND;
  return instant > latest.getTime() ? read - YEARS_PER_CENTURY : read;
}

/** The seconds into its day `HH:MM:SS` names, where it is a time of day: `23:59:60` included. */
function secondsOfDay(time: string): number | undefined {
  const [hour = 0, minute = 0, second = 0] = time.split(':').map(Number);
  const leap = hour === LAST_HOUR && minute === LAST_MINUTE && second === LEAP_SECOND;
  return hour <= LAST_HOUR && minute <= LAST_MINUTE && (leap || second < LEAP_SECOND)
    ? (hour * MINUTES_PER_HOUR + minute) * SECONDS_PER_MINUTE + second
    : undefined;
}

/**
 * The instant an HTTP-date's fields name, where they name one: one of the twelve months, a day that
 * month has, a time of day, and the day of the week that date fell on, as its form names it. Each is
 * read back off the date `Date.UTC` makes of them, which rolls the 31st of November over into
 * December rather than refusing it.
 */
function instantOf(
  fields: Readonly<Record<string, string | undefined>>,
  weekdays: readonly string[],
): number | undefined {
  const month = MONTHS.indexOf(fields['month'] ?? '');
  const day = Number(fields['day']);
  const seconds = secondsOfDay(fields['time'] ?? '');
  if (month === -1 || seconds === undefined) {
    return undefined;
  }
  const year = fullYear(fields['year'] ?? '', month, day, seconds);
  // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
  const date = new Date(Date.UTC(year, month, day));
  const named =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day &&
    weekdays[date.getUTCDay()] === fields['weekday'];
  return named ? date.getTime() + seconds * MS_PER_SECOND : undefined;
}

/**
 * The instant an HTTP-date names, in any of its three forms, read whole: a list of two dates is
 * none. `undefined` for a value that is not one — a name, a date or a time of day that is none
 * included — which a condition on it is then not judged by.
 */
export function httpDateMs(value: string): number | undefined {
  for (const { form, weekdays } of HTTP_DATE_FORMS) {
    const fields = form.exec(value)?.groups;
    if (fields !== undefined) {
      return instantOf(fields, weekdays);
    }
  }
  return undefined;
}

/**
 * Whether a request that asks by date, with no `If-None-Match`, asks of an answer last modified no
 * later than the date it names: one the client already holds (RFC 9110 §13.1.3). Not judged where
 * either is no HTTP-date, or the answer names no modification date: the whole answer goes, as to a
 * request that asked nothing.
 */
export function unmodifiedSince(request: Request, lastModified: string | null): boolean {
  const since = request.headers.get('if-modified-since');
  if (
    since === null ||
    lastModified === null ||
    request.headers.has('if-none-match') ||
    (request.method !== 'GET' && request.method !== 'HEAD')
  ) {
    return false;
  }
  const sinceMs = httpDateMs(since);
  const modifiedMs = httpDateMs(lastModified);
  return sinceMs !== undefined && modifiedMs !== undefined && modifiedMs <= sinceMs;
}

/**
 * Answer a conditional request the client already holds the answer to, given the headers the edge
 * is about to send: its `If-None-Match` names the tag, or, asked without one, its
 * `If-Modified-Since` is no earlier than the `Last-Modified` (`unmodifiedSince`). These are the
 * conditions a cache judges (RFC 9111 §4.3.2); `If-Match` and `If-Unmodified-Since` are the
 * origin's, which a cache or intermediary may leave unjudged (RFC 9110 §13.1.1, §13.1.4). The
 * caller still owns the body it did not build a response around.
 */
export function notModifiedIfMatches(request: Request, headers: Headers): Response | undefined {
  if (
    !validatorMatches(request, headers.get('etag')) &&
    !unmodifiedSince(request, headers.get('last-modified'))
  ) {
    return undefined;
  }
  const kept = new Headers();
  for (const name of ['etag', CACHE_CONTROL_HEADER, 'content-type', 'vary', EDGE_DEBUG_HEADER]) {
    const value = headers.get(name);
    if (value !== null) {
      kept.set(name, value);
    }
  }
  return new Response(null, { status: NOT_MODIFIED_STATUS, headers: kept });
}
