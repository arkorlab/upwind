import { type NextProxy, type NextRequest, NextResponse } from 'next/server';

import { localeCookieOptions } from '@/i18n/locale-cookie.ts';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from '@/i18n/locales.ts';
import { negotiateLocale } from '@/i18n/negotiate.ts';

/**
 * Locale routing, and nothing else.
 *
 * - `/en/…` is redirected to the bare path (308), and the choice is written down on the way. English
 *   is served at `/`, so `/en` is a second spelling of a page that already has one — and two URLs
 *   for one page is the thing a canonical tag exists to apologise for.
 * - `/ja/…` is served as it stands.
 * - A bare path is English, rendered by rewriting to `/en/…` inside — unless the visitor said
 *   otherwise: the cookie the switcher writes, or, for a visitor who has never chosen, an
 *   `Accept-Language` that prefers Japanese, which is a redirect to `/ja/…` so that the URL says
 *   which language is on the screen.
 *
 * A rewrite for the default locale and a redirect for the other is the asymmetry the design is
 * built on: it keeps `/` as the canonical English URL while leaving Japanese addressable.
 */

const PERMANENT_REDIRECT = 308;
const TEMPORARY_REDIRECT = 307;

/**
 * Everything but Next.js's own paths and anything with a dot in it.
 *
 * The dot is what keeps `/robots.txt`, `/sitemap.xml` and every asset out: those are one document
 * each, with no language, and a locale prefix would be a path they are not served at.
 */
export const config = {
  // Next.js reads this statically, so it has to be a plain string literal.
  // eslint-disable-next-line unicorn/prefer-string-raw -- a tagged template cannot be analysed.
  matcher: ['/((?!_next/|.*\\..*).*)'],
};

function joinPath(segments: readonly string[]): string {
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * What a redirect out of a bare path varies on: both inputs, even when only one was read — a
 * redirect chosen from `Accept-Language` must not be replayed for a request whose cookie asks for
 * the other language.
 *
 * **On the redirects only, and never on the rewrite.** A redirect is this Function's own response.
 * A rewrite is not: the page is what answers, and the headers set here are merged onto that response
 * by `Headers.set` — the host's runtime does it the way Next.js's own server does, so a `Vary` here
 * would not join the framework's but replace it. `/` would go out varying on the cookie and not on
 * `rsc`, and a cached document could then answer the router's own request for the same URL with
 * markup where a flight payload belongs.
 *
 * What keeps the rewrite honest instead is the matcher below: it matches every bare path, so the
 * edge runs this Function for `/` rather than serving it out of storage, and the language is decided
 * per request.
 */
const LOCALE_VARY = 'Cookie, Accept-Language';

/** Appended, not set: a redirect of Next.js's own may carry a `Vary` that has to survive this. */
function varyOnLocaleInputs(response: NextResponse): NextResponse {
  response.headers.append('vary', LOCALE_VARY);
  return response;
}

function chooseLocaleForBarePath(request: NextRequest): Locale {
  const chosen = request.cookies.get(LOCALE_COOKIE)?.value;
  if (chosen !== undefined && isLocale(chosen)) {
    return chosen;
  }
  return negotiateLocale(request.headers.get('accept-language'));
}

/**
 * Write a language the visitor asked for by name into the cookie the bare path reads.
 *
 * `/en` is the one URL that says "English, please", and the page it names is `/` — which negotiates.
 * Without this, following an English link with a Japanese cookie would land on Japanese, which is
 * what the bilingual 404's own English link would otherwise do to a reader who has a cookie.
 *
 * Only on a redirect, and never on a page: a `Set-Cookie` makes a response one visitor's, so the
 * `cache-control` goes with it, and a page that cannot be shared is a page a Function serves every
 * time. The redirect is the cheap one to give up. `/ja` is a page, and records nothing.
 */
function rememberLocale(response: NextResponse, locale: Locale): NextResponse {
  const { name, ...options } = localeCookieOptions;
  response.cookies.set(name, locale, options);
  return response;
}

/**
 * A response no cache may keep: shared, or the browser's own.
 *
 * The `/en` redirect is both, for different reasons. A `Set-Cookie` a shared cache replayed would
 * hand one visitor's choice to the next; and a 308 — cacheable by default, permanently — that the
 * browser stored from a prefetch would be followed from its own cache, so the click that was meant
 * to say "English" would reach nothing that could hear it. The status stays 308 all the same,
 * because `/en` really is `/` for good, which is what a crawler should write down.
 */
function unstorable(response: NextResponse): NextResponse {
  response.headers.set('cache-control', 'private, no-store');
  return response;
}

/**
 * Is this a person asking for a page, or a machine looking ahead?
 *
 * A prefetch is a request nobody made — the router fetches the links it can see, a browser follows a
 * speculation rule, a crawler walks — and a `Set-Cookie` on one of those would change the language of
 * a reader who had only scrolled past a link, for a year. So the language is written down for a
 * document navigation and nothing else.
 *
 * Read from the shape of the request rather than from `Next-Router-Prefetch`, which never arrives:
 * Next.js strips its own routing headers off anything from the network before a proxy is called, so
 * that they cannot be spoofed. What cannot be spoofed away is what the request asks for — the
 * router's prefetch is a `fetch` for `text/x-component`, and a navigation is a browser asking for
 * `text/html`. `Sec-Purpose` is the browser's own word for a speculative load, and it does arrive.
 */
function isDocumentNavigation(request: NextRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }
  if (
    (request.headers.get('sec-purpose') ?? '').includes('prefetch') ||
    request.headers.get('purpose') === 'prefetch'
  ) {
    return false;
  }
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/** The locale's own path, without the trailing slash a root would otherwise gain from the prefix. */
function localeUrl(request: NextRequest, locale: Locale, segments: readonly string[]): URL {
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${joinPath(segments)}`.replace(/\/$/u, '');
  return url;
}

export const proxy: NextProxy = (request) => {
  const segments = request.nextUrl.pathname.split('/').filter((segment) => segment !== '');
  const [first, ...rest] = segments;

  if (first === defaultLocale) {
    const url = request.nextUrl.clone();
    url.pathname = joinPath(rest);
    // Never stored, whether or not it carries the cookie: a 308 is cacheable by default, and one a
    // prefetch put in the browser's cache would be followed later without this Function being asked
    // again — so the click that was meant to record English would record nothing.
    const redirect = unstorable(NextResponse.redirect(url, PERMANENT_REDIRECT));
    return isDocumentNavigation(request) ? rememberLocale(redirect, defaultLocale) : redirect;
  }

  if (first !== undefined && isLocale(first)) {
    return NextResponse.next();
  }

  const locale = chooseLocaleForBarePath(request);
  if (locale !== defaultLocale) {
    return varyOnLocaleInputs(
      NextResponse.redirect(localeUrl(request, locale, segments), TEMPORARY_REDIRECT),
    );
  }
  return NextResponse.rewrite(localeUrl(request, defaultLocale, segments));
};
