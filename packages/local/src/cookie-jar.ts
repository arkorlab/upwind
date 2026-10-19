import type { IncomingHttpHeaders } from 'node:http';

import { parseCookieHeader } from '@stayingupwind/core/request';
import { getDomain, getPublicSuffix } from 'tldts';

/**
 * The cookies a browser sends with a request a page makes of its own site once the page's document,
 * and the requests it made before, set some — as a browser keeps them (RFC 6265 §5.3, §5.4): those
 * the navigation was asked with, and each a `Set-Cookie` of an answer's stores, over the one it is
 * the same cookie as, by its name, where it is kept and its path — but none the browser refuses, nor
 * one it keeps for other requests, nor one that has ended, nor any an answer cleared
 * (`Clear-Site-Data`).
 */

/** A cookie as a browser keeps it: the same cookie as another by its name, domain and path. */
interface StoredCookie {
  readonly name: string;
  readonly value: string;
  /** The host that set it, where it is that host's alone, or the domain it names. */
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  /**
   * When it ends, in milliseconds since the epoch, as Chrome and Firefox read it: none for one the
   * session keeps.
   */
  readonly expires?: number | undefined;
  /**
   * When it ends as a browser that reads its `Expires` by its own clock reads it, where that is
   * another time than Chrome and Firefox read, against the `Date` of the answer that set it
   * (`endsOf`).
   */
  readonly unadjusted?: number | undefined;
  /**
   * Whether it goes with no request of a navigation another site began (`SameSite=Strict`), which
   * a `Lax` or `None` one goes with all the same (RFC 6265bis §5.8.3).
   */
  readonly strict?: boolean | undefined;
  /**
   * Whether it is kept apart by the site it is set under (`Partitioned`), beside one of the same
   * name, domain and path that is not — another cookie, which a request of that site carries too
   * (the CHIPS storage model, a cookie's partition key part of what names it).
   */
  readonly partitioned?: boolean | undefined;
}

/** What a `Set-Cookie` says of a cookie beside its name and value, each the last of its name. */
interface Attributes {
  readonly 'max-age'?: string;
  readonly expires?: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: string;
  readonly samesite?: string;
  readonly partitioned?: string;
  readonly httponly?: string;
}

/** A control character but a tab, which a browser refuses a cookie for (RFC 6265bis §5.6, §5.7). */
// eslint-disable-next-line no-control-regex -- the control characters RFC 6265bis names, matched as such.
const CONTROL = /[\u{0}-\u{8}\u{A}-\u{1F}\u{7F}]/u;
/** The most octets a browser keeps a cookie's name and value of, together (§5.6). */
const COOKIE_OCTETS = 4096;
/** Prefixes a nameless cookie's value may not begin with, as it would read as a prefixed name. */
const PREFIXED = /^__(?:secure|host)-/iu;

const SECURE_PREFIX = '__secure-';
const HOST_PREFIX = '__host-';
/**
 * Prefixes Chrome enforces since 140 and Safari does not know (RFC 6265bis's `__Http-` and
 * `__Host-Http-`): a cookie named so must be secure and HttpOnly, as set by a server alone.
 */
const HTTP_PREFIXES: readonly string[] = ['__http-', '__host-http-'];
/** An address of this machine's loopback, which a browser counts as secure over plain HTTP. */
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/u;

/** Whether a browser counts `url` as a secure origin: HTTPS, or this machine over plain HTTP. */
export function trustworthy(url: URL): boolean {
  const host = url.hostname;
  return (
    url.protocol === 'https:' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    LOOPBACK_V4.test(host)
  );
}

/** The most octets of an attribute's value a browser reads; one longer it ignores (§5.6, step 6). */
const ATTRIBUTE_OCTETS = 1024;

/**
 * The attributes of a `Set-Cookie` after its name and value, by their names in lower case — but one
 * whose value is longer than a browser reads, which it ignores, as if it were not there.
 */
