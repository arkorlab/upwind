import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../globals.css';

import { dictionary } from '@/content/dictionary.ts';
import { htmlLang, locales } from '@/i18n/locales.ts';
import { frameLocale } from '@/i18n/resolve-locale.ts';
import { SITE_URL } from '@/lib/site.ts';

/**
 * The document, and the one thing every page under it shares: which language it is in.
 *
 * The root layout sits under `[locale]` because English is served on the bare path and Japanese under
 * `/ja`, and the segment is what tells them apart. `generateStaticParams` is what makes both of them
 * pages a build prerenders rather than pages a Function renders on demand.
 *
 * `metadataBase` is set here and nowhere else: every page's canonical and hreflang are paths, and
 * this is what makes them absolute. It is inherited, so a page that builds its own metadata does not
 * have to know the site's name.
 */

interface LocaleParams {
  readonly params: Promise<{ readonly locale: string }>;
}

export function generateStaticParams(): { locale: string }[] {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata(props: LocaleParams): Promise<Metadata> {
  const locale = frameLocale((await props.params).locale);
  const copy = dictionary(locale);
  return {
    metadataBase: new URL(SITE_URL),
    title: copy.meta.title,
    description: copy.meta.description,
    applicationName: copy.meta.siteName,
  };
}

export default async function RootLayout(
  props: Readonly<LocaleParams & { readonly children: ReactNode }>,
): Promise<ReactNode> {
  // `frameLocale`, not `resolveLocale`: a 404 thrown here would have no layout left to render in.
  const locale = frameLocale((await props.params).locale);
  return (
    <html lang={htmlLang[locale]}>
      <body className="flex min-h-dvh flex-col antialiased">{props.children}</body>
    </html>
  );
}
