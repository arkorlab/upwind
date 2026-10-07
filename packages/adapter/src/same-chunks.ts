import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { compareCodeUnits } from '@stayingupwind/core/util';

import type { KeptMaps } from './kept-maps.ts';
import { type ProjectBounds, projectOnly, resolvedSource } from './project-maps.ts';
import { flattened, mapFileOf } from './source-maps.ts';

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
 * And, where the Functions carry maps, when their maps are the same, but for the same names
 * (`comparedMap`): the Function's map is composed through the map of the file each chunk is loaded
 * from (`source-maps.ts`), so a copy loaded from another chunk's file is read through that chunk's
 * map, which is right only where the two maps say the same. A build that carries none bundles a copy
 * once whatever its map says.
 */

/** What a chunk's map is, as the Functions' maps are composed (`sourceMapsPlugin`). */
export interface ChunkMaps {
  /** Whether the Functions carry maps at all (`carriesMaps`). */
  readonly carried: boolean;
  /** What the build's own hook left each chunk it saw (`kept-maps.ts`): the word on that chunk's map. */
  readonly kept?: KeptMaps | undefined;
  /**
   * Where the Functions carry the project's own files alone (`'project'`), the bounds of it: a map is
   * compared as `projectOnly` leaves it, which is all of it the Function's map carries.
   */
  readonly project?: ProjectBounds | undefined;
}

/**
 * What in a map is set aside: what names its file rather than the code it maps, as the comments are,
 * and the sources' own text, which the Function's map is written without (`sourcemapOutput`).
 */
