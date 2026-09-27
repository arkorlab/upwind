import { defaultLocale, isLocale, type Locale } from './locales.ts';

/**
 * Which language a browser asked for, out of `Accept-Language`.
 *
 * Only consulted for a visitor who has expressed no preference of their own: the cookie the
 * switcher writes wins over the header, because a person who clicked "日本語" said something the
 * browser's configuration cannot unsay.
 */

interface LanguageRange {
  readonly tag: string;
  readonly quality: number;
}

const DEFAULT_QUALITY = 1;

function parseRange(part: string): LanguageRange | undefined {
  const [rawTag = '', ...params] = part.trim().split(';');
  const tag = rawTag.trim().toLowerCase();
  if (tag === '') {
    return undefined;
  }
  let quality = DEFAULT_QUALITY;
  for (const param of params) {
    const [key, value] = param.trim().split('=', 2);
    if (key === 'q' && value !== undefined) {
      const parsed = Number.parseFloat(value);
      // A `q` that is not a number is not a preference; treating it as zero drops the range rather
      // than letting a malformed header outrank a well-formed one.
      quality = Number.isNaN(parsed) ? 0 : parsed;
    }
  }
  return { tag, quality };
}

/** The header's ranges, best first. `toSorted` is stable, so equal qualities keep the stated order. */
function parseAcceptLanguage(header: string | null): LanguageRange[] {
  if (header === null || header.trim() === '') {
    return [];
  }
  const ranges: LanguageRange[] = [];
  for (const part of header.split(',')) {
    const range = parseRange(part);
    if (range !== undefined && range.quality > 0) {
      ranges.push(range);
    }
  }
  return ranges.toSorted((a, b) => b.quality - a.quality);
}

/**
 * Matching is by base language — `ja-JP` is Japanese — and a wildcard or a language this site is not
 * written in falls through to the default rather than to the next best thing, there being none.
 */
export function negotiateLocale(header: string | null): Locale {
  for (const range of parseAcceptLanguage(header)) {
    const base = range.tag.split('-', 1)[0] ?? '';
    if (isLocale(base)) {
      return base;
    }
  }
  return defaultLocale;
}
