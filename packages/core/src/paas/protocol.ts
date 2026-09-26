/**
 * The wire protocol between the edge and an application's runtime Function. Both sides import these
 * names; nothing else on the request carries platform intent.
 */

/** Run only the middleware and return its raw response (rewrite/redirect/next/set-cookie). */
export const MIDDLEWARE_ONLY_HEADER = 'x-arkor-middleware';
/** The edge already ran the middleware; the runtime must not run it again. */
export const MIDDLEWARE_DONE_HEADER = 'x-arkor-middleware-done';
/** Resume this prerender: render only what its postponed state left out. */
export const RESUME_PRERENDER_HEADER = 'x-arkor-prerender';
/** The same, escaped where a header cannot carry it as it is (`pathHeaders`). */
export const RESUME_PRERENDER_ESCAPED_HEADER = 'x-arkor-prerender-escaped';
/** The URL the client asked for, when the request path is a rewrite of it. */
export const ORIGINAL_URL_HEADER = 'x-arkor-original-url';
/**
 * The resume state of a generation made at runtime travels as the request body, since the runtime's
 * bundle does not hold it: `body` says so, and the length header says how much to read.
 */
export const RESUME_STATE_HEADER = 'x-arkor-resume-state';
export const RESUME_STATE_BODY = 'body';
export const RESUME_STATE_LENGTH_HEADER = 'x-arkor-resume-state-length';
/**
 * Regenerate the entry the request names. `background`: after the response, in `waitUntil`.
 * `foreground`: no valid generation exists, so the render is the response and the commit follows.
 * `detached`: answer at once and regenerate in `waitUntil` (a page nothing resumes).
 */
export const REGENERATE_HEADER = 'x-arkor-regenerate';
export const REGENERATE_MODES = ['background', 'foreground', 'detached'] as const;
export type RegenerateMode = (typeof REGENERATE_MODES)[number];
/** The cache scope and entry the request concerns, when it concerns one. */
export const CACHE_SCOPE_REQUEST_HEADER = 'x-arkor-cache-scope';
export const CACHE_ENTRY_HEADER = 'x-arkor-cache-entry';
export const CACHE_ROUTE_HEADER = 'x-arkor-cache-route';
/** The same, escaped where a header cannot carry it as it is (`pathHeaders`). */
export const CACHE_ROUTE_ESCAPED_HEADER = 'x-arkor-cache-route-escaped';
/**
 * The entry the request names is a member's own, not the class shell's that answers the member
 * (`runtimeCache.concreteUpgrade`): the runtime regenerates the concrete pathname, where it would
 * regenerate the class.
 */
export const CACHE_UPGRADE_HEADER = 'x-arkor-cache-upgrade';
/** The generation the edge served, and its sequence number: the base a regeneration replaces. */
export const GENERATION_HEADER = 'x-arkor-generation';
export const GENERATION_SEQ_HEADER = 'x-arkor-generation-seq';
/** What the edge observed when it asked for a regeneration: `<generationId>;colo=<colo>;at=<ms>`. */
export const SERVED_GENERATION_HEADER = 'x-arkor-served';
/** Present only under a test binding: the clock the runtime's cache handlers use for this request. */
export const TEST_CLOCK_HEADER = 'x-arkor-test-clock';
/** The headers that tell the runtime what to do; stripped before the application sees a request. */
export const PLATFORM_REQUEST_HEADERS: readonly string[] = [
  MIDDLEWARE_ONLY_HEADER,
  MIDDLEWARE_DONE_HEADER,
  RESUME_PRERENDER_HEADER,
  RESUME_PRERENDER_ESCAPED_HEADER,
  ORIGINAL_URL_HEADER,
  RESUME_STATE_HEADER,
  RESUME_STATE_LENGTH_HEADER,
  REGENERATE_HEADER,
  CACHE_SCOPE_REQUEST_HEADER,
  CACHE_ENTRY_HEADER,
  CACHE_ROUTE_HEADER,
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_UPGRADE_HEADER,
  GENERATION_HEADER,
  GENERATION_SEQ_HEADER,
  SERVED_GENERATION_HEADER,
  TEST_CLOCK_HEADER,
];
/**
 * What the runtime says about the regeneration a request asked for, on its response: for the
 * edge's metrics only, and removed before anything reaches a client.
 */
