import type { MetadataRoute } from 'next';

import { locales } from '@/i18n/locales.ts';
import { localeAlternates, localePath } from '@/lib/routes.ts';
import { SITE_URL } from '@/lib/site.ts';

/**
 * One page, twice: the English one and the Japanese one, each naming the other as its alternate.
 *
 * `x-default` is the English URL rather than a third address, because that is what a reader who
 * matches neither language is served — the same answer the proxy gives a browser that asks for
 * neither. No entry carries `lastModified`: a date invented on every build tells a crawler the page
 * changed when it did not.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const alternates = localeAlternates();
  const languages = {
    en: new URL(alternates.en, SITE_URL).href,
    ja: new URL(alternates.ja, SITE_URL).href,
    'x-default': new URL(alternates.en, SITE_URL).href,
  };
  return locales.map((locale) => ({
    url: new URL(localePath(locale), SITE_URL).href,
    alternates: { languages },
  }));
}
