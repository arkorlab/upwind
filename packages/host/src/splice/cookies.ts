import { compareCodeUnits } from '@stayingupwind/core/util';

/**
 * Which of the cookies a resume sets the client has not been sent already.
 *
 * The shell's headers go out before the render begins, so a cookie the resumed part sets cannot
 * reach the client (`splice.ts`). One the shell's headers carried already is another matter: what a
 * middleware set goes out with the shell, and is handed to the render as well, for `cookies()` to
 * read as the request's own (`x-middleware-set-cookie`). Next.js's request store merges those into
 * the render's mutable cookies, and writes them back as `Set-Cookie` when the render touches them
 * (`server/async-storage/request-store.ts`, `mergeMiddlewareCookies`) — so a resume can answer with
 * the very cookie the shell went out with. Repeating it sets nothing the client does not have.
 *
 * Two are the same cookie when a browser would store the same thing: the name and value as written,
 * the attributes in any order and any case, the last of one written twice, and `Expires` left out
 * beside a valid `Max-Age` — which a browser prefers (RFC 6265, section 5.3), and which Next.js
 * recomputes from `Max-Age` each time it sets a cookie again (`normalizeCookie`), a second or more
 * after the middleware did. A resume's cookie may also be the one the shell carried as Next.js
 * writes it back (`echoOf`), which is not always as it was written: that is the render's copy of a
 * cookie the client has, not one it was meant to be given. Only of a cookie the render was handed,
 * though (`handedCookies`): one the middleware wrote on its response alone — a `Set-Cookie` of its
 * own, appended after `cookies.set` — the render never saw, and a resume that sets it as Next.js
 * would write it back sets a cookie of its own, which the client may not have.
 *
 * And only where the copy is stored as the cookie it copies was. A cookie that names no path of its
 * own is stored under the directory of the path the client asked for (RFC 6265, sections 5.1.4 and
 * 5.2.4), and Next.js writes it back with `Path=/`: below the root that is another cookie, which a
 * whole render would send beside it, and the client does not have.
 */

const EXPIRES = 'expires';
const MAX_AGE = 'max-age';
/** The one attribute whose value is case-sensitive: a path is matched as written. */
const PATH = 'path';
/** A `Max-Age` a browser takes; any other it ignores, and `Expires` stands (RFC 6265, 5.2.2). */
const DELTA_SECONDS = /^-?\d+$/u;
/** What a cookie with no name is reported as: it ends the splice as any other would. */
const NAMELESS = '(nameless)';

interface Attribute {
  readonly name: string;
  readonly value: string;
}

function attributeOf(written: string): Attribute {
  const at = written.indexOf('=');
  const name = (at === -1 ? written : written.slice(0, at)).trim().toLowerCase();
  const value = at === -1 ? '' : written.slice(at + 1).trim();
  return { name, value: name === PATH ? value : value.toLowerCase() };
}

/**
 * The cookies the render was handed, as Next.js splits the `x-middleware-set-cookie` it reads them
 * from (`splitCookiesString`, `mergeMiddlewareCookies`): at each comma a name and its `=` follow,
 * so the one inside an `Expires` parts nothing. Each is a `Set-Cookie` as `NextResponse` wrote it,
 * which is how it wrote the shell's as well.
 */
function handedCookies(handed: string): Set<string> {
  return new Set(
    handed
      .split(/,(?=[^=;,]*=)/u)
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie !== ''),
  );
}

/**
 * Where a browser keeps a cookie that names no path it takes: the path asked for, up to its last
 * `/`, and the root for one that does not begin with `/` or holds no other (RFC 6265, section
 * 5.1.4).
 */
function defaultPathOf(pathname: string): string {
  const last = pathname.lastIndexOf('/');
  return last === 0 || !pathname.startsWith('/') ? '/' : pathname.slice(0, last);
}

/** The path a `Set-Cookie` names last, which is the one a browser takes where it begins with `/`. */
function pathOf(setCookie: string): string | undefined {
  let path: string | undefined;
  for (const each of setCookie.split(';').slice(1)) {
    const attribute = attributeOf(each);
    if (attribute.name === PATH) {
      path = attribute.value;
    }
  }
  return path;
}

/** The path a browser stores a `Set-Cookie` under: its own, or else `defaultPath` (5.2.4). */
function storedPathOf(setCookie: string, defaultPath: string): string {
  const path = pathOf(setCookie);
  return path?.startsWith('/') === true ? path : defaultPath;
}

/**
 * A `Set-Cookie` as a browser stores it, under the path it is kept at; two that differ only in how
 * they are written agree.
 */
function storedAs(setCookie: string, defaultPath: string): string {
  const [pair = '', ...written] = setCookie.split(';');
  const attributes = new Map<string, string>();
  for (const each of written) {
    const attribute = attributeOf(each);
    if (
      attribute.name === '' ||
      (attribute.name === MAX_AGE && !DELTA_SECONDS.test(attribute.value))
    ) {
      continue;
    }
    // The last of an attribute written twice is the one a browser keeps.
    attributes.delete(attribute.name);
    attributes.set(attribute.name, attribute.value);
  }
  if (attributes.has(MAX_AGE)) {
    attributes.delete(EXPIRES);
  }
  attributes.set(PATH, storedPathOf(setCookie, defaultPath));
  const kept = [...attributes]
    .map(([name, value]) => `${name}=${value}`)
    .toSorted(compareCodeUnits);
  return [pair.trim(), ...kept].join(';');
}