export const CACHE_OUTCOME_HEADER = 'x-arkor-cache-outcome';
/**
 * What the runtime says of an answer that is a stored generation's: the same bytes for every
 * visitor, and carrying a validator of its own, so a shared cache may hold it under the
 * `Cache-Control` the runtime wrote rather than have it made one visitor's. Said only of an answer
 * no visitor's request took part in. For the host only, and removed before anything reaches a
 * client.
 */
export const SHARED_ANSWER_HEADER = 'x-arkor-shared-answer';
/**
 * What such an answer is served under: any cache may store it, and every use of it revalidates, so
 * an invalidation of the generation is never outlived by a copy somewhere else. It is what Next.js
 * writes on a metadata route itself (`next-metadata-route-loader.ts`) and what a CDN in front of a
 * cached output answers with.
 */
export const SHARED_ANSWER_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
/**
 * Every header a host reads off an answer, and so every one a runtime's boundary has to account for:
 * each is deleted from whatever the application answered and written again only where the runtime
 * itself said it (`settledForHost`). Named as a list so that the boundary never has to look through
 * an answer's headers to find them — an application shares the realm, and an enumeration it can
 * interfere with is one more thing to defend.
 */
export const HOST_RESPONSE_HEADERS: readonly string[] = [
  CACHE_OUTCOME_HEADER,
  SHARED_ANSWER_HEADER,
];

/**
 * The visitor's country as the platform observed it. Left on the request for the application to
 * read, where a Vercel-hosted one read `x-vercel-ip-country`.
 */
export const IP_COUNTRY_HEADER = 'x-arkor-ip-country';

export function isRegenerateMode(value: string | null): value is RegenerateMode {
  return value !== null && (REGENERATE_MODES as readonly string[]).includes(value);
}

/** Every character but visible ASCII, and `%`, which marks what was escaped. */
const UNSAFE_IN_HEADER = /[^\u{21}-\u{24}\u{26}-\u{7E}]/gu;

/**
 * A route or a prerender's id as a header carries it between the edge and the runtime
 * (`RESUME_PRERENDER_HEADER`, `CACHE_ROUTE_HEADER`). Next.js names what it builds by the characters
 * a path reads as — a Japanese slug stays Japanese — and a header value is bytes: `Headers` refuses
 * a character past U+00FF outright. So what a header cannot carry is escaped, `%` with it, and a
 * name in plain visible ASCII goes as it is.
 */
export function pathHeaderValue(name: string): string {
  return name.replaceAll(UNSAFE_IN_HEADER, (character) => encodeURIComponent(character));
}

/**
 * The name a header written by `pathHeaderValue` carries: `undefined` when there is no header, and
 * the value as it came in the one case it cannot be read back, an escape that is not one.
 */
export function pathFromHeader(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** What `Headers` takes as it is: bytes, with no NUL and no line break among them. */
const NOT_AS_IS_IN_HEADER = /[\0\n\r\u{100}-\u{10FFFF}]/u;

/**
 * The headers that name a route or a prerender to the runtime: `escapedName` with the name escaped
 * where a header cannot carry it (`pathHeaderValue`), and `name` with the name as it is, wherever a
 * header can carry it so. The edge and an application's Function are deployed apart, and a Function
 * built before the escape reads `name` as it comes: sent escaped there, a name with a space or an
 * accent in it (`/sticks & stones`, `/café`) was no name that Function knew. A name no header could
 * carry as it is was never sent to one that way.
 */
export function pathHeaders(
  name: string,
  escapedName: string,
  path: string,
): Record<string, string> {
  return {
    [escapedName]: pathHeaderValue(path),
    ...(!NOT_AS_IS_IN_HEADER.test(path) && { [name]: path }),
  };
}

/**
 * The name `pathHeaders` sent: the escaped header's, read back, else the other's as it came — what
 * an edge from before the escape sends. `undefined` when the request carries neither.
 */
export function pathFromHeaders(
  headers: Headers,
  name: string,
  escapedName: string,
): string | undefined {
  const escaped = headers.get(escapedName);
  return escaped === null ? (headers.get(name) ?? undefined) : pathFromHeader(escaped);
}
