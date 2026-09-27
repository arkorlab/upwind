import type { Locale } from '@/i18n/locales.ts';

import type { Copy } from './copy.ts';
import { en } from './en.ts';
import { ja } from './ja.ts';

/**
 * The words for a locale.
 *
 * Both dictionaries are in the bundle either way — two objects of strings, and a build that loaded
 * one of them dynamically would only have traded the size for a reason to be asynchronous.
 */
export function dictionary(locale: Locale): Copy {
  return locale === 'en' ? en : ja;
}
