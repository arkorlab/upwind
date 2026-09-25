import {
  ORIGINAL_URL_HEADER,
  PLATFORM_REQUEST_HEADERS,
  SERVED_GENERATION_HEADER,
} from '@upwind/core/paas';
import {
  BYPASS_QUERY_PREFIXES,
  isBotUserAgent,
  isHtmlLimitedBotUserAgent,
} from '@upwind/core/request';

import type { ServedObservation } from './cache/host.ts';

/**
 * What an incoming request says about itself.
 *
 * Every function here reads the client's request — its headers, its URL — and nothing of the
 * deployment: no store, no routing table, no entrypoint. They are the first thing request
 * handling does with a request and the last thing that has to change when routing does.
 */

const RSC_HEADER = 'rsc';

/** The headers the edge adds for the Worker's own use; Next.js never sees them. */
export function stripPlatformHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of PLATFORM_REQUEST_HEADERS) {
    out.delete(name);
  }
  return out;
}

/** The URL the client asked for: the edge names it when it rewrote the request, else it is this one. */
export function initUrlOf(request: Request): string {
  const original = request.headers.get(ORIGINAL_URL_HEADER);
  const url = new URL(request.url);
  return original === null ? request.url : new URL(original, url.origin).href;
}

/**
 * The path and query a resume renders for, with the query keys Next.js reads its own route
 * parameters from (`nxtPorgSlug`) left out. The edge sends a class shell's member by its own
 * path, and the parameters come from that path: a key smuggled into the query is not given the
 * chance to compete with it.
 */
export function resumeUrl(request: Request): string {
  const url = new URL(request.url);
  const smuggled = [...url.searchParams.keys()].filter((key) =>
    BYPASS_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  for (const key of smuggled) {
    url.searchParams.delete(key);
  }
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
 * Next.js's own list when the build recorded no pattern.
 */
export function wantsBlockingMetadata(request: Request, pattern: string | undefined): boolean {
  const userAgent = request.headers.get('user-agent');
  if (userAgent === null || userAgent === '') {
    return false;
  }
  if (pattern === undefined) {
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

/**
 * Whether the client already holds this very generation of the answer, by the validator it was
 * given: `If-None-Match`, as a list of entity tags or `*`, compared strongly — every tag written
 * here is strong, and a `W/` prefix on one that came back is taken off before comparing so that a
 * proxy that weakened it is still understood.
 */
export function holdsValidator(request: Request, validator: string): boolean {
  const asked = request.headers.get('if-none-match');
  if (asked === null) {
    return false;
  }
  return asked
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//u, ''))
    .some((tag) => tag === '*' || tag === validator);
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