function attributesOf(parts: readonly string[]): Attributes {
  const attributes: Record<string, string> = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    const name = (separator === -1 ? part : part.slice(0, separator)).trim().toLowerCase();
    const value = separator === -1 ? '' : part.slice(separator + 1).trim();
    if (Buffer.byteLength(value) <= ATTRIBUTE_OCTETS) {
      attributes[name] = value;
    }
  }
  return attributes;
}

/** What separates the tokens of a cookie's date (RFC 6265 §5.1.1, `delimiter`). */
const DATE_DELIMITERS = /[\t\u{20}-\u{2F}\u{3B}-\u{40}\u{5B}-\u{60}\u{7B}-\u{7E}]+/u;
const DATE_TIME = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D|$)/u;
const DAY_OF_MONTH = /^(\d{1,2})(?:\D|$)/u;
const DATE_YEAR = /^(\d{2,4})(?:\D|$)/u;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** How many letters of a month's name a cookie's date reads it by. */
const MONTH_LETTERS = 3;
/** A year of two digits from which on a cookie's date reads it in the 1900s, and below it the 2000s. */
const TWENTIETH = 70;
const NINETEEN_HUNDRED = 1900;
const TWO_THOUSAND = 2000;
const CENTURY = 100;
/** The earliest year a cookie's date may name, and the last day, hour, minute and second. */
const FIRST_YEAR = 1601;
const LAST_DAY = 31;
const LAST_HOUR = 23;
const LAST_MINUTE = 59;

/** What a cookie's date says, token by token, as RFC 6265 §5.1.1 reads it: the first of each. */
interface DateFields {
  time?: readonly [number, number, number];
  day?: number;
  month?: number;
  year?: number;
}

/** `word` read into the first field of a cookie's date it is, of those not read yet. */
function readDateWord(fields: DateFields, word: string): void {
  const time = fields.time === undefined ? DATE_TIME.exec(word) : null;
  if (time !== null) {
    fields.time = [Number(time[1]), Number(time[2]), Number(time[3])];
    return;
  }
  const day = fields.day === undefined ? DAY_OF_MONTH.exec(word) : null;
  if (day !== null) {
    fields.day = Number(day[1]);
    return;
  }
  const named = word.slice(0, MONTH_LETTERS).toLowerCase();
  const month = fields.month === undefined ? MONTHS.indexOf(named) : -1;
  if (month !== -1) {
    fields.month = month;
    return;
  }
  const year = fields.year === undefined ? DATE_YEAR.exec(word) : null;
  if (year !== null) {
    fields.year = Number(year[1]);
  }
}

/**
 * When a cookie's `Expires` says it ends, as a browser reads it (RFC 6265 §5.1.1) — not as the
 * JavaScript date parser does, which reads what no browser does — or none for a date it cannot
 * read: one missing a time, a day, a month or a year, or with one out of its range.
 */
function cookieDateOf(value: string): number | undefined {
  const fields: DateFields = {};
  for (const word of value.split(DATE_DELIMITERS)) {
    if (word.length > 0) {
      readDateWord(fields, word);
    }
  }
  const { time, day, month } = fields;
  if (time === undefined || day === undefined || month === undefined || fields.year === undefined) {
    return undefined;
  }
  const century = fields.year < TWENTIETH ? TWO_THOUSAND : NINETEEN_HUNDRED;
  const year = fields.year < CENTURY ? fields.year + century : fields.year;
  const [hour, minute, second] = time;
  const outOfRange =
    day < 1 ||
    day > LAST_DAY ||
    year < FIRST_YEAR ||
    hour > LAST_HOUR ||
    minute > LAST_MINUTE ||
    second > LAST_MINUTE;
  if (outOfRange) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  return date.getUTCDate() === day ? date.getTime() : undefined;
}

const MS_PER_SECOND = 1000;

/** The seconds a cookie's `Max-Age` says, where it says a whole number of them (RFC 6265 §5.2.2). */
function maxAgeOf(attributes: Attributes): number | undefined {
  const maxAge = attributes['max-age'];
  return maxAge !== undefined && /^-?\d+$/u.test(maxAge) ? Number(maxAge) : undefined;
}

