import { RSC_CACHE_BUSTING_QUERY } from '@stayingupwind/core/request';
import { isHtmlContentType } from '@stayingupwind/core/util';

import { answeredBy, answerTo, type CheckedStack, undoneUnlessStored } from './answers.ts';
import {
  type CookieChanges,
  cookieChangesOf,
  cookieFor,
  type CookieJar,
  storedAfter,
  unprovedHolding,
} from './cookie-jar.ts';
import type { Reading } from './reading.ts';

/**
 * What a browser's fetch does with the redirects an answer makes (`redirectsFrom`): follows each to
 * a URL of the site's own, with the cookies it then holds for it, as far as a fetch follows — and,
 * for a router's request, asks the URL it lands on again as Next.js's router does (`createFetch`).
 */

export const COOKIE = 'cookie';

/**
 * What an answer did that a browser's fetch goes on from: what it did to the cookies the browser
 * keeps, the URL it redirects to (`Location`), where it redirects, and what the edge says of it.
 */
export interface Answered {
  readonly changes: CookieChanges;
  readonly location?: string | undefined;
  readonly account: string;
  /** The referrer policy it sets for the request a redirect of it leads to, where it sets one. */
  readonly referrerPolicy?: string | undefined;
  /** Whether it is a page a client router runs on (`routerPage`). */
  readonly page: boolean;
  /**
   * What it was, read whole, where it was: its status and bytes — what another ask of the same
   * request is held to where the edge served it (`landedPartFailure`).
   */
  readonly whole?: { readonly status: number; readonly length: number; readonly sha256: string };
}

/** What a page is found with, and what Next.js answers a path it has no page for with. */
const PAGE_FOUND = 200;
const PAGE_NOT_FOUND = 404;

/**
 * Whether `answer` is a page a client router runs on, which asks for another page's parts from it:
 * a document of HTML — its media type itself, not a type it begins (`text/htmlx`) — found, or
 * Next.js's not-found page; not an answer the middleware made of something else, which no router
 * comes with.
 */
function routerPage(answer: Reading): boolean {
  const html = isHtmlContentType(answer.headers['content-type'] ?? null);
  return html && (answer.status === PAGE_FOUND || answer.status === PAGE_NOT_FOUND);
}

/** `headers` with `cookie` as the cookies they carry, where there are any. */
export function cookieOn(
  headers: Readonly<Record<string, string>>,
  cookie: string | undefined,
): Readonly<Record<string, string>> {
  return cookie === undefined ? headers : { ...headers, [COOKIE]: cookie };
}

/** A request, as asked once of all the flows that ask it (`AnsweredAsks`). */
export function askKey(url: URL, headers: Readonly<Record<string, string>>): string {
  const sorted = Object.entries(headers).toSorted(([a], [b]) => (a < b ? -1 : Number(a > b)));
  return JSON.stringify([url.href, sorted]);
}

/**
 * What an answer to a request of `url` did to the cookies a browser keeps of the site — and what the
 * edge says of it, where it is read (`documentRedirects`).
 */
export interface Step {
  readonly url: URL;
  readonly changes: CookieChanges;
  readonly account?: string | undefined;
}

/** The statuses a browser's fetch follows to the URL `Location` names (`fetch`'s redirect status). */
const MOVED_PERMANENTLY = 301;
const FOUND = 302;
const SEE_OTHER = 303;
const TEMPORARY_REDIRECT = 307;
const PERMANENT_REDIRECT = 308;
const REDIRECTS: ReadonlySet<number> = new Set([
  FOUND,
  MOVED_PERMANENTLY,
  PERMANENT_REDIRECT,
  SEE_OTHER,
  TEMPORARY_REDIRECT,
]);
/** The most redirects a browser's fetch follows before it fails (`fetch`, step 7 of HTTP-redirect fetch). */
const MAX_REDIRECTS = 20;
/**
 * As often as Next.js's router asks again, with its own `_rsc`, a URL a redirect left without it
 * (`createFetch`): as Chrome follows redirects.
 */
const MAX_REPLAYS = 20;
/** Why the check proves nothing past a fetch's redirects that go on past as many as it follows. */
const TOO_MANY_REDIRECTS = `redirected past the ${MAX_REDIRECTS} redirects a browser's fetch follows, where it fails`;
/** As much of an answer as is read for the cookies it set: its headers alone. */
const HEADERS_ALONE = 1;
/** Where a navigation says it came from (Fetch Metadata), and what it says of another site. */
const FETCH_SITE = 'sec-fetch-site';
const CROSS_SITE = 'cross-site';

