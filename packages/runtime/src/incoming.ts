import {
  HEADER_RULES_JUDGED_HEADER,
  MIDDLEWARE_DONE_HEADER,
  MIDDLEWARE_REWRITE_STATUS_HEADER,
  ORIGINAL_URL_HEADER,
  PLATFORM_REQUEST_HEADERS,
  SERVED_GENERATION_HEADER,
} from '@stayingupwind/core/paas';
import {
  BYPASS_QUERY_PREFIXES,
  isBotUserAgent,
  isHtmlLimitedBotUserAgent,
} from '@stayingupwind/core/request';

import type { ServedObservation } from './cache/host.ts';

/**
 * What an incoming request says about itself.
 *
 * Every function here reads the client's request — its headers, its URL — and nothing of the
 * deployment: no store, no routing table, no entrypoint. They are the first thing request
 * handling does with a request and the last thing that has to change when routing does.
 */

const RSC_HEADER = 'rsc';

/** The headers the edge adds for the Function's own use; Next.js never sees them. */
export function stripPlatformHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of PLATFORM_REQUEST_HEADERS) {
    out.delete(name);
  }
  return out;
}

/** A status a rewrite takes from its middleware: one a response can be made with, other than 200. */
const REWRITE_STATUS = /^(?:20[1-9]|2[1-9]\d|[345]\d{2})$/u;

/**
 * The status the middleware the edge ran gave its rewrite (`MIDDLEWARE_REWRITE_STATUS_HEADER`), for
 * the route it rewrote to to be answered under, where the edge ran the middleware
 * (`MIDDLEWARE_DONE_HEADER`) and the status is one a rewrite takes: none for anything else, which
 * leaves the route its own. The edge strips the platform's headers off what a client sends, so only
 * the edge names one.
 */
export function edgeRewriteStatusOf(headers: Headers): number | undefined {
  if (headers.get(MIDDLEWARE_DONE_HEADER) !== '1') {
    return undefined;
  }
  const value = headers.get(MIDDLEWARE_REWRITE_STATUS_HEADER);
  return value !== null && REWRITE_STATUS.test(value) ? Number(value) : undefined;
}

/**
 * Whether the edge lays the header rules of `next.config` on this request's answer itself: it ran the
 * middleware (`MIDDLEWARE_DONE_HEADER`), and judged the rules on the request as the client sent it,
 * before that (`HEADER_RULES_JUDGED_HEADER`). Routing leaves them out then (`routingTables`), and the
 * answer says so (`withHeaderRulesLeft`). Only the edge names either: it strips the platform's
 * headers off what a client sends.
 */
export function edgeJudgesHeaderRules(headers: Headers): boolean {
  return (
    headers.get(MIDDLEWARE_DONE_HEADER) === '1' && headers.get(HEADER_RULES_JUDGED_HEADER) === '1'
  );
}

/** The URL the client asked for: the edge names it when it rewrote the request, else it is this one. */
export function initUrlOf(request: Request): string {
  const original = request.headers.get(ORIGINAL_URL_HEADER);
  const url = new URL(request.url);
  return original === null ? request.url : new URL(original, url.origin).href;
}

/**
 * Where a key of a query may begin with one of `BYPASS_QUERY_PREFIXES`, read off a URL or its query
 * as text: after a `?` or a `&`, each letter spelled as it is or escaped, which the query's parser
 * reads back as the same letter (`%6ExtPid` is `nxtPid`). Wider than the prefixes — in either case of
 * each letter, after any `?` or `&` of the text, a path's own among them — and never narrower: what it
 * finds is judged key by key (`isRouteParameterKey`).
 */
const ROUTE_PARAMETER_KEY_START = /[&?](?:n|%6e)(?:x|%78)(?:t|%74)(?:[ip]|%49|%50)/iu;

/**
 * Whether Next.js reads `key` as its own rather than the application's: a route parameter
 * (`nxtPorgSlug`) or an interception marker (`nxtI…`), which a handler Next.js's own server does not
 * wrap takes its route parameters from, over what its path matches (`normalizeQueryParams`, in
 * `RouteModule.prepare`) — what routing writes into a dynamic route's destination for them. The
 * prefix alone is an ordinary key, as Next.js reads it (`normalizeNextQueryParam`).
 */
export function isRouteParameterKey(key: string): boolean {
  return BYPASS_QUERY_PREFIXES.some(
    (prefix) => key.length > prefix.length && key.startsWith(prefix),
  );
}

/**
 * The key of one pair of a query (`name=value`), as Next.js reads it: by the query's own parser,
 * handed the pair behind a `&`, which it skips, so that a `?` the pair begins with stays the key's
 * own, as it does within a query.
 */
function keyOf(pair: string): string {
  return new URLSearchParams(`&${pair}`).keys().next().value ?? '';
}

/**
 * Take the keys Next.js reads as its own (`isRouteParameterKey`) out of `url`'s query, and say
 * whether there were any. Every other pair stays where it was, spelled as it was.
 *
 * They are routing's to write: a dynamic route names its parameters in the query it hands the
 * route's handler (`?nxtPid=$nxtPid`), and the handler reads them from there. Next.js fixed the
 * same keys sent by a client (GHSA-492v-c6pp-mqqv) only for the requests its own server routes, so
 * a client's are not handed on here: a page's parameters are the ones routing matched from its
 * path. Only a query that may hold one (`ROUTE_PARAMETER_KEY_START`) is split into its pairs; any
 * other is left as it is, unparsed.
 *
 * What is kept is set behind a `?` of its own: the URL takes one leading `?` off whatever it is set
 * to, and handed the pairs alone, it took the one a first pair began with — a pair that is no route
 * parameter (`?nxtPid`, a key of its own, after the query's own `?`) came back as one (`nxtPid`).
 */