/**
 * The pairs of a cookie string as Next.js reads them (`parseCookie`, `@edge-runtime/cookies`):
 * split at `;` and the spaces after it, each value decoded once, a pair without `=` taken as
 * `true`, one whose value does not decode left out, and a name met again overwriting in place.
 */
function nextPairs(cookie: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const pair of cookie.split(/; */u)) {
    const at = pair.indexOf('=');
    if (pair === '') {
      continue;
    }
    if (at === -1) {
      pairs.set(pair, 'true');
      continue;
    }
    try {
      pairs.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)));
    } catch {
      // Left out, as Next.js leaves it out.
    }
  }
  return pairs;
}

const NEXT_SAME_SITE = new Set(['lax', 'none', 'strict']);
const NEXT_PRIORITY = new Set(['high', 'low', 'medium']);

/** Whether Next.js reads an attribute as there: read at all, and not read as nothing. */
function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** A date as Next.js writes it back: parsed, and written as `toUTCString` writes it. */
function expiresOf(value: string | undefined): string | undefined {
  // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
  return present(value) ? `Expires=${new Date(value).toUTCString()}` : undefined;
}

/** What Next.js keeps of an attribute it knows the values of: one of those, lowercased. */
function known(
  name: string,
  value: string | undefined,
  values: ReadonlySet<string>,
): string | undefined {
  const lower = value?.toLowerCase();
  return lower !== undefined && values.has(lower) ? `${name}=${lower}` : undefined;
}

/**
 * A cookie the shell carried, as Next.js 16.3 writes it back on the render it was handed
 * (`mergeMiddlewareCookies`): read by `parseSetCookie`, which decodes the value a second time and
 * keeps only what is truthy — `Max-Age=0` goes, and a `SameSite` or `Priority` it does not know —
 * then set again, which puts `Path=/` where there was none and recomputes `Expires` beside a
 * `Max-Age` (which `storedAs` sets aside), and written out with the value encoded once. A resume's
 * cookie is weighed against this as against the cookie as it was sent: as a browser stores each
 * (`storedAs`). `undefined` for a cookie it could not have read.
 */
function echoOf(setCookie: string): string | undefined {
  const [first, ...rest] = nextPairs(setCookie);
  if (first === undefined) {
    return undefined;
  }
  const [name, once] = first;
  let value: string;
  try {
    value = decodeURIComponent(once);
  } catch {
    return undefined;
  }
  const attributes = new Map(
    rest.map(([key, attribute]) => [key.toLowerCase().replaceAll('-', ''), attribute]),
  );
  const path = attributes.get('path');
  const domain = attributes.get('domain');
  const maxAge = attributes.get('maxage');
  const seconds = maxAge === undefined ? 0 : Number(maxAge);
  const written = [
    `Path=${present(path) ? path : '/'}`,
    expiresOf(attributes.get('expires')),
    seconds === 0 || Number.isNaN(seconds) ? undefined : `Max-Age=${String(seconds)}`,
    present(domain) ? `Domain=${domain}` : undefined,
    present(attributes.get('secure')) ? 'Secure' : undefined,
    present(attributes.get('httponly')) ? 'HttpOnly' : undefined,
    known('SameSite', attributes.get('samesite'), NEXT_SAME_SITE),
    present(attributes.get('partitioned')) ? 'Partitioned' : undefined,
    known('Priority', attributes.get('priority'), NEXT_PRIORITY),
  ].filter((attribute) => attribute !== undefined);
  return [`${name}=${encodeURIComponent(value)}`, ...written].join('; ');
}

function nameOf(setCookie: string): string {
  const name = (setCookie.split(';', 1)[0] ?? '').split('=', 1)[0]?.trim() ?? '';
  return name === '' ? NAMELESS : name;
}

/**
 * The names of the cookies among `set` that `sent` does not carry, either as it was written or —
 * one the render was `handed` as well — as Next.js writes it back where that is the same cookie.
 * `sent` is what the shell's headers went out with, `handed` the `x-middleware-set-cookie` the
 * render was given, and `pathname` the path the client asked for, which a cookie naming no path of
 * its own is stored under. Nothing is compared while the resume sets no cookie at all.
 */
export function unsentCookieNames(
  set: readonly string[],
  sent: readonly string[] = [],
  handed = '',
  pathname = '/',
): string[] {
  if (set.length === 0) {
    return [];
  }
  const defaultPath = defaultPathOf(pathname);
  const given = handedCookies(handed);
  const carried = new Set<string>();
  for (const setCookie of sent) {
    carried.add(storedAs(setCookie, defaultPath));
    // Written back as the cookie stored where the client keeps it: one Next.js moves to the root
    // is not this one, and does not match it.
    const placed = `${setCookie}; Path=${storedPathOf(setCookie, defaultPath)}`;
    const echo = given.has(setCookie.trim()) ? echoOf(placed) : undefined;
    if (echo !== undefined) {
      carried.add(storedAs(echo, defaultPath));
    }
  }
  return set
    .filter((setCookie) => !carried.has(storedAs(setCookie, defaultPath)))
    .map((setCookie) => nameOf(setCookie));
}