/**
 * When a cookie with these attributes ends — `Max-Age` seconds from `now`, and at once for none, or
 * else when `Expires` says — or none, for one the session alone keeps (RFC 6265 §5.2.1, §5.2.2,
 * §5.3, step 3).
 */
function expiryOf(attributes: Attributes, now: number): number | undefined {
  const seconds = maxAgeOf(attributes);
  if (seconds !== undefined) {
    return seconds <= 0 ? -Infinity : now + seconds * MS_PER_SECOND;
  }
  return attributes.expires === undefined ? undefined : cookieDateOf(attributes.expires);
}

/**
 * When a cookie with these attributes ends (`expiryOf`), as Chrome and Firefox read it: an `Expires`
 * of its own — no `Max-Age` — moved on by how far the `Date` of the answer that set it was behind
 * their clock (`skew`), as each reads it against that Date (Chromium's `ParseExpiration`, Firefox's
 * `network.cookie.useServerTime`); and when it ends as a browser that reads it by its own clock
 * does, where that is another time (`unadjusted`), which Safari's unpublished cookie store may.
 */
function endsOf(
  attributes: Attributes,
  now: number,
  skew: number | undefined,
): Pick<StoredCookie, 'expires' | 'unadjusted'> {
  const expires = expiryOf(attributes, now);
  if (
    expires === undefined ||
    skew === undefined ||
    skew === 0 ||
    maxAgeOf(attributes) !== undefined
  ) {
    return { expires };
  }
  return { expires: expires + skew, unadjusted: expires };
}

/** Whether what ends at `at` has ended by `now`: never, for a cookie the session alone keeps. */
function ends(at: number | undefined, now: number): boolean {
  return at !== undefined && at <= now;
}

/**
 * Whether a cookie has ended by `now`, which a browser then keeps and sends no more (§5.3): as
 * every browser reads its end, against its answer's `Date` or by its own clock (`unadjusted`).
 */
function endedBy(cookie: Pick<StoredCookie, 'expires' | 'unadjusted'>, now: number): boolean {
  return (
    ends(cookie.expires, now) && (cookie.unadjusted === undefined || ends(cookie.unadjusted, now))
  );
}

/**
 * Whether a cookie has ended by `now` as one browser reads its end and not as another does: against
 * its answer's `Date`, or by its own clock (`unadjusted`).
 */
function endedApart(cookie: Pick<StoredCookie, 'expires' | 'unadjusted'>, now: number): boolean {
  return (
    cookie.unadjusted !== undefined && ends(cookie.expires, now) !== ends(cookie.unadjusted, now)
  );
}

/**
 * Where a cookie set without a path of its own is kept: the directory of the path of the request
 * whose answer set it.
 */
function defaultPath(answered: URL): string {
  const last = answered.pathname.lastIndexOf('/');
  return last <= 0 ? '/' : answered.pathname.slice(0, last);
}

/** Whether `host` is a cookie's domain or under it, as the cookie covers it. */
function domainMatches(host: string, cookie: Pick<StoredCookie, 'domain' | 'hostOnly'>): boolean {
  return host === cookie.domain || (!cookie.hostOnly && host.endsWith(`.${cookie.domain}`));
}

/**
 * Where a cookie a `Set-Cookie` of `host`'s names `named` the domain of is kept: the host's alone
 * where it names none, or names a domain no site holds — a public suffix, `co.uk`, `github.io` —
 * that is the host itself; the domain it names where the host is under it. None where a browser
 * refuses it: a public suffix that is not the host, or a domain the host is not under (RFC 6265bis
 * §5.7, steps 9 and 10), by the list browsers judge suffixes by.
 */
function keptUnder(
  named: string,
  host: string,
): Pick<StoredCookie, 'domain' | 'hostOnly'> | undefined {
  const suffix = named !== '' && getPublicSuffix(named, { allowPrivateDomains: true }) === named;
  if (suffix && named !== host) {
    return undefined;
  }
  const hostOnly = named === '' || suffix;
  const kept = { domain: hostOnly ? host : named, hostOnly };
  return domainMatches(host, kept) ? kept : undefined;
}

