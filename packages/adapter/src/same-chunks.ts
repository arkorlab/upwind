import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { compareCodeUnits } from '@stayingupwind/core/util';

import type { KeptMaps } from './kept-maps.ts';
import { resolvedSource } from './project-maps.ts';
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
}

/** What in a map names its file rather than the code it maps: set aside, as the comments are. */
const MAP_NAMING_KEYS: ReadonlySet<string> = new Set(['debug_id', 'debugId', 'file']);
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
      .update(maps.carried ? await comparedMap(source, chunk, maps.kept) : '')
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
 * The map a chunk is composed through, as it is compared with another chunk's (`sameChunks`), found
 * as `sourceMapsPlugin` finds it: the one the build's hook left the chunk where it saw it (`kept`),
 * and otherwise the one the chunk's last comment names — inside it, as a data URL, or beside it.
 * Nothing where there is none, or none to read, which another chunk's map is not the same as.
 */
async function comparedMap(
  source: string,
  chunk: string,
  kept: KeptMaps | undefined,
): Promise<string> {
  const left = kept?.mapFor(chunk);
  if (left?.seen === true) {
    return left.file === undefined ? '' : await mapFileKey(left.file);
  }
  const inline = inlineMapOf(source);
  if (inline !== undefined) {
    return canonicalMap(inline, path.dirname(chunk), chunk);
  }
  const file = mapFileOf(source, chunk);
  return file === undefined ? '' : await mapFileKey(file);
}

/**
 * The map a chunk carries inside its last comment, decoded; nothing where its last comment names a
 * file instead, or it has none. Found by the comment's last occurrence anywhere in the chunk, since
 * a map inside one is as long as the chunk is, or longer.
 */
function inlineMapOf(source: string): string | undefined {
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
  if (!url.startsWith(DATA_URL_PREFIX) || rest.slice(url.length).trim() !== '') {
    return undefined;
  }
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

/** A map beside a chunk as it is compared (`canonicalMap`), or nothing where it cannot be read. */
async function mapFileKey(file: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return '';
  }
  return canonicalMap(text, path.dirname(file), file);
}

/**
 * A map as it is compared: flattened as Rolldown is handed it (`flattened`), without what names its
 * file (`MAP_NAMING_KEYS`), and with each source the file it names (`resolvedSource`) — a source is
 * relative to where its map is, and two maps that write one path from two directories name two
 * files. As written where it is no map at all.
 */
function canonicalMap(text: string, base: string, file: string): string {
  let map: unknown;
  try {
    map = JSON.parse(flattened(text, file));
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
        typeof source === 'string' ? resolvedSource(source, root, base) : source,
      )
    : fields['sources'];
  return JSON.stringify({
    ...Object.fromEntries(
      Object.entries(fields).filter(([key]) => !MAP_NAMING_KEYS.has(key) && key !== 'sourceRoot'),
    ),
    sources,
  });
}
