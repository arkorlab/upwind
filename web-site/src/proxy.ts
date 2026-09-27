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
 * Both inputs are part of the decision even when only one of them was read: a redirect chosen from
 * `Accept-Language` must not be replayed for a request whose cookie asks for the other language.
 *
 * It reaches the visitor on the redirect, and not on the rewrite: Next.js builds that response from
 * the page it rewrote to and keeps its own `Vary` (`rsc, next-router-*`), which a rule in
 * `next.config` cannot add to either — the framework owns that header on an app response. What keeps
 * the rewrite honest instead is the matcher below: it matches `/`, so the edge runs this Function for
 * every bare path rather than serving one out of storage, and the language is decided per request.
 */
const LOCALE_VARY = 'Cookie, Accept-Language';

/** Appended, not set: the `Vary` Next.js adds for an RSC request has to survive this. */
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
 * `private, no-store` twice over. A `Set-Cookie` a shared cache replayed would hand one visitor's
 * choice to the next — and a 308 the *browser* stored would be followed from its own cache, without
 * ever asking for this response again, so a reader who had since chosen Japanese would take the
 * English link and arrive in Japanese: the bug this exists to fix, by way of the redirect cache. The
 * status stays 308 because `/en` really is `/` permanently, which is what a crawler should record.
 *
 * Only on a redirect, and never on a page: a response that cannot be shared is one a Function has to
 * serve every time, and the redirect is the cheap one to give up. `/ja` is a page, and records
 * nothing.
 */
function rememberLocale(response: NextResponse, locale: Locale): NextResponse {
  const { name, ...options } = localeCookieOptions;
  response.cookies.set(name, locale, options);
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
    const redirect = NextResponse.redirect(url, PERMANENT_REDIRECT);
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
  return varyOnLocaleInputs(NextResponse.rewrite(localeUrl(request, defaultLocale, segments)));
};