/**
 * Whether a cookie's name asks of it what it lacks, as a browser reads its prefix — in any case
 * (RFC 6265bis §5.4): `__Secure-` that it be secure; `__Host-` that it be secure, its host's alone,
 * and set under the root path by a `Path=/` of its own (§5.7, step 21) — not left to the document's,
 * nor to a `Path` of no such value that the document's stands in for.
 */
function prefixRefuses(
  name: string,
  cookie: Pick<StoredCookie, 'hostOnly' | 'path' | 'secure'> & { readonly rootNamed: boolean },
): boolean {
  const lower = name.toLowerCase();
  const rooted = cookie.rootNamed && cookie.path === '/';
  return (
    (lower.startsWith(SECURE_PREFIX) && !cookie.secure) ||
    (lower.startsWith(HOST_PREFIX) && (!cookie.secure || !cookie.hostOnly || !rooted))
  );
}

/**
 * Why browsers keep a cookie apart, in a verdict's words, where its name — or, for a nameless one,
 * its value — begins with a prefix Chrome enforces and Safari does not know (`HTTP_PREFIXES`) and it
 * lacks what that prefix asks: secure, and HttpOnly — the rest of what `__Host-Http-` asks is
 * `__Host-`'s, which every browser enforces (`prefixRefuses`). Chrome refuses such a cookie, and a
 * browser that does not know the prefix keeps it as any other.
 */
function prefixApart(
  pair: { readonly name: string; readonly value: string },
  cookie: { readonly secure: boolean; readonly httpOnly: boolean },
): string | undefined {
  const named = pair.name === '' ? pair.value : pair.name;
  const lower = named.toLowerCase();
  const prefixed = HTTP_PREFIXES.some((prefix) => lower.startsWith(prefix));
  if (!prefixed || (pair.name !== '' && cookie.secure && cookie.httpOnly)) {
    return undefined;
  }
  return `cookie ${named} lacks what its prefix asks — secure, and HttpOnly — which Chrome refuses it for and a browser that does not know the prefix (Safari) keeps it all the same: no request proves whether a browser sends it`;
}

/**
 * A `Set-Cookie`'s name and value, before its first `;`, as a browser parses them (RFC 6265bis §5.6):
 * a name kept with the spaces inside it, and none before an `=` where there is no `=` — a nameless
 * cookie, all value. None where a browser refuses the cookie: for a control character anywhere in
 * it, for no name and no value, for more octets than it keeps, or for a nameless one whose value
 * reads as a prefixed name (§5.7, step 22).
 */
function pairOf(line: string): { readonly name: string; readonly value: string } | undefined {
  const [pair = ''] = line.split(';', 1);
  const separator = pair.indexOf('=');
  const name = separator === -1 ? '' : pair.slice(0, separator).trim();
  const value = (separator === -1 ? pair : pair.slice(separator + 1)).trim();
  const octets = Buffer.byteLength(name) + Buffer.byteLength(value);
  const refused =
    CONTROL.test(line) ||
    (name === '' && (value === '' || PREFIXED.test(value))) ||
    octets > COOKIE_OCTETS;
  return refused ? undefined : { name, value };
}

/**
 * The cookie a `Set-Cookie` of the answer to `answered` sets, as a browser stores it, and whether it
 * expires it at once — or none, where it refuses it: one it cannot parse (`pairOf`), one for another site or a
 * domain no site holds (`keptUnder`), one for secure origins alone where the site is none (`Secure`),
 * one that is not secure though sent to other sites' requests (`SameSite=None`, §5.7, step 19) or
 * kept apart by the site it is set under (`Partitioned`, which Chrome and Firefox refuse so), or one
 * whose prefix asks of it what it lacks (`prefixRefuses`).
 */
