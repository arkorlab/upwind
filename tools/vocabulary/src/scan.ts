import path from 'node:path';

import { searchable, type Searchable, type Term, TERMS } from './terms.ts';

/** A term a file says: where, as the file wrote it. */
export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly term: Term;
  readonly text: string;
  /** Said by the file's path rather than by what the file holds: no line is the one. */
  readonly inPath?: true;
}

interface Found {
  readonly term: Term;
  readonly at: number;
  readonly text: string;
}

/**
 * What a match says, as the file wrote it: without the spaces `searchable` put between an
 * identifier's words, which stand at the offset of the character after them, and with a run of
 * spaces — a line break the term was wrapped across among them — as one.
 */
function asWritten(searched: Searchable, start: number, end: number): string {
  let written = '';
  for (let at = start; at < end; at += 1) {
    if (searched.offsets[at] !== searched.offsets[at + 1]) {
      written += searched.text.charAt(at);
    }
  }
  return written.replaceAll(/ +/gu, ' ');
}

/** What a text says, each term at the offset in the text it starts at, in the order it says them. */
function hitsIn(text: string, terms: readonly Term[]): Found[] {
  const searched = searchable(text);
  const found = terms.flatMap((term) => {
    return [...searched.text.matchAll(term.pattern)].map((match) => {
      return {
        term,
        at: searched.offsets[match.index] ?? match.index,
        text: asWritten(searched, match.index, match.index + match[0].length),
      };
    });
  });
  return found.toSorted((left, right) => left.at - right.at);
}

/**
 * Every term finds what it says it finds, and passes over what it says it passes over. A pattern
 * that is not global counts nothing (`matchAll` refuses it), so its examples are not tried.
 */
export function selfCheck(terms: readonly Term[] = TERMS): string[] {
  const wrong: string[] = [];
  const counting = terms.filter((term) => term.pattern.global);
  for (const term of terms) {
    if (!term.pattern.global) {
      wrong.push(`${term.id}: the pattern must be global`);
      continue;
    }
    for (const example of term.finds) {
      if (hitsIn(example, counting).every((hit) => hit.term !== term)) {
        wrong.push(`${term.id}: does not find ${JSON.stringify(example)}`);
      }
    }
    for (const example of term.passes) {
      if (hitsIn(example, counting).some((hit) => hit.term === term)) {
        wrong.push(`${term.id}: finds ${JSON.stringify(example)}`);
      }
    }
  }
  return wrong;
}

/** Kinds of file binary by nature — images, fonts, compiled modules, archives — left unread. */
const BINARY_EXTENSIONS = new Set(
  [
    // Images and fonts.
    '.avif .bmp .gif .heic .ico .jpeg .jpg .png .tif .tiff .webp .eot .otf .ttf .woff .woff2',
    // Audio and video.
    '.aac .flac .m4a .mov .mp3 .mp4 .oga .ogg .ogv .opus .wav .webm',
    // Archives and compressed files.
    '.7z .br .bz2 .gz .rar .tar .tgz .xz .zip .zst',
    // Documents, data and compiled code.
    '.bin .db .dll .dylib .exe .jar .node .parquet .pdf .so .sqlite .sqlite3 .wasm',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Every file is read as text, whatever its extension: a list of the extensions to read would leave
 * out the next kind of source a package starts using. A NUL byte, or a byte that is not UTF-8, says
 * a file is not the text every source here is, so one like that is left out only where its kind is
 * binary (`BINARY_EXTENSIONS`), and refused anywhere else: read as UTF-8, a UTF-16 file's words
 * would not be found, nor a word an invalid byte had been put inside, and a check that skipped
 * either would pass whatever it said.
 */
export function textOf(file: string, bytes: Uint8Array): string | undefined {
  const binary = BINARY_EXTENSIONS.has(path.extname(file).toLowerCase());
  if (bytes.includes(0)) {
    if (binary) {
      return undefined;
    }
    throw new Error(`${file} holds a NUL byte: save it as UTF-8, or name a binary by its kind`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (binary) {
      return undefined;
    }
    throw new Error(`${file} is not UTF-8: save it as UTF-8, or name a binary by its kind`);
  }
}

/** The offset each line of `text` starts at, the first line's first. */
function lineStarts(text: string): number[] {
  return [0, ...[...text.matchAll(/\n/gu)].map((match) => match.index + 1)];
}

/**
 * What a file's path says, read as text is: a package names what it holds by its files' names as
 * much as by what they say, and an entry point found by its name says nothing of it inside.
 */
export function hitsOfPath(file: string, terms: readonly Term[] = TERMS): Hit[] {
  return hitsIn(file, terms).map((found) => {
    const column = found.at + 1;
    return { ...found, file, line: 1, column, inPath: true };
  });
}

/** What a file says, each hit at the line and column it starts at. */
export function hitsOfFile(file: string, text: string, terms: readonly Term[] = TERMS): Hit[] {
  const starts = lineStarts(text);
  return hitsIn(text, terms).map((found) => {
    const index = starts.findLastIndex((start) => start <= found.at);
    const column = found.at - (starts[index] ?? 0) + 1;
    return { ...found, file, line: index + 1, column };
  });
}
