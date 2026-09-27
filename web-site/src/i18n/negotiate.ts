import { defaultLocale, isLocale, type Locale, locales } from './locales.ts';

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
const WILDCARD = '*';

function parseRange(part: string): LanguageRange | undefined {
  const [rawTag = '', ...params] = part.trim().split(';');
  const tag = rawTag.trim().toLowerCase();
  if (tag === '') {
    return undefined;
  }
  let quality = DEFAULT_QUALITY;
  for (const param of params) {
    // The grammar has no space around the `=`, and headers arrive with one anyway. A parameter
    // written `q = 0.5` is a preference somebody expressed, and reading it costs two `trim`s.
    const [key = '', value] = param.split('=', 2);
    if (key.trim().toLowerCase() === 'q' && value !== undefined) {
      const parsed = Number.parseFloat(value.trim());
      // A `q` that is not a number is not a preference; zero drops the range from the reckoning.
      quality = Number.isNaN(parsed) ? 0 : parsed;
    }
  }
  return { tag, quality };
}

/**
 * The header's ranges, best first, **zeroes included**.
 *
 * A `q=0` is not an absent preference but a refusal — `en;q=0` says *not English* — and the
 * selection below needs to hear it. `toSorted` is stable, so ranges of equal quality keep the order
 * they were written in, which is what makes "the first range naming this language" the best one.
 */
function parseAcceptLanguage(header: string | null): LanguageRange[] {
  if (header === null || header.trim() === '') {
    return [];
  }
  const ranges: LanguageRange[] = [];
  for (const part of header.split(',')) {
    const range = parseRange(part);
    if (range !== undefined) {
      ranges.push(range);
    }
  }
  return ranges.toSorted((a, b) => b.quality - a.quality);
}

/** The language of a tag: `ja-JP` is Japanese, and a tag that names no language this site has is not. */
function localeOf(tag: string): Locale | undefined {
  const base = tag.split('-', 1)[0] ?? '';
  return isLocale(base) ? base : undefined;
}

/**
 * Score each language this site is written in, and serve the best.
 *
 * Not "the first range that names a language we have": a header ranks what it asks for, and the
 * ranking has to be read as a whole. `*;q=1, ja;q=0.5` prefers *anything* to Japanese, so it is
 * asking for English; `en;q=0, *;q=1, ja;q=0.5` asks for anything except English, which leaves
 * Japanese — and a wildcard read as "the default" would have answered in the one language the header
 * ruled out. So a language takes the quality of the range that names it, or the wildcard's where
 * nothing names it, and the highest wins.
 *
 * Ties go to the earlier entry in `locales`, which is the default. So does a header that accepts
 * neither language: a site with two of them and a `406` would be a site with no answer at all.
 */
export function negotiateLocale(header: string | null): Locale {
  const ranges = parseAcceptLanguage(header);
  const wildcard = ranges.find((range) => range.tag === WILDCARD);
  let best: Locale = defaultLocale;
  let bestQuality = 0;
  for (const locale of locales) {
    const named = ranges.find((range) => localeOf(range.tag) === locale);
    const quality = named?.quality ?? wildcard?.quality ?? 0;
    if (quality > bestQuality) {
      best = locale;
      bestQuality = quality;
    }
  }
  return bestQuality > 0 ? best : defaultLocale;
}