function storedOf(
  line: string,
  answered: URL,
  read: { readonly now: number; readonly skew: number | undefined },
):
  | { readonly cookie: StoredCookie; readonly expired: boolean; readonly apart?: string }
  | undefined {
  const { now } = read;
  const pair = pairOf(line);
  if (pair === undefined) {
    return undefined;
  }
  const attributes = attributesOf(line.split(';').slice(1));
  const named = attributes.domain?.replace(/^\./u, '').toLowerCase() ?? '';
  const kept = keptUnder(named, answered.hostname.toLowerCase());
  if (kept === undefined) {
    return undefined;
  }
  const secure = attributes.secure !== undefined;
  const path = attributes.path?.startsWith('/') === true ? attributes.path : defaultPath(answered);
  const wantsSecure =
    attributes.samesite?.toLowerCase() === 'none' || attributes.partitioned !== undefined;
  if (
    prefixRefuses(pair.name, { ...kept, path, secure, rootNamed: attributes.path === '/' }) ||
    (secure ? !trustworthy(answered) : wantsSecure)
  ) {
    return undefined;
  }
  const strict = attributes.samesite?.toLowerCase() === 'strict';
  const partitioned = attributes.partitioned !== undefined;
  const apart = prefixApart(pair, { secure, httpOnly: attributes.httponly !== undefined });
  const cookie = {
    ...pair,
    ...kept,
    path,
    secure,
    ...endsOf(attributes, now, read.skew),
    ...(strict && { strict }),
    ...(partitioned && { partitioned }),
  };
  const expired = endedBy(cookie, now);
  return apart === undefined ? { cookie, expired } : { cookie, expired, apart };
}

/** Whether a request at `pathname` is under a cookie's path (RFC 6265 §5.1.4). */
function pathMatches(pathname: string, path: string): boolean {
  return (
    pathname === path ||
    (pathname.startsWith(path) && (path.endsWith('/') || pathname[path.length] === '/'))
  );
}

/**
 * Whether `set` is the same cookie to a browser as one it `kept`: by name, path, and where it is kept
 * — its domain, and whether it is its host's alone (RFC 6265bis §5.7, step 23) — and whether it is
 * kept apart by the site it is set under (`partitioned`).
 */
function sameCookie(kept: StoredCookie, set: StoredCookie): boolean {
  return (
    kept.name === set.name &&
    kept.path === set.path &&
    kept.domain === set.domain &&
    kept.hostOnly === set.hostOnly &&
    (kept.partitioned === true) === (set.partitioned === true)
  );
}

/** The paths a cookie sent with a document at `pathname` may be kept under, the longest first. */
function pathsAbove(pathname: string): readonly string[] {
  const paths: string[] = [];
  for (let path = pathname; path.length > 1; path = path.slice(0, path.lastIndexOf('/')) || '/') {
    paths.push(path);
  }
  return [...paths, '/'];
}

/**
 * Every path a cookie sent with a document at `pathname` may be kept under (`pathMatches`), the
 * longest first: each above it (`pathsAbove`), and each of those but the root and its own with a
 * slash after it (`/shop/` for `/shop/item`), which is a path of its own.
 */
export function scopePathsAbove(pathname: string): readonly string[] {
  const above = pathsAbove(pathname);
  return above.flatMap((path) => {
    const slashed = `${path}/`;
    const own = path === pathname || path.endsWith('/') || above.includes(slashed);
    return own || !pathMatches(pathname, slashed) ? [path] : [slashed, path];
  });
}

/**
 * Where a browser may keep the cookies a navigation was sent with, which no header says: under a
 * path of the document's own or one above it (`pathsAbove`), for its host alone or for every host
 * of the site's domain, and apart by the site it was set under or not — each the cookie a
 * `Set-Cookie` of the same name replaces only where it names the same (`sameCookie`).
 */
export interface SentScope {
  /** The path each is kept under: the site's root path where none is named. */
  readonly path?: string;
  /**
   * The domain each is kept for, every host of which it is sent to (`domainsAbove`) — its host's
   * alone where none is named.
   */
  readonly domain?: string;
  /**
   * Whether each is kept apart by the site it was set under (`Partitioned`), which a request of that
   * site carries as it carries one that is not — another cookie than one of the same name, domain
   * and path that is not, which a `Set-Cookie` of the other kind keeps beside it; and a secure one,
   * as a browser keeps no other so (CHIPS).
   */
  readonly partitioned?: boolean;
}