/** What `answer` did that a browser's fetch goes on from (`Answered`). */
export function answeredOf(answer: Reading): Answered {
  const location = REDIRECTS.has(answer.status) ? answer.headers.location : undefined;
  const referrerPolicy = referrerPolicyOf(answer.headers['referrer-policy']);
  const { status, length, sha256 } = answer;
  return {
    changes: cookieChangesOf(answer.headers),
    location,
    account: answeredBy(answer),
    ...(referrerPolicy !== undefined && { referrerPolicy }),
    page: routerPage(answer),
    ...(!answer.truncated && { whole: { status, length, sha256 } }),
  };
}

/** The referrer policies a `Referrer-Policy` may name (the Referrer Policy specification, §3). */
const REFERRER_POLICIES: ReadonlySet<string> = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

/**
 * The referrer policy a `Referrer-Policy` sets: the last it names that is one, as a browser parses
 * the header (§8.1); none where it names none.
 */
function referrerPolicyOf(value: string | readonly string[] | undefined): string | undefined {
  const listed = typeof value === 'string' ? value : (value ?? []).join(',');
  return listed
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .findLast((token) => REFERRER_POLICIES.has(token));
}

/** The header a request says the page it came from by. */
const REFERER = 'referer';

/**
 * What a request of `next` says of the page it came from under `policy`, of a page `said` names
 * (§3): the page as it was said, its origin alone, or nothing — no more of it than was said.
 */
function refererUnder(policy: string, said: string, next: URL): string | undefined {
  const page = new URL(said);
  const own = page.origin === next.origin;
  const origin = `${page.origin}/`;
  switch (policy) {
    case 'no-referrer': {
      return undefined;
    }
    case 'origin':
    case 'strict-origin': {
      return origin;
    }
    case 'same-origin': {
      return own ? said : undefined;
    }
    case 'origin-when-cross-origin':
    case 'strict-origin-when-cross-origin': {
      return own ? said : origin;
    }
    default: {
      return said;
    }
  }
}

/** `headers` saying of the page they came from what `policy` has a request of `next` say (`refererUnder`). */
function referredUnder(
  headers: Readonly<Record<string, string>>,
  policy: string,
  next: URL,
): Readonly<Record<string, string>> {
  const others = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== REFERER),
  );
  const said = Object.entries(headers).find(([name]) => name.toLowerCase() === REFERER)?.[1];
  const referer =
    said === undefined || !URL.canParse(said) ? undefined : refererUnder(policy, said, next);
  return referer === undefined ? others : { ...others, [REFERER]: referer };
}

/** `headers` without the cookies they carry. */
function uncookied(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== COOKIE));
}

/**
 * `page` with the router's cache-busting query, as the client router sets it
 * (`setCacheBustingSearchParamWithHash`): the query it had, as it was spelled, and `_rsc` last —
 * `busting`, or the name alone where that is empty.
 */
export function withBusting(page: URL, busting: string): URL {
  const raw = page.search.startsWith('?') ? page.search.slice(1) : page.search;
  const pairs = raw
    .split('&')
    .filter((pair) => pair !== '' && !pair.startsWith(`${RSC_CACHE_BUSTING_QUERY}=`));
  pairs.push(busting === '' ? RSC_CACHE_BUSTING_QUERY : `${RSC_CACHE_BUSTING_QUERY}=${busting}`);
  const url = new URL(page);
  url.search = `?${pairs.join('&')}`;
  return url;
}

