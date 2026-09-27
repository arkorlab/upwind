/**
 * The two languages this site is written in, and the spellings each of them needs.
 *
 * English is the default and is served on the bare path, because the repository, the readmes and the
 * issue tracker are all in English and a reader who arrives from any of them is already there.
 * Japanese lives under `/ja`. There is no third locale and no library: two languages, one page, and
 * a page that renders from a dictionary it is handed.
 */

export const locales = ['en', 'ja'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

/** What the proxy reads on a bare path, and what the switcher writes so a choice outlives a visit. */
export const LOCALE_COOKIE = 'locale';

const LOCALE_SET: ReadonlySet<string> = new Set(locales);

export function isLocale(value: string): value is Locale {
  return LOCALE_SET.has(value);
}

/** `og:locale` takes a language *and* a region; `<html lang>` takes the language alone. */
export const ogLocale: Record<Locale, 'en_US' | 'ja_JP'> = {
  en: 'en_US',
  ja: 'ja_JP',
};

export const htmlLang: Record<Locale, string> = {
  en: 'en',
  ja: 'ja',
};

/** The other one: what hreflang alternates name, and what the switcher switches to. */
export function otherLocale(locale: Locale): Locale {
  return locale === 'en' ? 'ja' : 'en';
}

/**
 * A language's own name for itself, and the invitation to switch to it — both written *in* it.
 *
 * Not in the dictionaries, because neither is a sentence of the page's language: the switch on the
 * English page says 日本語 and means it in Japanese, which is why the button carries `lang` and why a
 * reader who cannot read the page can still read the way out of it. A label half in one language and
 * half in the other is the thing this avoids: a screen reader announces one `lang` per element, and
 * would say "Language" in a Japanese voice.
 */
export const localeName: Record<Locale, string> = {
  en: 'English',
  ja: '日本語',
};

export const switchToLocale: Record<Locale, string> = {
  en: 'Switch to English',
  ja: '日本語に切り替える',
};