/**
 * What `scopes` names a cookie a navigation was sent with by (`SentAt`): its name, or — of a name
 * sent more than once, each a cookie of its own — its name and which of them it is.
 */
export function sentScopeKey(name: string, index: number, count: number): string {
  return count === 1 ? name : `${name}#${String(index)}`;
}

/**
 * A navigation's document, and where a browser keeps the cookies it was sent with: each in `scope`,
 * or where `scopes` says of it (`sentScopeKey`).
 */
interface SentAt {
  readonly document: URL;
  readonly scope?: SentScope;
  readonly scopes?: ReadonlyMap<string, SentScope>;
}

/**
 * The domain a cookie may be kept for every host of, for a document at `url`: its registrable
 * domain, by the list browsers judge suffixes by — none for an address, or a host under no suffix.
 */
function siteDomainOf(url: URL): string | undefined {
  return getDomain(url.hostname, { allowPrivateDomains: true }) ?? undefined;
}

/**
 * The domains a cookie of a document at `url` may be kept for, every host of each: its host itself
 * (`Domain=` it, another cookie than its host-only one), and each domain its host is of up to the
 * site's registrable domain (`siteDomainOf`) — none for an address, or a host under no suffix,
 * which a cookie is kept for alone (RFC 6265bis §5.7: no public suffix).
 */
export function domainsAbove(url: URL): readonly string[] {
  const site = siteDomainOf(url);
  if (site === undefined) {
    return [];
  }
  const host = url.hostname.toLowerCase();
  const domains = [host];
  for (let domain = host; domain !== site && domain.includes('.');) {
    domain = domain.slice(domain.indexOf('.') + 1);
    domains.push(domain);
  }
  return domains;
}

/**
 * The cookies a navigation was asked with, as a browser keeps them for its document (`SentScope`):
 * each the one of its name under the scope's path, or the site's root path where none is named —
 * partitioned, and so secure, where the scope says so, and neither else. A name sent more than once is cookies of as many scopes, where `scopes` says of each — or else of as
 * many paths, which a browser sends the longer first (RFC 6265 §5.4): the last of them under the root
 * path, and those before under the document's own path and those above it.
 */
function sentCookies(sent: string | undefined, at: SentAt): StoredCookie[] {
  const host = at.document.hostname.toLowerCase();
  const pairs = parseCookieHeader(sent ?? null);
  const above = pathsAbove(at.document.pathname);
  const counts = new Map<string, number>();
  for (const { name } of pairs) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return pairs.map(({ name, value }) => {
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    const count = counts.get(name) ?? 1;
    const last = index === count - 1;
    const shared = last ? '/' : (above[Math.min(index, above.length - 1)] ?? '/');
    const own = at.scopes?.get(sentScopeKey(name, index, count));
    const scope = own ?? (count === 1 ? at.scope : undefined);
    const domain = scope?.domain;
    const kept =
      domain === undefined ? { domain: host, hostOnly: true } : { domain, hostOnly: false };
    const path = scope?.path ?? (count === 1 ? '/' : shared);
    const partitioned = scope?.partitioned === true;
    return { name, value, ...kept, path, secure: partitioned, ...(partitioned && { partitioned }) };
  });
}

/** The cookies a browser keeps of a site, each as it stored it, in the order it did. */
export type CookieJar = readonly StoredCookie[];

/**
 * `jar` as what it sends tells it apart (`cookieFor`): the cookies that have not ended, each as kept
 * but when it ends — which the same `Set-Cookie` answered again moves on, sending nothing new.
 */
