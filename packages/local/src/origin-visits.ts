import { NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';

import { answerTo, type CheckedStack, forwarded } from './answers.ts';
import { visitedNavigations } from './browsers.ts';
import { browserCodingsOf } from './codings.ts';
import { cookieFor, type CookieJar, strictly } from './cookie-jar.ts';
import { documentRouteAt } from './landings.ts';
import type { Reading } from './reading.ts';
import {
  type Answered,
  askKey,
  COOKIE,
  documentRedirects,
  redirects,
  type Step,
} from './redirects.ts';

/**
 * A browser's visit to a page of the site's, as it navigates there (`visitsOf`): what the page's
 * answer did to the cookies it keeps — that of a page other than the one whose parts a router on it
 * asks for, which that router carries them to.
 */

/** Where client hints begin, which Chromium browsers alone send. */
const ANY_CLIENT_HINT_PREFIX = 'sec-ch-';

/**
 * What a browser says of itself with every navigation, besides its hints: what it accepts, its
 * agent, its language, and that it would rather a page over HTTPS (`Upgrade-Insecure-Requests`).
 */
const OWN_NAVIGATION_HEADERS = new Set([
  'accept',
  'accept-language',
  'upgrade-insecure-requests',
  'user-agent',
]);

/**
 * The navigation `navigation`'s browser makes of another page of the site's: that it is one (Fetch
 * Metadata), and what the browser says of itself with it (`OWN_NAVIGATION_HEADERS`, its hints) —
 * none of what else `navigation` sent: what the check carried past a rule that claimed the page it
 * asked for without it, which the browser sends no other page, nor its cookies, which the jar it
 * visits with sends in their place.
 */
function ownNavigationOf(navigation: Readonly<Record<string, string>>): Record<string, string> {
  const own = Object.entries(navigation).filter(([name]) => {
    const lower = name.toLowerCase();
    return OWN_NAVIGATION_HEADERS.has(lower) || lower.startsWith(ANY_CLIENT_HINT_PREFIX);
  });
  return { ...Object.fromEntries(own), ...NAVIGATION_REQUEST_HEADERS };
}

/** Where a navigation says it came from (Fetch Metadata), and what it says of another site. */
const FETCH_SITE = 'sec-fetch-site';
const CROSS_SITE = 'cross-site';

/** As much of a page as a visit to it is read for: its headers alone. */
const HEADERS_ALONE = 1;

/** Each page's answer to a visit, by the request, as the check read it once of a stack. */
const visited = new WeakMap<CheckedStack, Map<string, Reading | string>>();
/** Each redirect a visit followed, by the request, as the check read it once of a stack. */
const followed = new WeakMap<CheckedStack, Map<string, Answered>>();

/** The answer to a visit asked as `headers`, read for its headers alone once of a stack. */
async function visitAnswer(
  stack: CheckedStack,
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<Reading | string> {
  const answers = visited.get(stack) ?? new Map<string, Reading | string>();
  visited.set(stack, answers);
  const key = askKey(url, headers);
  const known = answers.get(key);
  if (known !== undefined) {
    return known;
  }
  const answer = await answerTo(url, { via: stack.url, headers, limitBytes: HEADERS_ALONE });
  answers.set(key, answer);
  return answer;
}

/** A browser's visit to a page, as it came to: what its answers did to its cookies, in order. */
export interface Visit {
  readonly steps: readonly Step[];
  /** Where the visit came from, in a verdict's words, where that is said. */
  readonly as: string;
  /** The page of the build's a redirect left the browser on, where it left it on another. */
  readonly at?: URL | undefined;
}

/**
 * What a browser that holds `jar` keeps once it navigated to `url` — another page of the site's
 * than the one whose parts its router asks for there — as `navigation`'s browser navigates to a page
 * (`ownNavigationOf`), from each place a navigation comes from (`visitedNavigations`), in what it
 * accepts at once, with the cookies each jar it may hold as it does sends there
 * (`jarsVisitingWith`), under the site's origin (`forwarded`): what the page's answer, and each
 * redirect a browser follows from it, did to them (`documentRedirects`) — and the page of the
 * build's it landed on, where it redirected (`Visit.at`); none of one that left for no page of the
 * build's, or ended on an answer no router runs on (`Answered.page`), which leaves no browser on a
 * page whose router asks from there.
 * Why the check proves none, where one could not be followed.
 */
export async function visitsOf(
  stack: CheckedStack,
  visit: {
    readonly url: URL;
    readonly navigation: Readonly<Record<string, string>>;
    readonly jar: CookieJar;
    /** The browser that visits, in a verdict's words. */
    readonly by: string;
  },
): Promise<{ readonly visits: readonly Visit[]; readonly failure?: string }> {
  const { url, navigation } = visit;
  const coding = browserCodingsOf(navigation['user-agent']);
  const visits: Visit[] = [];
  const navigations = visitedNavigations(ownNavigationOf(navigation), url);
  for (const { headers: from, as } of navigations) {
    const by = `its visit${visit.by} to ${url.pathname}${as}`;
    const { jars, unproved } = jarsVisitingWith(visit.jar, from);
    if (unproved !== undefined) {
      return { visits: [], failure: `${by}, ${unproved}` };
    }
    const headers = forwarded(url, { ...from, 'accept-encoding': coding });
    const crossSite = from[FETCH_SITE] === CROSS_SITE;
    const made = await visitsWith(stack, { url, headers, crossSite, jars, by, as });
    if (made.failure !== undefined) {
      return { visits: [], failure: made.failure };
    }
    visits.push(...made.visits);
  }
  return { visits };
}

/** A jar a browser may visit a page with, and how it differs from the one it holds, in words. */
interface VisitingJar {
  readonly jar: CookieJar;
  readonly said: string;
}

/**
 * The visits one navigation asked as `headers` makes, with each jar a browser may hold as it does
 * (`jarsVisitingWith`), and the cookies each sends there: what each came to (`visitMade`), said as
 * where the navigation came from (`as`); or why the check proves none, where one could not be
 * followed.
 */
async function visitsWith(
  stack: CheckedStack,
  asked: {
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    /** Whether another site began the navigation, whose browser withholds `SameSite=Strict` cookies. */
    readonly crossSite: boolean;
    readonly jars: readonly VisitingJar[];
    /** The visit, in a verdict's words. */
    readonly by: string;
    /** Where its navigation came from, in a verdict's words. */
    readonly as: string;
  },
): Promise<{ readonly visits: readonly Visit[]; readonly failure?: string }> {
  const { url, crossSite } = asked;
  const known = followed.get(stack) ?? new Map<string, Answered>();
  followed.set(stack, known);
  const came = asked.as === '' ? '' : `, having navigated to it${asked.as.slice(1)}`;
  const visits: Visit[] = [];
  for (const { jar, said } of asked.jars) {
    const cookie = cookieFor(jar, url, { crossSite });
    const headers = { ...asked.headers, ...(cookie !== undefined && { [COOKIE]: cookie }) };
    const made = await visitMade(stack, { url, headers, jar, known, by: `${asked.by}${said}` });
    if (typeof made === 'string') {
      return { visits: [], failure: made };
    }
    if (made !== undefined) {
      visits.push({ ...made, as: `${came}${said}${made.as}` });
    }
  }
  return { visits };
}

/**
 * The most cookies a navigation another site began may withhold each of on its own
 * (`SameSite=Strict`), every set of which the check follows — past which it proves none
 * (`withheldSets`).
 */
const MAX_WITHHELD = 4;

/**
 * Every set of the places `open` names — the cookies a navigation another site began may each
 * withhold (`SameSite=Strict`), which no header says of any — none of them first; or why the check
 * proves none, where they are more than it follows (`MAX_WITHHELD`).
 */
export function withheldSets(open: readonly number[]): {
  readonly sets: readonly (readonly number[])[];
  readonly unproved?: string;
} {
  if (open.length > MAX_WITHHELD) {
    return {
      sets: [],
      unproved: `its ${open.length} cookies may each be kept from other sites' navigations, more than the check follows every set of (${MAX_WITHHELD}): no request proves them`,
    };
  }
  const sets = Array.from({ length: 2 ** open.length }, (_, set) =>
    open.filter((_at, place) => Math.floor(set / 2 ** place) % 2 === 1),
  );
  return { sets };
}

/** The cookies `names` kept from other sites' navigations, in a verdict's words: none, nothing. */
export function withheldWords(names: readonly string[]): string {
  if (names.length === 0) {
    return '';
  }
  const noun = names.length === 1 ? 'cookie' : 'cookies';
  return `, its ${noun} ${names.join(', ')} kept from other sites' navigations`;
}

/**
 * The jars a browser that holds `jar` may visit a page with as `from` navigates there: `jar` itself
 * — and, where another site began the navigation, `jar` with each set of its cookies kept from
 * those (`SameSite=Strict`, `strictly`), as each of a navigation's own may be apart from the
 * others, which no header says; or why the check proves none, where they are more than it follows
 * (`MAX_WITHHELD`).
 */
function jarsVisitingWith(
  jar: CookieJar,
  from: Readonly<Record<string, string>>,
): { readonly jars: readonly VisitingJar[]; readonly unproved?: string } {
  // Each that is not kept so already, which a visit another site began withholds whatever else.
  const open = jar.flatMap((cookie, at) => (cookie.strict === true ? [] : [at]));
  if (from[FETCH_SITE] !== CROSS_SITE || open.length === 0) {
    return { jars: [{ jar, said: '' }] };
  }
  // Every set of them, by the places each holds in the jar.
  const { sets, unproved } = withheldSets(open);
  return unproved === undefined
    ? { jars: sets.map((kept) => keptFrom(jar, kept)) }
    : { jars: [], unproved };
}

/**
 * `jar` with its cookies at the places `kept` names kept from other sites' navigations
 * (`strictly`), and those in words.
 */
function keptFrom(jar: CookieJar, kept: readonly number[]): VisitingJar {
  const said = withheldWords(kept.map((at) => jar[at]?.name ?? ''));
  return { jar: strictly(jar, new Set(kept)), said };
}

/**
 * What one visit came to, asked as `headers` (`documentRedirects`): what its answers did to the
 * cookies, and the page of the build's it landed on, where it redirected — none where it ended on
 * an answer no router runs on (`Answered.page`), or left for no page of the build's; or why the
 * check proves none, where it could not be followed.
 */
async function visitMade(
  stack: CheckedStack,
  asked: {
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly jar: CookieJar;
    readonly known: Map<string, Answered>;
    readonly by: string;
  },
): Promise<Visit | string | undefined> {
  const { url, headers, jar, known, by } = asked;
  const answer = await visitAnswer(stack, url, headers);
  if (typeof answer === 'string') {
    return `${by}, ${answer}`;
  }
  const { steps, landed, page, failure } = await documentRedirects(
    stack,
    { answer, url, headers, jar },
    known,
  );
  if (failure !== undefined) {
    return `${by}, ${failure}`;
  }
  // Only on a page a router runs on, which none of anything else is: where it stayed, or where it
  // landed, a page of the build's whose router goes on from there.
  if (page !== true) {
    return undefined;
  }
  if (!redirects(answer)) {
    return { steps, as: '' };
  }
  const routed =
    landed !== undefined &&
    documentRouteAt(stack.manifest, landed.url, landed.headers) !== undefined;
  return routed ? { steps, as: `, landing on ${landed.url.pathname}`, at: landed.url } : undefined;
}
