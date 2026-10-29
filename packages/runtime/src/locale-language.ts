// SPDX-License-Identifier: MIT
// Based on Next.js accept-header (Copyright (c) 2025 Vercel, Inc.); see ../NOTICE.
/** Language selection follows Next.js's accept-header ordering, including wildcard exclusions. */
interface Preference {
  readonly locale: string;
  readonly order: number;
}
interface Selection {
  readonly language: string;
  readonly order: number;
  readonly quality: number;
  readonly preference: number | undefined;
}
const MIN_QUALITY = 0.001;
const MAX_FIELD_PARTS = 2;
const preferencesByLocales = new WeakMap<readonly string[], ReadonlyMap<string, Preference>>();

function preferencesOf(locales: readonly string[]): ReadonlyMap<string, Preference> {
  const cached = preferencesByLocales.get(locales);
  if (cached !== undefined) return cached;
  const preferences = new Map<string, Preference>();
  let order = 0;
  for (const locale of locales) {
    const lower = locale.toLowerCase();
    preferences.set(lower, { locale, order });
    order += 1;
    const segments = lower.split('-');
    while (segments.length > 1) {
      segments.pop();
      const prefix = segments.join('-');
      if (!preferences.has(prefix)) {
        preferences.set(prefix, { locale, order });
        order += 1;
      }
    }
  }
  preferencesByLocales.set(locales, preferences);
  return preferences;
}

function qualityOf(parameter: string | undefined): number | undefined {
  if (parameter === undefined) return 1;
  const [key, value] = parameter.split('=', 2);
  if (value === undefined || value === '' || (key !== 'q' && key !== 'Q')) return undefined;
  const score = Number.parseFloat(value);
  if (score === 0) return 0;
  return Number.isFinite(score) && score <= 1 && score >= MIN_QUALITY ? score : 1;
}

function compare(left: Selection, right: Selection): number {
  if (left.quality !== right.quality) return right.quality - left.quality;
  if (left.preference !== right.preference) {
    if (left.preference === undefined) return 1;
    if (right.preference === undefined) return -1;
    return left.preference - right.preference;
  }
  return left.order - right.order;
}

function selectionsOf(
  header: string,
  preferences: ReadonlyMap<string, Preference>,
): { readonly selections: Selection[]; readonly named: Set<string> } | undefined {
  const selections: Selection[] = [];
  const named = new Set<string>();
  for (const [order, part] of header.replaceAll(/[\t ]/gu, '').split(',').entries()) {
    if (part === '') continue;
    const fields = part.split(';', MAX_FIELD_PARTS + 1);
    const language = fields[0]?.toLowerCase();
    if (language === undefined || language === '' || fields.length > MAX_FIELD_PARTS)
      return undefined;
    named.add(language);
    const quality = qualityOf(fields[1]);
    if (quality === undefined) return undefined;
    if (quality !== 0) {
      selections.push({ language, order, quality, preference: preferences.get(language)?.order });
    }
  }
  return { selections, named };
}

/** An invalid field is ignored in full, as Next's getLocaleRedirect ignores a parser failure. */
export function preferredLanguage(header: string, locales: readonly string[]): string | undefined {
  const preferences = preferencesOf(locales);
  const parsed = selectionsOf(header, preferences);
  if (parsed === undefined) return undefined;
  for (const { language } of parsed.selections.toSorted(compare)) {
    if (language === '*') {
      for (const [name, preference] of preferences) {
        if (!parsed.named.has(name)) return preference.locale;
      }
    } else {
      const preference = preferences.get(language);
      if (preference !== undefined) return preference.locale;
    }
  }
  return undefined;
}