export function jarKeyOf(jar: CookieJar): string {
  const now = Date.now();
  const sending: unknown[] = [];
  for (const { name, value, domain, hostOnly, path, secure, expires, unadjusted, ...kept } of jar) {
    if (!endedBy({ expires, unadjusted }, now)) {
      const { strict, partitioned } = kept;
      sending.push([
        name,
        value,
        domain,
        hostOnly,
        path,
        secure,
        strict === true,
        partitioned === true,
      ]);
    }
  }
  return JSON.stringify(sending);
}

/**
 * The cookies a browser keeps once it sent `sent` with a navigation of `document`: the check's own
 * cookies of a visitor's, which no header says the scope of — each taken as kept where `scopes` says
 * of its name, or else `scope` (`SentScope`): its host's alone under the site's root path, as a
 * session's are, where neither says.
 */
export function jarOf(sent: string | undefined, at: SentAt): CookieJar {
  return sentCookies(sent, at);
}

/**
 * `jar` with each cookie it holds at the places `kept` names kept from navigations other sites
 * began (`SameSite=Strict`).
 */
export function strictly(jar: CookieJar, kept: ReadonlySet<number>): CookieJar {
  return jar.map((cookie, at) => (kept.has(at) ? { ...cookie, strict: true } : cookie));
}

/**
 * The fewest cookies of a domain a browser need keep (RFC 6265bis §6.1: "at least 50 cookies per
 * domain"), past which one may drop any of them for a later one — Chrome and Firefox past 180,
 * Safari past a number it does not publish — which no header says.
 */
const DOMAIN_COOKIES = 50;

/**
 * Why browsers keep the jar an answer left apart (`storedAfter`), by that jar: a cookie it set that
 * one browser refuses and another keeps (`prefixApart`).
 */
const keptApart = new WeakMap<CookieJar, string>();

/**
 * Why the check proves nothing a browser holding `jar` sends, in a verdict's words: the answer that
 * left it set what browsers keep apart (`keptApart`); it holds more of the site's cookies than a
 * browser need keep of a domain (`DOMAIN_COOKIES`), any of which one may have dropped; or one has
 * ended as one browser reads its end and not as another does (`endedApart`) — or none.
 */
export function unprovedHolding(jar: CookieJar): string | undefined {
  const keptOtherwise = keptApart.get(jar);
  if (keptOtherwise !== undefined) {
    return keptOtherwise;
  }
  const now = Date.now();
  const held = jar.filter((cookie) => !endedBy(cookie, now));
  if (held.length > DOMAIN_COOKIES) {
    return `a browser holds ${held.length} cookies of the site's, more than one need keep of a domain (${DOMAIN_COOKIES}), any of which it may have dropped: no request proves which it sends`;
  }
  const apart = held.find((cookie) => endedApart(cookie, now));
  return apart === undefined
    ? undefined
    : `cookie ${apart.name} has ended as one browser reads its Expires and not as another does — against the Date of the answer that set it, as Chrome and Firefox read it, or by its own clock: no request proves whether a browser sends it`;
}

/** `jar` holding `added` besides, each in the place of the same cookie it kept (`sameCookie`). */
export function keptWith(jar: CookieJar, added: CookieJar): CookieJar {
  const others = jar.filter((kept) => added.every((each) => !sameCookie(kept, each)));
  return [...others, ...added];
}

/**
 * What an answer does to the cookies a browser keeps of the site: sets those its `Set-Cookie`s
 * set, and then — where it says so (`Clear-Site-Data`) — clears every one, those among them.
 */
export interface CookieChanges {
  readonly set: readonly string[];
  readonly cleared: boolean;
  /**
   * How far the answer's `Date` was behind the check's clock as it was read, in milliseconds, where
   * it carried one that parses: what Chrome and Firefox move each `Expires` it sets on by (`endsOf`).
   */
  readonly skew?: number;
}

/** What an answer that sets no cookie and clears none does to them. */
export const NO_COOKIE_CHANGES: CookieChanges = { set: [], cleared: false };

/** What `Clear-Site-Data` names that clears a site's cookies: those alone, or all it keeps. */
const CLEARING_COOKIES = new Set(['"*"', '"cookies"']);

