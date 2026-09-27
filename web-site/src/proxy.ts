import { type NextProxy, type NextRequest, NextResponse } from 'next/server';

import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from '@/i18n/locales.ts';
import { negotiateLocale } from '@/i18n/negotiate.ts';

/**
 * Locale routing, and nothing else.
 *
 * - `/en/…` is redirected to the bare path (308). English is served at `/`, so `/en` is a second
 *   spelling of a page that already has one, and two URLs for one page is the thing a canonical tag
 *   exists to apologise for.
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
    return NextResponse.redirect(url, PERMANENT_REDIRECT);
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
