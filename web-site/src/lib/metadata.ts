import type { Metadata } from 'next';

import { type Locale, ogLocale, otherLocale } from '@/i18n/locales.ts';

import { localeAlternates, localePath } from './routes.ts';

/**
 * A page's metadata, built in one place.
 *
 * Next.js merges metadata shallowly, so a page that sets `openGraph.title` and nothing else loses
 * every other Open Graph field the layout had set. Every page here calls this instead, and gets the
 * whole card: canonical, the hreflang set, Open Graph, Twitter.
 *
 * `x-default` is the English page, not a third URL. It is the answer for a crawler whose reader
 * matches neither language, which is the same answer the proxy gives a browser that asks for
 * neither.
 */

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export interface PageMetadataInput {
  readonly locale: Locale;
  readonly title: string;
  readonly description: string;
  readonly siteName: string;
  readonly imageAlt: string;
}

/** The Open Graph image is `app/[locale]/opengraph-image.tsx`; English is served on the bare path. */
function ogImagePath(locale: Locale): string {
  return localePath(locale, '/opengraph-image');
}

export function buildPageMetadata(input: PageMetadataInput): Metadata {
  // The site is one page, so the path is `/` — the one `routes.ts` defaults to. A second page would
  // pass its own through here and through `localeAlternates` with it; nothing else would change.
  const canonical = localePath(input.locale);
  const alternates = localeAlternates();
  const images = [
    {
      url: ogImagePath(input.locale),
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      alt: input.imageAlt,
    },
  ];
  return {
    title: input.title,
    description: input.description,
    alternates: {
      canonical,
      languages: { en: alternates.en, ja: alternates.ja, 'x-default': alternates.en },
    },
    openGraph: {
      type: 'website',
      siteName: input.siteName,
      title: input.title,
      description: input.description,
      url: canonical,
      locale: ogLocale[input.locale],
      alternateLocale: [ogLocale[otherLocale(input.locale)]],
      images,
    },
    twitter: {
      card: 'summary_large_image',
      title: input.title,
      description: input.description,
      images,
    },
    robots: { index: true, follow: true },
  };
}
