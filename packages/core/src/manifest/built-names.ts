/**
 * The name Next.js gives what it builds, read off the path a request asks by: one reading for the
 * edge's lookups of what the build named and for the deployment's runtime, so that the two find the
 * same page by the same path.
 */

/** What `escapePathDelimiters` escapes in a page's name: a delimiter, or one already escaped. */
const PATH_DELIMITER = /[/#?\\]|%(?:2f|23|3f|5c)/giu;

/**
 * A segment of a page's name as Next.js names a page it builds: decoded, with what would delimit a
 * path escaped back (`escapePathDelimiters(…, true)`), so that a parameter's `/` stays inside its
 * segment.
 */
export function builtSegment(decoded: string): string {
  return decoded.replaceAll(PATH_DELIMITER, (found) => encodeURIComponent(found));
}

/**
 * The name Next.js builds what a path asks for under: each segment decoded and built back
 * (`builtSegment`), as `getStaticPaths` names an entry it is handed as a path
 * (`build/static-paths/pages.ts`) and as a dynamic route reads a member's value — with its `/`
 * inside the segment. `/docs/a%2fb` asks for `/docs/a%2Fb`, the member whose value is `a/b`, and
 * never for `/docs/a/b`, which decoding the path whole read it as. `undefined` where a segment does
 * not decode.
 */
export function builtNameOf(path: string): string | undefined {
  try {
    return path
      .split('/')
      .map((segment) => builtSegment(decodeURIComponent(segment)))
      .join('/');
  } catch {
    return undefined;
  }
}

/** The base an escape writes a byte in. */
const HEX = 16;

/**
 * What `builtSegment` escaped back in a segment of a page's name: a delimiter (`%2F` for `/`), or an
 * escape that stood in the value as it is (`%252F` for `%2F`) — which a value that held `%252F`
 * already holds too, as `builtSegment` leaves it as it is.
 */
const BUILT_ESCAPE = /%25(2f|23|3f|5c)|%(?:2f|23|3f|5c)/giu;

/**
 * What a URL reads as its own in a path that a name may hold as it is: a `%`, which would start an
 * escape, a `#` or a `?`, which would end the path, a `\`, which it reads as a `/`, and a control
 * character or a space, which it drops — a tab or a line break wherever it stands, and the others
 * at either end of what it is handed.
 */
const URL_SYNTAX = /[\p{Cc} %#?\\]/gu;

/**
 * The same, of a page's name, but for a `%` that starts an escape `builtSegment` wrote (`%2F` for a
 * parameter's `/`, `%252F` for an escape that stood in its value as it is): the name's own.
 */
const NAME_SYNTAX = /%(?!(?:25)?(?:2f|23|3f|5c))|[\p{Cc} #?\\]/giu;

/**
 * A surrogate standing alone: read a code point at a time, a pair is the character it encodes, and
 * only a half without its other half is a surrogate. What `isWellFormed` tells, for a library that
 * predates it.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Whether no path a request asks by names `name`: one a URL resolves away a segment of (`.` or `..`),
 * one with an empty segment (`//`), which the router redirects to the path without it — and which,
 * first, a URL written relative to the site reads as naming another host — one that is no absolute
 * path, and one that is no well-formed text, whose lone surrogate a URL takes for a replacement
 * character.
 */
function unaddressable(name: string): boolean {
  return (
    LONE_SURROGATE.test(name) ||
    !name.startsWith('/') ||
    name.includes('//') ||
    name.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

/**
 * What a URL keeps in a path as it is written and reads as nothing but itself: a letter, a digit,
 * and the marks it lets stand. A `%` starts an escape, and a `/` ends a segment.
 */
const PLAIN = /^[\w!$&'()*+,.:;=@[\]|~-]$/u;

/** A digit of an escape in capitals, and, where it is a letter, in small letters too. */
function casesOf(digit: string): readonly string[] {
  const small = digit.toLowerCase();
  return small === digit ? [digit] : [digit, small];
}

/**
 * The ways a request may write `byte` in a path, each read back as that byte: as it is, where a URL
 * keeps it so (`PLAIN`), and escaped, each letter of the escape in capitals or in small letters —
 * a URL keeps an escape as it is written.
 */
function formsOf(byte: number): readonly string[] {
  const digits = byte.toString(HEX).toUpperCase().padStart(2, '0');
  const lows = casesOf(digits.slice(1));
  const escapes = casesOf(digits.slice(0, 1)).flatMap((high) =>
    lows.map((low) => `%${high}${low}`),
  );
  const plain = String.fromCodePoint(byte);
  return PLAIN.test(plain) ? [plain, ...escapes] : escapes;
}

/**
 * `chosen`, the choice made for each of `sizes` places, moved on to the next as a counter counts:
 * the last place first, and a place with no choice left back to its first. Whether there was one.
 */
function advance(chosen: number[], sizes: readonly number[]): boolean {
  for (let index = chosen.length - 1; index >= 0; index -= 1) {
    const next = (chosen[index] ?? 0) + 1;
    if (next < (sizes[index] ?? 0)) {
      chosen[index] = next;
      return true;
    }
    chosen[index] = 0;
  }
  return false;
}

/**
 * Every spelling of the path whose segments are `segments`, each byte of them written in each of
 * its forms (`formsOf`), so that each reads back decoded as the path: one at a time, as many as the
 * forms multiply to. The most readable comes first, then one byte after another is written
 * otherwise, the path's last first: its first segments, where a locale or a prefix the edge reads as
 * it is stands, are the last to change.
 */
export function* spellingsOf(segments: readonly string[]): Generator<string, void, undefined> {
  const encoder = new TextEncoder();
  const bySegment = segments.map((segment) =>
    [...encoder.encode(segment)].map((byte) => formsOf(byte)),
  );
  const forms = bySegment.flat();
  const sizes = forms.map((byteForms) => byteForms.length);
  const chosen = forms.map(() => 0);
  do {
    const written = chosen.map((choice, index) => forms[index]?.[choice] ?? '');
    yield bySegment.map((bytes) => written.splice(0, bytes.length).join('')).join('/');
  } while (advance(chosen, sizes));
}

/** Both ways an escaped escape reads back (`memberValuesOf`). */
const BOTH_WAYS = 2;

/**
 * Every list of values the segments of a page's name may stand for, `builtSegment` read back. An
 * escaped delimiter is the delimiter. An escaped escape (`%252F`) is either the escape (`%2F`),
 * which `builtSegment` escapes, or itself, which it leaves as it is — each one on its own, so a name
 * that holds several was built from as many lists as the choices multiply to: each read back
 * first, and each left as it is last.
 */
export function* memberValuesOf(
  segments: readonly string[],
): Generator<readonly string[], void, undefined> {
  const escapes = segments.flatMap((segment) =>
    [...segment.matchAll(BUILT_ESCAPE)].filter((match) => match[1] !== undefined),
  );
  const sizes = escapes.map(() => BOTH_WAYS);
  const kept = escapes.map(() => 0);
  do {
    const choices = kept.values();
    yield segments.map((segment) => {
      return segment.replaceAll(BUILT_ESCAPE, (found, escape?: string) => {
        if (escape === undefined) {
          // The delimiter's escape is the match itself: `%2F`, whose code is the two digits after `%`.
          return String.fromCodePoint(Number.parseInt(found.slice(1), HEX));
        }
        return choices.next().value === 1 ? found : `%${escape}`;
      });
    });
  } while (advance(kept, sizes));
}

/** What a URL reads as its own in a segment of a path: `URL_SYNTAX`, and a `/`, which ends it. */
const SEGMENT_SYNTAX = /[\p{Cc} %#?\\/]/gu;

/**
 * The path a request asks by for a page whose segments stand for `values`: each escaped as little
 * as a request may (`SEGMENT_SYNTAX`), and the rest left to the URL it is written into, as
 * `requestPathOf` asks for a page by its name.
 */
export function readablePathOf(values: readonly string[]): string {
  return values
    .map((value) => value.replaceAll(SEGMENT_SYNTAX, (found) => encodeURIComponent(found)))
    .join('/');
}

/** `readable`, and then every spelling of the path of `segments` (`spellingsOf`). */
function* readableFirst(
  readable: string,
  segments: readonly string[],
): Generator<string, void, undefined> {
  yield readable;
  yield* spellingsOf(segments);
}

/** Only ever used to read out of a URL the path a request asking by a spelling holds. */
const REQUEST_ORIGIN = 'https://request.invalid';

/**
 * A way a request's path is read as a name: the values its segments decode to, and the spelling of
 * them a request asks by first, escaped as little as it may.
 */
export interface Reading {
  readonly readable: string;
  readonly values: readonly string[];
}

/**
 * The spelling of one reading a request reaches `key` by (`spellingReaching`): the first whose
 * path, read out of a URL it is written into, `read` finds `key` by; `undefined` once one reads as
 * nothing, or as a name another read as already.
 */
function spellingOf(
  key: string,
  read: (pathname: string) => string | undefined,
  reading: Reading,
): string | undefined {
  const tried = new Set<string>();
  const readAs = new Set<string>();
  for (const spelling of readableFirst(reading.readable, reading.values)) {
    const { pathname } = new URL(spelling, REQUEST_ORIGIN);
    if (tried.has(pathname)) {
      continue;
    }
    tried.add(pathname);
    const name = read(pathname);
    if (name === key) {
      return spelling;
    }
    if (name === undefined || readAs.has(name)) {
      return undefined;
    }
    readAs.add(name);
  }
  return undefined;
}

/**
 * The spelling a request reaches `key` by: of each of `readings` in turn, its readable spelling and
 * then every other (`spellingsOf`), the first whose path, read out of a URL it is written into,
 * `read` finds `key` by. The edge finds a name as spelled before it reads a path any other way —
 * decoded, or as the name it builds to — and every spelling of one reading reads alike those ways:
 * a spelling reads as the name spelled as it, or as what every spelling of the reading no name is
 * spelled as reads as. So once one reads as nothing, or as a name another of its reading read as
 * already, none left of the reading reaches `key` — `key`'s own spelling, where it has one, is the
 * most readable, and was first — and the search goes on to the next reading. Of each, it tries at
 * most two spellings more than there are names spelled as one of them. `undefined` where none
 * reaches `key`.
 */
export function spellingReaching(
  key: string,
  read: (pathname: string) => string | undefined,
  readings: Iterable<Reading>,
): string | undefined {
  const walked = new Set<string>();
  for (const reading of readings) {
    // Two readings of the same values are spelled alike, and read alike.
    const values = JSON.stringify(reading.values);
    if (!walked.has(values)) {
      walked.add(values);
      const spelling = spellingOf(key, read, reading);
      if (spelling !== undefined) {
        return spelling;
      }
    }
  }
  return undefined;
}

/**
 * A file's path as a request names it: what a URL reads as its own escaped (`URL_SYNTAX`), and the
 * rest left to the URL it is written into, which escapes a character past ASCII as a browser's
 * does. Read back decoded whole, it is `path` again, as the edge finds a file the build shipped
 * (`staticFileKey`). Written into a URL as it is, `/50% off.png` asks for no file: its `%` and the
 * escape its space becomes read as one escape that is none. `undefined` where no path a request asks
 * by names it (`unaddressable`).
 */
export function escapedPathOf(path: string): string | undefined {
  return unaddressable(path)
    ? undefined
    : path.replaceAll(URL_SYNTAX, (found) => encodeURIComponent(found));
}

/**
 * The path a request asks for the page Next.js built under `name` by: what a URL reads as its own
 * escaped (`NAME_SYNTAX`) — a `%` that stood in a parameter's value as it is, above all — and the
 * rest left to the URL it is written into, as a browser leaves a link's. Read back (`builtNameOf`),
 * it is the name again. Written into a URL as it is, a name asks for another page, or for none:
 * `/docs/100%` holds a `%` that starts no escape, which no reading of the path decodes. `undefined`
 * where no path a request asks by names it (`unaddressable`): a parameter whose value is `..` names
 * a page no URL reaches, as `['', 'other.example']` for a root catch-all names one at
 * `//other.example`.
 */
export function requestPathOf(name: string): string | undefined {
  return unaddressable(name)
    ? undefined
    : name.replaceAll(NAME_SYNTAX, (found) => encodeURIComponent(found));
}
