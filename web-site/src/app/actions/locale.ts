'use server';

import { cookies } from 'next/headers';

import { localeCookieOptions } from '@/i18n/locale-cookie.ts';
import { isLocale } from '@/i18n/locales.ts';

/**
 * Remember which language was chosen, from the switch in the header.
 *
 * The proxy reads this cookie on a bare path, so a reader who switched to Japanese and later types
 * the site's name into the address bar lands on Japanese instead of being negotiated at again. A
 * value that is not a locale is dropped rather than stored: the only caller is the switcher, and a
 * cookie the proxy would have to re-validate on every request is a cookie worth refusing here.
 */
export async function setLocaleAction(target: string): Promise<void> {
  if (!isLocale(target)) {
    return;
  }
  const { name, ...options } = localeCookieOptions;
  const store = await cookies();
  store.set(name, target, options);
}