/** A request as a browser's fetch makes it: where, with which headers. */
export interface Sent {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Where the redirects a browser's fetch follows from an answer came to (`redirectsFrom`): what each
 * answer on the way did to the cookies the browser keeps, in order; and the request the fetch ended
 * on, where a redirect led it to a URL of the site's own that answered without redirecting further
 * — what the fetch hands the page's script — or why the check proves nothing past them: a redirect
 * it could not read, or more than a fetch follows, where the fetch fails.
 */
export interface Followed {
  readonly steps: readonly Step[];
  readonly landed?: Sent | undefined;
  /** What the request the fetch ended on was answered with (`landed`), where it ended on one. */
  readonly last?: Answered | undefined;
  /** Whether what the fetch ended on is a page a client router runs on (`Answered.page`). */
  readonly page?: boolean | undefined;
  readonly failure?: string | undefined;
}

/** How many redirects the fetch asking now followed, and how often the router asked again. */
interface Counted {
  hops: number;
  replays: number;
}

/** Where a browser's fetch goes on from an answer (`onwardFrom`). */
type Onward =
  | { readonly kind: 'hop'; readonly url: URL }
  | { readonly kind: 'replay'; readonly url: URL }
  | { readonly kind: 'end' }
  | { readonly kind: 'left' }
  | { readonly kind: 'failed'; readonly failure: string };

/**
 * Where a browser's fetch goes on from an answer to `url`: to the URL of the site's own its
 * `Location` names (`hop`); where it redirects no further, but a redirect brought the fetch there,
 * to that URL again with the `_rsc` a router's request carries (`replay`), where it lacks it — as
 * Next.js's router asks again (`createFetch`); or nowhere: it landed there (`end`), it left the
 * site's answers — for another site's, or for a `Location` no browser can read, on which a fetch
 * fails (`left`) — or it failed past as many redirects as it follows.
 */
function onwardFrom(
  at: { readonly answered: Answered; readonly url: URL; readonly replay: string | undefined },
  counted: Readonly<Counted>,
): Onward {
  const { answered, url, replay } = at;
  const { location } = answered;
  if (location !== undefined) {
    const next = URL.canParse(location, url) ? new URL(location, url) : undefined;
    if (next?.origin !== url.origin) {
      return { kind: 'left' };
    }
    return counted.hops === MAX_REDIRECTS
      ? { kind: 'failed', failure: TOO_MANY_REDIRECTS }
      : { kind: 'hop', url: next };
  }
  const replays =
    replay !== undefined &&
    counted.hops > 0 &&
    counted.replays < MAX_REPLAYS &&
    url.searchParams.get(RSC_CACHE_BUSTING_QUERY) !== replay;
  return replays ? { kind: 'replay', url: withBusting(url, replay) } : { kind: 'end' };
}

/**
 * `counted` once the fetch went on as `kind` says: by another redirect, or by a fetch of the
 * router's own, which counts redirects afresh.
 */
function countOn(counted: Counted, kind: 'hop' | 'replay'): void {
  if (kind === 'replay') {
    counted.replays += 1;
    counted.hops = 0;
  } else {
    counted.hops += 1;
  }
}

/**
 * Where a fetch's redirects came to, where it went on no further (`Onward`): the request it ended
 * on, where a redirect brought it there; nowhere of the site's; or why the check proves nothing.
 */
function followedTo(
  onward: Exclude<Onward, { readonly kind: 'hop' | 'replay' }>,
  at: {
    readonly steps: readonly Step[];
    readonly landed: Sent;
    readonly last: Answered;
    readonly page: boolean;
  },
): Followed {
  const { steps } = at;
  switch (onward.kind) {
    case 'failed': {
      return { steps, failure: onward.failure };
    }
    case 'left': {
      return { steps };
    }
    case 'end': {
      return steps.length > 0 ? at : { steps };
    }
  }
}

/**
 * What the answer to `sent`, read for its headers alone — or whole, undone of its coding as a part
 * is read (`whole`) — did that a fetch goes on from — as it was answered before (`known`) — or why
 * it could not be read.
 */
async function hopAnswered(
  stack: CheckedStack,
  sent: Sent & { readonly method?: 'HEAD' | undefined; readonly whole?: boolean | undefined },
  known: Map<string, Answered>,
): Promise<Answered | string> {
  const { url, headers, method } = sent;
  // A request for its headers alone is another request than a GET of the same.
  const key = method === undefined ? askKey(url, headers) : `${method} ${askKey(url, headers)}`;
  const kept = known.get(key);
  if (kept !== undefined) {
    return kept;
  }
  const reading =
    sent.whole === true ? { decode: undoneUnlessStored(true) } : { limitBytes: HEADERS_ALONE };
  const read = await answerTo(url, { via: stack.url, headers, method, ...reading });
  if (typeof read === 'string') {
    return read;
  }
  const reply = answeredOf(read);
  known.set(key, reply);
  return reply;
}

/**
 * What the redirects a browser's fetch follows from `answered` did to the cookies it keeps, each in
 * order: to a URL of the site's own `Location` names, asked again as it was asked, with the cookies
 * the browser then holds for it — those of `jar` once each answer before set theirs, which may be
 * other than those it held for the URL first asked — read for its headers alone (`hopAnswered`); for
 * a router's request (`replay`, the `_rsc` it carries), with each URL it lands on asked again as
 * Next.js's router asks it (`onwardFrom`) — and where they came to (`Followed`).
 */
export async function redirectsFrom(
  stack: CheckedStack,
  from: {
    readonly answered: Answered;
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly jar: CookieJar;
    readonly replay?: string | undefined;
    /** Whether another site began the navigation the redirects are of (`cookieFor`). */
    readonly crossSite?: boolean | undefined;
    /** A request for headers alone (`HEAD`), which a fetch follows as one (Fetch, HTTP-redirect fetch). */
    readonly method?: 'HEAD' | undefined;
    /**
     * Whether each answer on the way is read whole, as a part is read (`hopAnswered`): that the one
     * the fetch ends on may be held to what the check reads when it asks the same again.
     */
    readonly whole?: boolean | undefined;
  },
  known: Map<string, Answered>,
): Promise<Followed> {
  const steps: Step[] = [];
  let { answered, url, headers } = from;
  let jar = storedAfter(from.jar, answered.changes, url);
  const counted: Counted = { hops: 0, replays: 0 };
  // The referrer policy each redirect leaves the next request under: the page's, where none set one.
  let policy = answered.referrerPolicy;
  for (;;) {
    const onward = onwardFrom({ answered, url, replay: from.replay }, counted);
    if (onward.kind !== 'hop' && onward.kind !== 'replay') {
      const at = { steps, landed: { url, headers }, last: answered, page: answered.page };
      return followedTo(onward, at);
    }
    countOn(counted, onward.kind);
    // A fetch of the router's own goes under its page's policy again.
    policy = onward.kind === 'replay' ? undefined : policy;
    const next = onward.url;
    // With the cookies the browser holds for it, where the check proves which those are.
    const held = unprovedHolding(jar);
    if (held !== undefined) {
      return { steps, failure: `redirected to ${next.pathname}, ${held}` };
    }
    const referred =
      policy === undefined ? from.headers : referredUnder(from.headers, policy, next);
    const cookie = cookieFor(jar, next, { crossSite: from.crossSite === true });
    headers = cookieOn(uncookied(referred), cookie);
    const asked = { url: next, headers, method: from.method, whole: from.whole };
    const reply = await hopAnswered(stack, asked, known);
    if (typeof reply === 'string') {
      return { steps, failure: `redirected to ${next.pathname}, ${reply}` };
    }
    steps.push({ url: next, changes: reply.changes, account: reply.account });
    jar = storedAfter(jar, reply.changes, next);
    policy = reply.referrerPolicy ?? policy;
    answered = reply;
    url = next;
  }
}

/**
 * `jar` once each of `steps` did what it did, in order: each cookie kept under its own URL's — or
 * why the check proves nothing a browser then sends, where one of them left it holding what the
 * check does not follow (`unprovedHolding`).
 */
export function stepsApplied(
  jar: CookieJar,
  steps: readonly Step[],
): { readonly jar: CookieJar; readonly unproved?: string } {
  let kept = jar;
  for (const { url, changes } of steps) {
    kept = storedAfter(kept, changes, url);
    const unproved = unprovedHolding(kept);
    if (unproved !== undefined) {
      return { jar: kept, unproved };
    }
  }
  return { jar: kept };
}

/** Whether `answer` redirects a browser's fetch (`Location`), wherever to. */
export function redirects(answer: Reading): boolean {
  return answeredOf(answer).location !== undefined;
}

/**
 * What a document's answer, and each redirect a browser's navigation follows from it with the
 * cookies of `jar` — those it was sent with, kept for its page — did to the cookies the browser keeps
 * (`redirectsFrom`), in order — each read for its headers alone, or as it was answered before
 * (`known`), and with what the edge says of it: the last, of the page the browser lands on — and the
 * request it asked for that page with, where a redirect brought it there; or why the check proves
 * nothing past them.
 */
export async function documentRedirects(
  stack: CheckedStack,
  from: {
    readonly answer: Reading;
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly jar: CookieJar;
  },
  known = new Map<string, Answered>(),
): Promise<{
  readonly steps: readonly Step[];
  readonly landed?: Sent | undefined;
  /** Whether the answer the browser ends on is a page a client router runs on (`Answered.page`). */
  readonly page?: boolean | undefined;
  readonly failure?: string | undefined;
}> {
  const answered = answeredOf(from.answer);
  const own = { url: from.url, changes: answered.changes, account: answered.account };
  if (answered.location === undefined) {
    return { steps: [own], page: answered.page };
  }
  // Another site's navigation is one through every redirect of it.
  const site = Object.entries(from.headers).find(
    ([name]) => name.toLowerCase() === FETCH_SITE,
  )?.[1];
  const crossSite = site === CROSS_SITE;
  const followed = { answered, url: from.url, headers: from.headers, jar: from.jar, crossSite };
  const { steps, landed, page, failure } = await redirectsFrom(stack, followed, known);
  return { steps: [own, ...steps], landed, page, failure };
}
