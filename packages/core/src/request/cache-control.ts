import { NO_STORE_CACHE_CONTROL, SHARED_CACHE_CONTROL_HEADERS } from './constants.ts';

/**
 * What a host makes of an answer's `Cache-Control` before it goes out: whether a shared cache may
 * keep it, as the application said and as the request allows; and, where nobody may, that nobody
 * does. The edge's rules, which a host serving the same build without it applies alike.
 */

const CACHE_CONTROL_HEADER = 'cache-control';
const SET_COOKIE_HEADER = 'set-cookie';
const S_MAXAGE_DIRECTIVE = 's-maxage';
const PRIVATE_DIRECTIVE = 'private';
const NO_STORE_DIRECTIVE = 'no-store';
const PUBLIC_DIRECTIVE = 'public';

function directiveName(part: string): string {
  return part.split('=', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * The directives of a `Cache-Control` value, parted at the commas outside quoted strings
 * (RFC 9110 §5.6.1, §5.6.4): `private="Set-Cookie, X-Id"` is one directive, not two.
 */
export function cacheDirectives(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (quoted && char === '\\') {
      // A quoted pair: the character after it is the string's, a quote or a comma included.
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * `private` naming no field: the whole response one visitor's. One naming fields
 * (`private="Set-Cookie"`) keeps only those from a shared cache, which may store the rest
 * (RFC 9111 §5.2.2.7), so it is not the privacy this asks for.
 */
function isBarePrivate(part: string): boolean {
  return part.toLowerCase() === PRIVATE_DIRECTIVE;
}

/** Upstream CDN directives must not override a host's admission or privacy decision. */
export function removeSharedCacheOverrides(headers: Headers): void {
  for (const name of SHARED_CACHE_CONTROL_HEADERS) {
    headers.delete(name);
  }
}

/**
 * Keep a response from everybody, the browser included: what a project whose delivery is private
 * (`privateDelivery`) answers with, however the application said it may be kept. A browser could
 * otherwise hand it back without the host being asked — to a visitor it no longer lets through.
 */
export function keptByNobody(headers: Headers): void {
  removeSharedCacheOverrides(headers);
  headers.set(CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL);
}

/**
 * Keep a proxied response from shared caches — unless the application said they may keep it —
 * leaving the browser's own caching intact.
 *
 * Passthrough responses have not passed immutable asset admission, so the edge keeps no copy of
 * one, and by default no shared cache may hold one either: `private` applies that to every shared
 * cache. Upstream CDN-specific headers have higher precedence than Cache-Control and are removed
 * first, and `s-maxage` goes with the shared caches it would have let keep the answer. The
 * browser's own caching directives survive intact.
 *
 * An answer whose own `Cache-Control` says `public` keeps it, as Next.js hands it on (decided
 * 2026-10-22): a `getServerSideProps` page's `public, max-age=3600`, an image route's
 * `public, max-age=0, must-revalidate`. A cache between the edge and the browser may then hold a
 * copy that no invalidation reaches, which is what the application asked for — for as long as it
 * said: its `s-maxage` stays, the lifetime it gave shared caches, which past the edge are those.
 * Only where it says so of itself, though (`saidPublic`), and only to a request that is `anonymous`
 * (`anonymousRequest`): one that carried nothing of a visitor's the application could have
 * answered by — no cookie or `Authorization` of its own, none of the Next.js control or
 * router-protocol headers — and was no validation. Nor anything a project whose delivery is
 * private serves (`privateDelivery`), which the callers keep from every cache after this
 * (`keptByNobody`).
 *
 * Admitted immutable assets do not come through here. They are content-addressed and vary on
 * nothing, which is what makes the edge's own named cache safe to hold them in.
 */
export function unsharedUnlessPublic(headers: Headers, anonymous: boolean): void {
  removeSharedCacheOverrides(headers);
  const raw = headers.get(CACHE_CONTROL_HEADER);
  if (raw === null) {
    headers.set(CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL);
    return;
  }
  const directives = cacheDirectives(raw);
  // The application's own word that shared caches may keep it goes out as it said it, `s-maxage`
  // and all: past the edge, which keeps nothing of this, the shared caches are the ones it names.
  if (anonymous && saidPublic(headers, directives)) {
    headers.set(CACHE_CONTROL_HEADER, directives.join(', '));
    return;
  }
  // Anything else is no shared cache's: `s-maxage` goes, and a `private` naming fields, which would
  // let one keep the rest, for a bare `private`.
  const kept = directives.filter((part) => {
    const name = directiveName(part);
    return name !== S_MAXAGE_DIRECTIVE && (name !== PRIVATE_DIRECTIVE || isBarePrivate(part));
  });
  const unshared = kept.some(
    (part) => isBarePrivate(part) || directiveName(part) === NO_STORE_DIRECTIVE,
  );
  if (unshared) {
    headers.set(CACHE_CONTROL_HEADER, kept.join(', '));
    return;
  }
  const shareable = kept.filter((part) => directiveName(part) !== PUBLIC_DIRECTIVE);
  headers.set(CACHE_CONTROL_HEADER, [PRIVATE_DIRECTIVE, ...shareable].join(', '));
}

/**
 * Whether an answer says of itself that a shared cache may keep all of it: a bare `public` — a
 * `public=…` is no directive a cache has to heed — with no `private` naming fields, which says a
 * shared cache is to keep none of those, and no cookie, which makes an answer one visitor's
 * whatever else it says.
 */
function saidPublic(headers: Headers, directives: readonly string[]): boolean {
  return (
    !headers.has(SET_COOKIE_HEADER) &&
    directives.some((part) => part.toLowerCase() === PUBLIC_DIRECTIVE) &&
    directives.every((part) => directiveName(part) !== PRIVATE_DIRECTIVE || isBarePrivate(part))
  );
}
