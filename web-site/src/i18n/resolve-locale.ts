import { notFound } from 'next/navigation';

import { defaultLocale, isLocale, type Locale } from './locales.ts';

/**
 * Narrowing the `[locale]` segment, in the two places that read it.
 *
 * The proxy never produces a segment that is not a locale — a bare path is rewritten to `/en`, and
 * `/ja` is served as it stands — so anything else arrived by a door the proxy does not watch: a
 * pathname with a dot in it, which its matcher skips.
 */

/** For the page, which answers for the URL: a segment that is not a locale is a page that is not here. */
export function resolveLocale(raw: string): Locale {
  if (!isLocale(raw)) {
    notFound();
  }
  return raw;
}

/**
 * For the layout, which only frames what answers. A 404 thrown from the root layout has no layout
 * left to render itself in, so the layout takes the default locale for a segment it does not know
 * and lets the page below it be the thing that refuses.
 */
export function frameLocale(raw: string): Locale {
  return isLocale(raw) ? raw : defaultLocale;
}
