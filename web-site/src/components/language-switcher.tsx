'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useTransition } from 'react';

import { setLocaleAction } from '@/app/actions/locale.ts';
import { type Locale, otherLocale } from '@/i18n/locales.ts';
import { switchLocalePath } from '@/lib/routes.ts';

/**
 * The switch between English and Japanese: the only interactive thing on this site.
 *
 * It writes the cookie before it navigates, so the choice survives a later visit to the bare path —
 * and it takes the target from `location` rather than from `usePathname()`, which for English reports
 * the internal `/en` rewrite, a path this site redirects away from.
 *
 * The label is the other language's name written in that language, which is the one label a reader
 * who cannot read the current page can still read.
 */
export function LanguageSwitcher({
  locale,
  label,
  target,
}: {
  readonly locale: Locale;
  readonly label: string;
  readonly target: string;
}): ReactNode {
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
      aria-label={`${label}: ${target}`}
      aria-busy={pending}
      disabled={pending}
      onClick={onClick}
      className="rounded-sm border border-border px-2 py-1 text-xs hover:bg-subtle disabled:text-muted"
    >
      {target}
    </button>
  );
}
