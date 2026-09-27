import Link from 'next/link';
import type { ReactNode } from 'react';

import type { Copy } from '@/content/copy.ts';
import type { Locale } from '@/i18n/locales.ts';
import { localePath } from '@/lib/routes.ts';
import { NPM_URL, REPOSITORY_URL } from '@/lib/site.ts';

import { LanguageSwitcher } from './language-switcher.tsx';

const NAV_LINK = 'text-xs underline-offset-4 hover:underline';

/**
 * The bar above the page: the name, the two places the project actually lives, and the language.
 *
 * The wordmark is a link rather than a heading — the page's heading is its own first line — and the
 * skip link comes before everything, because the switch at the end of this bar is the one control on
 * the site and a keyboard reader should not have to pass it to reach the text.
 */
export function SiteHeader({
  locale,
  copy,
}: {
  readonly locale: Locale;
  readonly copy: Copy;
}): ReactNode {
  return (
    <header className="border-b border-border">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:m-3 focus:rounded-sm focus:bg-bg focus:px-3 focus:py-2 focus:text-sm"
      >
        {copy.nav.skipToContent}
      </a>
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-4">
        <Link href={localePath(locale)} className="font-mono text-sm font-semibold">
          upwind
        </Link>
        <nav className="flex items-center gap-4">
          <a href={REPOSITORY_URL} className={NAV_LINK}>
            {copy.nav.repository}
          </a>
          <a href={NPM_URL} className={NAV_LINK}>
            {copy.nav.npm}
          </a>
          <LanguageSwitcher locale={locale} />
        </nav>
      </div>
    </header>
  );
}
