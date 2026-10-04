import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { compareCodeUnits } from '@stayingupwind/core/util';

import { mapFileOf } from './source-maps.ts';

/**
 * The server chunks whose code is another chunk's, each to the file that holds it.
 *
 * Turbopack writes the same chunk more than once under different names — the same modules, reached
 * from different entrypoints — and a Function that loaded each by its own file carried the code as
 * many times: megabytes, in a large application. The chunk table loads one file for all of them
 * instead (`turbopack-runtime.ts`). That is the same thing to the Turbopack runtime: a chunk is a
 * list of module factories it installs by module id, and the second copy installs the very
 * factories the first did.
 *
 * Two chunks are the same when their code is, byte for byte, once three things that name the file
 * rather than say what it does are set aside, and nothing else is:
 *
 * - the `sourceMappingURL` comment the file ends with, which names its map (the Function carries
 *   none);
 * - the `debugId` and `chunkId` comments beside it, which a build or an error tracker writes to
 *   identify the file;
 * - the statement some of them put on the first line, which records that identifier against the
 *   stack of the file that runs it — and inside one bundle every chunk's stack names the same file,
 *   so the identifiers recorded there never told the chunks apart to begin with.
 *
 * And when their maps are the same, but for the same names (`comparedMap`): the Function's map is
 * composed through the map of the file each chunk is loaded from (`source-maps.ts`), so a copy loaded
 * from another chunk's file is read through that chunk's map, which is right only where the two
 * maps say the same.
 */

/** What in a map names its file rather than the code it maps: set aside, as the comments are. */
const MAP_NAMING_KEYS: ReadonlySet<string> = new Set(['debug_id', 'debugId', 'file']);
/** A map a chunk carries inside its last comment rather than beside it. */
const INLINE_MAP = /\/\/[#@] sourceMappingURL=(data:\S*)\s*$/u;
/** How far back an inline map's comment is looked for: the last line, and a map is long. */
const INLINE_TAIL = 1_048_576;

/** A comment naming the file, which a build writes last: only there are they set aside. */
const MAP_OR_ID_COMMENT = /^\/\/[#@] (?:sourceMappingURL|debugId|chunkId)=/u;
const UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/giu;
const ANY_ID = '00000000-0000-0000-0000-000000000000';
/** Longer than any such statement, and short enough that a first line of code is not read whole. */
const ID_STATEMENT_MAX = 1024;
const ID_STATEMENT_STARTS = ['!function(){try', ';!function(){try'];
const ID_STATEMENT_END = '}catch(e){}}();';
const ID_MAPS = ['_debugIds', '_sentryDebugIds', '_posthogChunkIds'];

/**
 * Whether `line` is that statement: one function, run where it is written, that reads the stack
 * and records into one of the maps the identifiers are kept in, and swallows whatever it throws.
 */
function recordsAnId(line: string): boolean {
  return (
    ID_STATEMENT_STARTS.some((start) => line.startsWith(start)) &&
    line.endsWith(ID_STATEMENT_END) &&
    line.includes('(new e.Error).stack') &&
    ID_MAPS.some((map) => line.includes(map))
  );
}

/** The chunk's code, with only what names the file set aside. */
export function chunkCode(source: string): string {
  const end = source.indexOf('\n');
  const first = end === -1 || end > ID_STATEMENT_MAX ? undefined : source.slice(0, end);
  const code =
    first !== undefined && recordsAnId(first)
      ? `${first.replaceAll(UUID, () => ANY_ID)}${source.slice(end)}`
      : source;
  return withoutFileComments(code);
}

/**
 * `source` less the run of comments naming the file on its last lines, and the whitespace after
 * them; `source` itself when it does not end in one. Read a line at a time from the end, rather than
 * by a pattern that would try every such comment in a chunk of megabytes against the rest of it.
 */
function withoutFileComments(source: string): string {
  let kept = source.trimEnd();
  let stripped = false;
  for (let start = kept.lastIndexOf('\n'); start !== -1; start = kept.lastIndexOf('\n')) {
    if (!MAP_OR_ID_COMMENT.test(kept.slice(start + 1))) {
      break;
    }
    kept = kept.slice(0, start);
    stripped = true;
  }
  return stripped ? kept : source;
}

/**
 * Each chunk of `chunks` whose code another of them has, to that other: the first of the ones that
 * share it, in the order of the paths, so the same build always keeps the same file.
 */
export async function sameChunks(chunks: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const firstByCode = new Map<string, string>();
  const copies = new Map<string, string>();
  const ordered = [...new Set(chunks)].toSorted((a, b) => compareCodeUnits(a, b));
  for (const chunk of ordered) {
    const source = await readFile(chunk, 'utf8');
    const digest = createHash('sha256')
      .update(chunkCode(source))
      .update('\0')
      .update(await comparedMap(source, chunk))
      .digest('hex');
    const first = firstByCode.get(digest);
    if (first === undefined) {
      firstByCode.set(digest, chunk);
    } else {
      copies.set(chunk, first);
    }
  }
  return copies;
}

/**
 * The map a chunk names, as it is compared with another chunk's (`sameChunks`): beside it, read and
 * written again without what names its file (`MAP_NAMING_KEYS`); inside its last comment, as written;
 * nothing where it names none, or none is there to read — which another chunk's map, read or not, is
 * not the same as.
 */
async function comparedMap(source: string, chunk: string): Promise<string> {
  const inline = INLINE_MAP.exec(source.slice(-INLINE_TAIL))?.[1];
  if (inline !== undefined) {
    return inline;
  }
  const file = mapFileOf(source, chunk);
  if (file === undefined) {
    return '';
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return '';
  }
  try {
    const map = JSON.parse(text) as unknown;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      return text;
    }
    return JSON.stringify(
      Object.fromEntries(Object.entries(map).filter(([key]) => !MAP_NAMING_KEYS.has(key))),
    );
  } catch {
    return text;
  }
}
