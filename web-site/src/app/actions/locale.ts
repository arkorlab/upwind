'use server';

import { cookies } from 'next/headers';

import { isLocale, LOCALE_COOKIE } from '@/i18n/locales.ts';

/**
 * Remember which language was chosen.
 *
 * The proxy reads this cookie on a bare path, so a reader who switched to Japanese and later types
 * the site's name into the address bar lands on Japanese instead of being negotiated at again. A
 * value that is not a locale is dropped rather than stored: the only caller is the switcher, and a
 * cookie the proxy would have to re-validate on every request is a cookie worth refusing here.
 */

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_YEAR = 365;
const ONE_YEAR_SECONDS = SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY * DAYS_PER_YEAR;

export async function setLocaleAction(target: string): Promise<void> {
  if (!isLocale(target)) {
    return;
  }
  const store = await cookies();
  store.set(LOCALE_COOKIE, target, {
    // Nothing in the browser reads this; the proxy does.
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });
}
