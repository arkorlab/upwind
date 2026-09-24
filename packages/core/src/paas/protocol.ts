/**
 * The wire protocol between the edge and an application's runtime Worker. Both sides import these
 * names; nothing else on the request carries platform intent.
 */

/** Run only the middleware and return its raw response (rewrite/redirect/next/set-cookie). */
export const MIDDLEWARE_ONLY_HEADER = 'x-arkor-middleware';
/** The edge already ran the middleware; the runtime must not run it again. */
export const MIDDLEWARE_DONE_HEADER = 'x-arkor-middleware-done';
/** Resume this prerender: render only what its postponed state left out. */
export const RESUME_PRERENDER_HEADER = 'x-arkor-prerender';
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
  ORIGINAL_URL_HEADER,
  RESUME_STATE_HEADER,
  RESUME_STATE_LENGTH_HEADER,
  REGENERATE_HEADER,
  CACHE_SCOPE_REQUEST_HEADER,
  CACHE_ENTRY_HEADER,
  CACHE_ROUTE_HEADER,
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
 * The visitor's country as the platform observed it. Left on the request for the application to
 * read, where a Vercel-hosted one read `x-vercel-ip-country`.
 */
export const IP_COUNTRY_HEADER = 'x-arkor-ip-country';

export function isRegenerateMode(value: string | null): value is RegenerateMode {
  return value !== null && (REGENERATE_MODES as readonly string[]).includes(value);
}