/**
 * What an answer with `headers` does to the cookies a browser keeps (`CookieChanges`): what its
 * `Set-Cookie`s set, whether its `Clear-Site-Data` names cookies — a list of quoted types, of which a
 * browser ignores any it does not know — and how far its `Date` is behind the check's clock as it
 * is read now, where it says one.
 */
export function cookieChangesOf(headers: IncomingHttpHeaders): CookieChanges {
  const said = headers['clear-site-data'];
  const types = (Array.isArray(said) ? said.join(',') : (said ?? '')).split(',');
  const dated = headers.date === undefined ? NaN : Date.parse(headers.date);
  return {
    set: headers['set-cookie'] ?? [],
    cleared: types.some((type) => CLEARING_COOKIES.has(type.trim())),
    ...(Number.isFinite(dated) && { skew: Date.now() - dated }),
  };
}

/**
 * `jar` once the answer to a request of `answered` did `changes`: each cookie it set stored over
 * the same cookie, or removing it where it ended — kept under the domain and the path that request
 * gives it where it names none of its own — and then every one cleared where it clears them, on an
 * origin a browser counts as secure, as it clears the site's cookies on no other (the Clear Site
 * Data specification, which clears them after the `Set-Cookie`s). None the browser kept that has
 * ended since is kept any longer (RFC 6265 §5.3).
 */
export function storedAfter(jar: CookieJar, changes: CookieChanges, answered: URL): CookieJar {
  if (changes.cleared && trustworthy(answered)) {
    return [];
  }
  const now = Date.now();
  const kept = jar.filter((cookie) => !endedBy(cookie, now));
  let apart: string | undefined;
  for (const line of changes.set) {
    const stored = storedOf(line, answered, { now, skew: changes.skew });
    if (stored === undefined) {
      continue;
    }
    apart ??= stored.apart;
    const same = kept.findIndex((cookie) => sameCookie(cookie, stored.cookie));
    if (stored.expired) {
      if (same !== -1) {
        kept.splice(same, 1);
      }
    } else if (same === -1) {
      kept.push(stored.cookie);
    } else {
      // In the place of the one it replaces, as stored when that one was (§5.3, step 11).
      kept[same] = stored.cookie;
    }
  }
  // Stored as a browser that keeps it keeps it, and told apart from one that refuses it.
  if (apart !== undefined) {
    keptApart.set(kept, apart);
  }
  return kept;
}

/**
 * The `Cookie` a browser sends with `request` of what `jar` holds: those the request is under, and
 * that have not ended by now — but those it keeps from other sites' navigations (`strict`), where
 * another site began the navigation it is a request of (`crossSite`, every redirect of it among them)
 * — the longer path first, then the one stored earlier; or none.
 */
export function cookieFor(
  jar: CookieJar,
  request: URL,
  navigation: { readonly crossSite?: boolean } = {},
): string | undefined {
  const requested = request.hostname.toLowerCase();
  const now = Date.now();
  const sentWith = jar
    .filter((cookie) => {
      return (
        domainMatches(requested, cookie) &&
        pathMatches(request.pathname, cookie.path) &&
        (!cookie.secure || trustworthy(request)) &&
        (navigation.crossSite !== true || cookie.strict !== true) &&
        !endedBy(cookie, now)
      );
    })
    .toSorted((a, b) => b.path.length - a.path.length);
  // A nameless cookie goes as its value alone (§5.8.3).
  return sentWith.length === 0
    ? undefined
    : sentWith.map(({ name, value }) => (name === '' ? value : `${name}=${value}`)).join('; ');
}

/**
 * The `Cookie` a browser sends with `request` once it sent `sent` for `document` (`jarOf`), and the
 * document set `setCookies` (`storedAfter`).
 */
export function cookiesAfter(
  sent: string | undefined,
  setCookies: readonly string[],
  at: { readonly document: URL; readonly request: URL; readonly scope?: SentScope },
): string | undefined {
  const changes = { set: setCookies, cleared: false };
  return cookieFor(storedAfter(jarOf(sent, at), changes, at.document), at.request);
}