const MAP_NAMING_KEYS: ReadonlySet<string> = new Set([
  'debug_id',
  'debugId',
  'file',
  'sourcesContent',
]);
/** A comment naming the file a build writes after its map comment: nothing it names is code. */
const ID_COMMENT = /^\/\/[#@] (?:debugId|chunkId)=/u;
/** The comment a build names a chunk's map by, the last of which is the map. */
const MAP_COMMENTS = ['//# sourceMappingURL=', '//@ sourceMappingURL='];
const DATA_URL_PREFIX = 'data:';
const BASE64_MARKER = ';base64,';

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
export async function sameChunks(
  chunks: readonly string[],
  maps: ChunkMaps,
): Promise<ReadonlyMap<string, string>> {
  const firstByCode = new Map<string, string>();
  const copies = new Map<string, string>();
  const ordered = [...new Set(chunks)].toSorted((a, b) => compareCodeUnits(a, b));
  for (const chunk of ordered) {
    const source = await readFile(chunk, 'utf8');
    const digest = createHash('sha256')
      .update(chunkCode(source))
      .update('\0')
      .update(maps.carried ? await comparedMap(source, chunk, maps) : '')
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
 * The map a chunk is composed through, as it is compared with another chunk's (`sameChunks`): two of
 * them, the one the plugin hands on and the one a bundler may read itself. Where the build's hook saw
 * the chunk (`kept`), both are the map it left, as `sourceMapsPlugin` reads it; otherwise, the one the
 * plugin hands on (`mapFileOf`) and the one the chunk's last `sourceMappingURL` comment names, in
 * either spelling, inside it or beside it. Nothing for one there is none of, which another chunk's map
 * is not the same as. Both rather than either: a map read here that the plugin would not hand on can
 * only keep two chunks apart, never take one for another. And two in either case, so that a chunk
 * the hook saw and one it did not are the same where one map describes both.
 */
async function comparedMap(source: string, chunk: string, maps: ChunkMaps): Promise<string> {
  const left = maps.kept?.mapFor(chunk);
  if (left?.seen === true) {
    const kept =
      left.file === undefined
        ? ''
        : await mapFileKey(left.file, left.origin ?? left.file, maps.project);
    return `${kept}\0${kept}`;
  }
  const handed = mapFileOf(source, chunk);
  const loaded = handed === undefined ? '' : await mapFileKey(handed, handed, maps.project);
  return `${loaded}\0${await lastCommentKey(source, chunk, maps.project)}`;
}

/** What the chunk's last `sourceMappingURL` comment names, as it is compared (`canonicalMap`). */
async function lastCommentKey(
  source: string,
  chunk: string,
  project: ProjectBounds | undefined,
): Promise<string> {
  const url = lastMapUrl(source);
  if (url === undefined) {
    return '';
  }
  if (url.startsWith(DATA_URL_PREFIX)) {
    return canonicalMap(dataOf(url), chunk, project);
  }
  let file: string;
  try {
    // As a URL, as `mapFileOf` reads it: Turbopack percent-encodes a chunk's brackets.
    file = path.join(path.dirname(chunk), decodeURIComponent(url));
  } catch {
    return url;
  }
  return await mapFileKey(file, file, project);
}

/**
 * What the last `sourceMappingURL` comment of a chunk names, in either spelling (`MAP_COMMENTS`), where
 * nothing but space and the comments naming the file (`ID_COMMENT`) follows it; nothing otherwise. Found by its last occurrence anywhere in the chunk,
 * since a map inside one is as long as the chunk is, or longer.
 */
function lastMapUrl(source: string): string | undefined {
  let at = -1;
  let comment = '';
  for (const candidate of MAP_COMMENTS) {
    const found = source.lastIndexOf(candidate);
    if (found > at) {
      at = found;
      comment = candidate;
    }
  }
  if (at === -1) {
    return undefined;
  }
  const rest = source.slice(at + comment.length);
  const url = rest.split(/\s/u, 1)[0] ?? '';
  // Nothing but space after it, or the comments that name the file beside it (`debugId`, `chunkId`).
  const after = rest
    .slice(url.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return url === '' || after.some((line) => !ID_COMMENT.test(line)) ? undefined : url;
}

/** A data URL's text: base64 where it says so, percent-encoded otherwise. */
function dataOf(url: string): string {
  const comma = url.indexOf(',');
  const payload = url.slice(comma + 1);
  try {
    return url.slice(0, comma + 1).endsWith(BASE64_MARKER)
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } catch {
    return url;
  }
}

/**
 * A map file as it is compared (`canonicalMap`): read at `file`, and naming its sources from `origin`,
 * where the build wrote it.
 *
 * Nothing where there is no file, which is the none the plugin hands on for it too. Its path where
 * there is one that was not read: read again when the Function is bundled, it may say anything, and
 * two such maps are only known to say the same where they are one file.
 */
async function mapFileKey(
  file: string,
  origin: string,
  project: ProjectBounds | undefined,
): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return isMissing(error) ? '' : file;
  }
  return canonicalMap(text, origin, project);
}

/** Whether a read failed for there being no file at the path. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/**
 * A map as it is compared: flattened as Rolldown is handed it (`flattened`), as `projectOnly` leaves
 * it where the Functions carry the project's files alone, without what names its file
 * (`MAP_NAMING_KEYS`), and with each source the file it names (`resolvedSource`) — a source is
 * relative to where its map was written (`file`, which an inline map is the chunk itself for, and a
 * map kept through the build's hook its first path), and two maps that write one path from two
 * directories name two files. As written where it is no map at all.
 */
function canonicalMap(text: string, file: string, project: ProjectBounds | undefined): string {
  let map: unknown;
  try {
    const flat = flattened(text, file);
    map = JSON.parse(project === undefined ? flat : projectOnly(flat, file, project));
  } catch {
    return text;
  }
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return text;
  }
  const fields = map as Record<string, unknown>;
  const root = typeof fields['sourceRoot'] === 'string' ? fields['sourceRoot'] : undefined;
  const sources = Array.isArray(fields['sources'])
    ? fields['sources'].map((source: unknown) =>
        typeof source === 'string' ? resolvedSource(source, root, path.dirname(file)) : source,
      )
    : fields['sources'];
  // In one order, whatever order the map was written in: a hook that rewrote one map of two may
  // have put its fields in another.
  const kept = Object.entries({ ...fields, sources })
    .filter(([key]) => !MAP_NAMING_KEYS.has(key) && key !== 'sourceRoot')
    .toSorted(([a], [b]) => compareCodeUnits(a, b));
  return JSON.stringify(Object.fromEntries(kept));
}