export function dropRouteParameterKeys(url: URL): boolean {
  const { search } = url;
  if (!ROUTE_PARAMETER_KEY_START.test(search)) {
    return false;
  }
  const pairs = search.slice(1).split('&');
  const kept = pairs.filter((pair) => !isRouteParameterKey(keyOf(pair)));
  if (kept.length === pairs.length) {
    return false;
  }
  url.search = kept.length === 0 ? '' : `?${kept.join('&')}`;
  return true;
}

/**
 * What a request is handled with (`input`), its request without the keys of its query Next.js reads
 * as its own (`dropRouteParameterKeys`): a copy of both where the query held one, and `input` itself
 * otherwise — as for every request an application's own links make, which is neither parsed nor
 * copied (`ROUTE_PARAMETER_KEY_START`, read off the request's URL).
 *
 * What a handler is told the client asked for (`initURL`) follows, where it is the request's own
 * URL: an image's source is told the URL it is asked by (`sourceInput`), and kept as it was, that
 * still held a key the request no longer did.
 */
export function withoutRouteParameterKeys<
  T extends { readonly request: Request; readonly initURL?: string },
>(input: T): T {
  const href = input.request.url;
  if (!ROUTE_PARAMETER_KEY_START.test(href)) {
    return input;
  }
  const url = new URL(href);
  if (!dropRouteParameterKeys(url)) {
    return input;
  }
  const request = new Request(url, input.request);
  return input.initURL === href
    ? { ...input, request, initURL: request.url }
    : { ...input, request };
}

/**
 * The path and query a resume renders for, without the keys Next.js reads its own route parameters
 * from (`dropRouteParameterKeys`). The edge sends a class shell's member by its own path, and the
 * parameters come from that path.
 */
export function resumeUrl(request: Request): string {
  const url = new URL(request.url);
  dropRouteParameterKeys(url);
  return `${url.pathname}${url.search}`;
}

export function isRscRequest(request: Request): boolean {
  return request.headers.get(RSC_HEADER) === '1';
}

/** The pathname a shell's RSC twins hang off: the build names the root's `/index`. */
export function rscBase(pathname: string): string {
  return pathname === '/' ? '/index' : pathname;
}

export function hasBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/** `htmlLimitedBots` compiled, by its pattern: one application's, for every request it serves. */
const compiledBots = new Map<string, RegExp | undefined>();

function botsRegexOf(pattern: string): RegExp | undefined {
  if (!compiledBots.has(pattern)) {
    let regex: RegExp | undefined;
    try {
      // Compiled as Next.js compiles it, case-insensitive and without the unicode flag.
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
      regex = new RegExp(pattern, 'i');
    } catch {
      regex = undefined;
    }
    compiledBots.set(pattern, regex);
  }
  return compiledBots.get(pattern);
}

/**
 * Whether Next.js sends this visitor blocking metadata rather than streaming it: a user agent the
 * application's `htmlLimitedBots` names, tested as Next.js tests it — case-insensitive, anywhere in
 * the value (`shouldServeStreamingMetadata`, `server/lib/streaming-metadata.ts`) — or one on
 * Next.js's own list when the build recorded no pattern, or an empty one, which Next.js reads as
 * none (`htmlLimitedBots || HTML_LIMITED_BOT_UA_RE_STRING`) rather than as naming everyone.
 */
export function wantsBlockingMetadata(request: Request, pattern: string | undefined): boolean {
  const userAgent = request.headers.get('user-agent');
  if (userAgent === null || userAgent === '') {
    return false;
  }
  if (pattern === undefined || pattern === '') {
    return isHtmlLimitedBotUserAgent(userAgent);
  }
  return botsRegexOf(pattern)?.test(userAgent) ?? false;
}

/**
 * Whether the visitor is a crawler, by the list Next.js keeps for the question (`isBot`,
 * `shared/lib/router/utils/is-bot.ts`): the one crawler that runs a browser, Googlebot, and every
 * agent limited to the HTML it is sent. Not the same question as `wantsBlockingMetadata`, which an
 * application may answer with a list of its own; this one Next.js decides alone.
 */
export function isCrawler(request: Request): boolean {
  const userAgent = request.headers.get('user-agent');
  return userAgent !== null && userAgent !== '' && isBotUserAgent(userAgent);
}

/** `<generationId>;colo=<colo>;at=<ms>`: what the edge observed when it asked. */
export function observationOf(request: Request): ServedObservation | undefined {
  const value = request.headers.get(SERVED_GENERATION_HEADER);
  if (value === null) {
    return undefined;
  }
  const [generationId = '', ...parts] = value.split(';');
  const fields = new Map(parts.map((part) => part.split('=', 2) as [string, string | undefined]));
  const at = Number(fields.get('at'));
  if (generationId === '' || !Number.isSafeInteger(at)) {
    return undefined;
  }
  const colo = fields.get('colo');
  return { generationId, at, ...(colo !== undefined && colo !== '' && { colo }) };
}
