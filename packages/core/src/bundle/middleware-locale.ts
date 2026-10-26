import { literalAt } from '../request/pattern-syntax.ts';

/** The exact optional data prefix and locale guard emitted by Next.js 16.4.2 and 16.4.3. */
const DATA = String.raw`(?:\/(_next\/data\/[^/]{1,}))?`;
const LOCALE = String.raw`(?:\/((?!_next\/)[^/.]{1,}))`;
const LOCALE_WITHOUT_LOOKAHEAD = String.raw`(?:\/([^/.]{1,}))`;
const DATA_PATH = '/_next/data/';
const UPPER_CASE = /[A-Z]/gu;

/** Length consumed by a literal-only prefix, or undefined for any other regexp grammar. */
function literalLength(source: string): number | undefined {
  let length = 0;
  for (let index = 0; index < source.length;) {
    const literal = literalAt(source, index);
    if (literal === undefined) return undefined;
    length += literal.char.length;
    index = literal.end;
  }
  return length;
}

type LocaleSource =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'mismatch'; readonly source: string }
  | { readonly kind: 'source'; readonly source: string };
const UNSUPPORTED = { kind: 'unsupported' } as const;

/**
 * Resolve only Next's canonical locale lookahead against the ORIGINAL path. Truncating a path
 * before the separator of `/_next/` would otherwise turn its failed lookahead into a success.
 * A path starting `_next/` cannot take the no-data branch; every other path cannot take the data
 * branch. The required locale's slash forces the build-id endpoint, so both assertion positions
 * are fixed before any payload is split. The remaining head still needs the usual safety proof.
 */
export function localeMiddlewareSource(
  pattern: RegExp,
  value: string,
  prefixHolds: (source: string) => boolean,
): LocaleSource {
  const { source } = pattern;
  const dataAt = source.indexOf(DATA);
  const localeAt = dataAt + DATA.length;
  if (!source.startsWith('^') || dataAt < 1 || !source.startsWith(LOCALE, localeAt)) {
    return UNSUPPORTED;
  }
  const base = source.slice(1, dataAt);
  const length = literalLength(base);
  if (length === undefined) return UNSUPPORTED;
  const probe = `${source.slice(0, localeAt)}${LOCALE_WITHOUT_LOOKAHEAD}${source.slice(localeAt + LOCALE.length)}`;
  const mismatch = { kind: 'mismatch', source: probe } as const;
  if (!prefixHolds(`^${base}`)) return mismatch;
  // ASCII-only folding has the exact length and matching semantics of these ASCII names under /i.
  const folded = pattern.ignoreCase
    ? value.replaceAll(UPPER_CASE, (letter) => letter.toLowerCase())
    : value;
  if (folded[length] !== '/') return mismatch;
  let data = '';
  let localeStart = length + 1;
  if (folded.startsWith('/_next/', length)) {
    if (!folded.startsWith(DATA_PATH, length)) return mismatch;
    const buildStart = length + DATA_PATH.length;
    const slash = folded.indexOf('/', buildStart);
    if (slash <= buildStart) return mismatch;
    localeStart = slash + 1;
    data = DATA.slice(0, -1);
  }
  if (folded.startsWith('_next/', localeStart)) return mismatch;
  return {
    kind: 'source',
    source: `${source.slice(0, dataAt)}${data}${LOCALE_WITHOUT_LOOKAHEAD}${source.slice(localeAt + LOCALE.length)}`,
  };
}
