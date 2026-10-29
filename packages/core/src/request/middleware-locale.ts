import { literalAt, quantifierAt } from './pattern-syntax.ts';

/** The canonical optional data prefix and locale guard emitted by supported Next.js builds. */
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

interface LocalePattern {
  readonly prefix: string;
  readonly length: number;
  readonly probe: string;
  readonly page: string;
  readonly data: string;
}

/** At most three derived sources per compiled matcher; no visitor pathname is retained. */
const patterns = new WeakMap<RegExp, LocalePattern | null>();

function localePattern(pattern: RegExp): LocalePattern | null {
  const known = patterns.get(pattern);
  if (known !== undefined) return known;
  const { source, flags } = pattern;
  const dataAt = source.indexOf(DATA);
  const localeAt = dataAt + DATA.length;
  let parsed: LocalePattern | null = null;
  if (
    (flags === '' || flags === 'i') &&
    source.startsWith('^') &&
    dataAt >= 1 &&
    source.startsWith(LOCALE, localeAt) &&
    quantifierAt(source, localeAt + LOCALE.length) === undefined
  ) {
    const base = source.slice(1, dataAt);
    const length = literalLength(base);
    if (length !== undefined) {
      const before = source.slice(0, dataAt);
      const after = `${LOCALE_WITHOUT_LOOKAHEAD}${source.slice(localeAt + LOCALE.length)}`;
      parsed = {
        prefix: `^${base}`,
        length,
        probe: `${before}${DATA}${after}`,
        page: `${before}${after}`,
        data: `${before}${DATA.slice(0, -1)}${after}`,
      };
    }
  }
  patterns.set(pattern, parsed);
  return parsed;
}

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
  const parsed = localePattern(pattern);
  if (parsed === null) return UNSUPPORTED;
  const { length } = parsed;
  const mismatch = { kind: 'mismatch', source: parsed.probe } as const;
  if (!prefixHolds(parsed.prefix)) return mismatch;
  // ASCII-only folding has the exact length and matching semantics of these ASCII names under /i.
  const folded = pattern.ignoreCase
    ? value.replaceAll(UPPER_CASE, (letter) => letter.toLowerCase())
    : value;
  if (folded[length] !== '/') return mismatch;
  let data = false;
  let localeStart = length + 1;
  if (folded.startsWith('/_next/', length)) {
    if (!folded.startsWith(DATA_PATH, length)) return mismatch;
    const buildStart = length + DATA_PATH.length;
    const slash = folded.indexOf('/', buildStart);
    if (slash <= buildStart) return mismatch;
    localeStart = slash + 1;
    data = true;
  }
  if (folded.startsWith('_next/', localeStart)) return mismatch;
  return {
    kind: 'source',
    source: data ? parsed.data : parsed.page,
  };
}
