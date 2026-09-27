import { isLocale, type Locale } from '@/i18n/locales.ts';

/**
 * Where a locale's copy of a page lives.
 *
 * English is served on the bare path and Japanese under `/ja`, so a path is not a function of a
 * locale alone — which is exactly why it is a function here rather than a template literal spelled
 * out at each call. One page exists today (`/`), and these take the path anyway: an `about` page
 * added later should not have to rediscover that `/en/about` is not a URL this site serves.
 */

/** `/` for English, `/ja` for Japanese; `/ja/x` for anything below it. */
export function localePath(locale: Locale, path = '/'): string {
  if (locale === 'en') {
    return path;
  }
  return path === '/' ? '/ja' : `/ja${path}`;
}

/** Both spellings of one page, which is what an hreflang set and a sitemap entry are made of. */
export function localeAlternates(path = '/'): Record<Locale, string> {
  return { en: localePath('en', path), ja: localePath('ja', path) };
}

/**
 * The URL that *asks* for a language, as opposed to the one a language is served at.
 *
 * For Japanese they are the same address. For English they are not: English is served on the bare
 * path, and a bare path is negotiated — so a link to `/` is a link to whichever language the reader's
 * cookie or browser prefers, which is exactly wrong on the bilingual 404, where the point of the
 * English link is that it is the English one. `/en` says it, and the proxy canonicalises it back to
 * `/` and writes the choice down on the way (`proxy.ts`). Never used in a canonical or an hreflang:
 * what a crawler is told is where a page is served, which is `localePath`.
 */
export function explicitLocalePath(locale: Locale): string {
  return `/${locale}`;
}

/**
 * The same page in the other language, from the URL the browser is showing.
 *
 * Derived from `location` rather than from `usePathname()`, which reports the path Next.js is
 * rendering — and for English that is the internal `/en` rewrite, a spelling this site redirects
 * away from. Query and fragment travel with the switch, so a reader who followed a link to a section
 * stays at that section.
 */
export function switchLocalePath(currentUrlPath: string, target: Locale): string {
  // A base is required to parse a path, and nothing of this one survives: only the parts are read.
  const url = new URL(currentUrlPath, 'https://placeholder.invalid');
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const [first] = segments;
  const rest = first !== undefined && isLocale(first) ? segments.slice(1) : segments;
  const bare = rest.length === 0 ? '/' : `/${rest.join('/')}`;
  return `${localePath(target, bare)}${url.search}${url.hash}`;
}
