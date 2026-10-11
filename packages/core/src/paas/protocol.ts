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
/**
 * A request an app Function was handed for a route another of the deployment's app Functions holds,
 * routed already (`MISDIRECTED_STATUS`): what the routing came to, for the Function that holds the
 * route to answer from without routing it again. Opaque to the edge, which copies it from the
 * answer it got onto the request it sends on; the runtime writes and reads it (`handoff.ts`).
 */
export const ROUTED_HEADER = 'x-arkor-routed';
/**
 * The revision the scope's tags stood at when the edge last heard of them, and when the latest of
 * its invalidations was recorded (unix ms; `-` for none): `<revision>;<invalidatedAt>`. Sent where
 * the edge hears of a scope's invalidations sooner than the Function's own reads of them would, so a
 * Function whose view of the tags is behind brings it up before it judges anything
 * (`scopeRevisionValue`, `parseScopeRevision`).
 */
export const SCOPE_REVISION_HEADER = 'x-arkor-scope-revision';
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
  ROUTED_HEADER,
  SCOPE_REVISION_HEADER,
];
/**
 * What the runtime says about the regeneration a request asked for, on its response: for the
 * edge's metrics only, and removed before anything reaches a client.
 */
export const CACHE_OUTCOME_HEADER = 'x-arkor-cache-outcome';
/**
 * The tags a request invalidated at once — `updateTag`, or `revalidateTag` with no window — on its
 * response. An edge that holds what carries them would otherwise serve it on until it heard of the
 * invalidation the way it hears of any other, and Next.js has the next request read what the
 * invalidation wrote: a Server Action's caller reloading the page it changed. Removed before
 * anything reaches a client, as every header of the platform's is. Written by
 * `invalidatedTagsValue`, read by `invalidatedTagsMatcher`.
 */
export const INVALIDATED_TAGS_HEADER = 'x-arkor-invalidated-tags';
/**
 * Beside `INVALIDATED_TAGS_HEADER`, where the host keeps revisions: the revision of the scope it
 * recorded the latest of those invalidations at. A record the host wrote at that revision or after
 * was written after them, and is not touched. A header of its own, so that a reader of the tags
 * from before it reads them as it did.
 */
export const INVALIDATED_REVISION_HEADER = 'x-arkor-invalidated-revision';
/** In `INVALIDATED_TAGS_HEADER`, for more tags than the header carries: every tag. */
const EVERY_TAG = '*';
/** The longest `INVALIDATED_TAGS_HEADER` a response carries; past it, `EVERY_TAG`. */
const INVALIDATED_TAGS_MAX_LENGTH = 8192;

/**
 * The status an app Function answers a request with when the route it is for is in another of the
 * deployment's app Functions — a deployment whose build split its routes across several
 * (`functions.split`). `421 Misdirected Request` says exactly that: this server is not the one to
 * produce the response.
 *
 * Only ever sent with `FUNCTION_HEADER`, naming the Function that holds the route, and with
 * `ROUTED_HEADER` where the request was routed on the way here. The body is the request's own, as
 * it arrived and unread, for the edge to send on. A 421 without `FUNCTION_HEADER` is the
 * application's own, and is no business of the edge's.
 */
export const MISDIRECTED_STATUS = 421;
/** On a `MISDIRECTED_STATUS` answer: the name of the app Function that holds the route. */
export const FUNCTION_HEADER = 'x-arkor-function';
/**
 * The visitor's country as the platform observed it. Left on the request for the application to
 * read, where a Vercel-hosted one read `x-vercel-ip-country`.
 */
export const IP_COUNTRY_HEADER = 'x-arkor-ip-country';

/**
 * Where a scope's tags stand: the revision of its latest change a reader may judge by, and when its
 * latest invalidation was recorded (unix ms), `null` where none was.
 */
export interface ScopeRevision {
  readonly revision: number;
  readonly invalidatedAt: number | null;
}

/** In `SCOPE_REVISION_HEADER`, for a scope none of whose tags was ever invalidated. */
const NEVER_INVALIDATED = '-';

/**
 * `scope` as `SCOPE_REVISION_HEADER` carries it: whole numbers, as `parseScopeRevision` reads them,
 * so a moment kept to a fraction of a millisecond still reads as one.
 */
export function scopeRevisionValue(scope: ScopeRevision): string {
  const at =
    scope.invalidatedAt === null ? NEVER_INVALIDATED : String(Math.trunc(scope.invalidatedAt));
  return `${String(Math.trunc(scope.revision))};${at}`;
}

/** A whole number a header can carry, or `undefined` for anything else. */
function wholeNumber(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** What `SCOPE_REVISION_HEADER` says; `undefined` for none, or for a value that does not read. */
export function parseScopeRevision(value: string | null): ScopeRevision | undefined {
  if (value === null) {
    return undefined;
  }
  const [revisionPart = '', atPart = '', ...rest] = value.split(';');
  const revision = wholeNumber(revisionPart);
  if (revision === undefined || rest.length > 0) {
    return undefined;
  }
  if (atPart === NEVER_INVALIDATED) {
    return { revision, invalidatedAt: null };
  }
  const invalidatedAt = wholeNumber(atPart);
  return invalidatedAt === undefined ? undefined : { revision, invalidatedAt };
}

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

/** `tag` escaped as a URI component, `*` with it; `undefined` for one with half a surrogate pair. */
function escapedTag(tag: string): string | undefined {
  try {
    return encodeURIComponent(tag).replaceAll('*', '%2A');
  } catch {
    return undefined;
  }
}

/**
 * The value of `INVALIDATED_TAGS_HEADER` for `tags`: each escaped as a URI component — a comma, a
 * character no header carries, and `*`, which stands for every tag, with it — and separated by
 * commas. `EVERY_TAG` for a list longer than the header carries, and for one with a tag no escape
 * can say (half a surrogate pair).
 */
export function invalidatedTagsValue(tags: Iterable<string>): string {
  const escaped: string[] = [];
  for (const tag of tags) {
    const one = escapedTag(tag);
    if (one === undefined) {
      return EVERY_TAG;
    }
    escaped.push(one);
  }
  const value = escaped.join(',');
  return value.length > INVALIDATED_TAGS_MAX_LENGTH ? EVERY_TAG : value;
}

/** The tags an `INVALIDATED_TAGS_HEADER` names; `undefined` for every tag. */
function namedTags(value: string): ReadonlySet<string> | undefined {
  if (value === EVERY_TAG) {
    return undefined;
  }
  try {
    return new Set(value.split(',').map((tag) => decodeURIComponent(tag)));
  } catch {
    // What it named cannot be told, so it may have named any.
    return undefined;
  }
}

/**
 * The revision an `INVALIDATED_REVISION_HEADER` names, or `undefined` for none — and for one that
 * cannot be read, which then bounds nothing.
 */
function namedRevision(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

/**
 * Whether what carries `tags`, written at `revision`, is touched by an `INVALIDATED_TAGS_HEADER` of
 * `value` and an `INVALIDATED_REVISION_HEADER` of `bound`: one of the tags is among those named —
 * any, where every tag is named or the list cannot be read — and, where the bound names a revision
 * and the record's is known, it was written before it.
 */
export function invalidatedTagsMatcher(
  value: string,
  bound?: string | null,
): (tags: readonly string[], revision?: number) => boolean {
  const named = namedTags(value);
  const below = namedRevision(bound);
  const before = (revision: number | undefined): boolean =>
    below === undefined || revision === undefined || revision < below;
  return named === undefined
    ? (tags, revision) => tags.length > 0 && before(revision)
    : (tags, revision) => before(revision) && tags.some((tag) => named.has(tag));
}
