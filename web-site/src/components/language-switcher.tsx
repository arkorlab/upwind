'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useTransition } from 'react';

import { setLocaleAction } from '@/app/actions/locale.ts';
import { type Locale, localeName, otherLocale, switchToLocale } from '@/i18n/locales.ts';
import { switchLocalePath } from '@/lib/routes.ts';

/**
 * The switch between English and Japanese: the only interactive thing on this site.
 *
 * It writes the cookie before it navigates, so the choice survives a later visit to the bare path —
 * and it takes the target from `location` rather than from `usePathname()`, which for English reports
 * the internal `/en` rewrite, a path this site redirects away from.
 *
 * Every word of it is in the language it leads to, which is what `lang` on the button says: the name
 * a reader can read without reading the page, and an accessible name in one language rather than a
 * sentence stitched from two. A screen reader has one voice per element, and this element has one
 * language.
 */
export function LanguageSwitcher({ locale }: { readonly locale: Locale }): ReactNode {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const to = otherLocale(locale);

  function onClick(): void {
    startTransition(async () => {
      await setLocaleAction(to);
      router.push(switchLocalePath(`${location.pathname}${location.search}${location.hash}`, to));
    });
  }

  return (
    <button
      type="button"
      lang={to}
      aria-label={switchToLocale[to]}
      aria-busy={pending}
      disabled={pending}
      onClick={onClick}
      className="rounded-sm border border-border px-2 py-1 text-xs hover:bg-subtle disabled:text-muted"
    >
      {localeName[to]}
    </button>
  );
}
