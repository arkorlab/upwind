import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isUnder } from './fs.ts';
import { mapFileOf } from './source-maps.ts';

/**
 * The maps a build wrote, kept through what runs between its compile and this adapter.
 *
 * Next.js calls `compiler.runAfterProductionCompile` once the compile is done and before
 * `onBuildComplete`, and that is where the plugins of error-reporting services upload a build's
 * maps and then take them out of it:
 *
 * - `@sentry/nextjs` deletes every map under `static/`, and strips the `sourceMappingURL` comment
 *   from every chunk there — the one thing that says which map a chunk has;
 * - `@posthog/nextjs-config` stamps an id into every chunk of the build directory, in front of its
 *   code, rewrites each map to match, and by default deletes them all, the server's included.
 *
 * Each is right for what it does: a map that is served is the application's source published. And
 * each leaves this adapter, which carries the maps without serving them, nothing to carry.
 *
 * So the hook is wrapped. Before it runs, every map a chunk names is linked into a directory of
 * this adapter's own under the build directory (copied where the filesystem will not link), with
 * which chunk named it and what that chunk's code was. After it runs, every chunk it saw is given a
 * verdict, written down in an index the rest of the build reads instead of the chunk's comment:
 *
 * - the chunk's code is as it was (a comment at its end may have gone, which moves nothing): the
 *   kept map, which describes that code whatever happened to the file beside it;
 * - the chunk changed and its map was rewritten with it, in place — which the link sees, being the
 *   same file: the kept map, as rewritten;
 * - the chunk changed and the map beside it was replaced by another file: that file;
 * - the chunk changed and nothing rewrote its map: **no map**, even where the old one is still
 *   beside it. A frame read as built is honest, and one read against the wrong map is not.
 *
 * Nothing here can fail a build, and no chunk takes another down with it: a chunk whose map could
 * not be kept or judged is a chunk whose frames read as built.
 */

/** The directory, under the build's own: Next.js empties that before every build. */
const KEPT_DIR = 'upwind-kept-maps';
const INDEX_FILE = 'index.json';
/** Where a chunk with a map of its own can be: the browser's chunks, and the server's. */
const CHUNK_ROOTS = ['static', 'server'] as const;
const CHUNK_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
/**
 * A comment a tool writes at the end of a chunk — `sourceMappingURL`, `debugId`, a service's own
 * id — which tells a reader about the code and changes nothing about where in it anything is.
 */
const TRAILING_DIRECTIVE = /^\/\/[#@] ?[\w.-]+=/u;
/** How much of a line is read to tell whether it is one; the name comes first and is short. */
const DIRECTIVE_PREFIX = 256;
/** How much of a chunk's end `mapFileOf` reads for its comment. */
const TAIL_BYTES = 1024;
const TAB = 0x09;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const BLANK = 0x20;
/** The bytes taken for space between the code and the comments after it. */
const SPACE = new Set([BLANK, CARRIAGE_RETURN, NEWLINE, TAB]);
/**
 * How many chunks are read and linked at once. A build's chunks are hundreds of small files, where
 * each read is mostly waiting on the filesystem, and several in flight wait together.
 */
const CONCURRENCY = 16;

/** What `runAfterProductionCompile` is, as Next.js declares it. */
export type AfterProductionCompile = (metadata: {
  projectDir: string;
  distDir: string;
}) => Promise<void>;

/** What the hook left one chunk. */
export interface KeptMap {
  /**
   * Whether the hook saw the chunk, so that `file` is the word on its map. A chunk it did not see —
   * which named no map before it ran, or has been written since — is read by its own comment.
   */
  readonly seen: boolean;
  /** The map that describes the chunk now, where the hook saw it; nothing where none does. */
  readonly file: string | undefined;
  /**
   * Where the build wrote that map, which is what the files it names are relative to: `file` itself,
   * or — where `file` is the link or copy kept of it here — the build's own path for it.
   */
  readonly origin: string | undefined;
}

/** What the hook left the chunks it saw, for the parts of the build that read a chunk's map. */
export interface KeptMaps {
  mapFor(chunk: string): KeptMap;
}

const UNSEEN: KeptMap = { seen: false, file: undefined, origin: undefined };
const NO_MAP: KeptMap = { seen: true, file: undefined, origin: undefined };

/** A file's size and when it was last written: what tells a file written since from one not. */
interface Written {
  readonly size: number;
  readonly mtimeMs: number;
}

interface Recorded {
  /** The chunk, relative to `distDir`. */
  readonly chunk: string;
  /** The map it named, relative to `distDir` — and to the kept directory, where it was linked. */
  readonly map: string;
  /** A digest of the chunk's code, without the directives at its end. */
  readonly code: string;
  /** Whether the kept map is the build's own file under a second name, or a copy of it. */
  readonly linked: boolean;
  readonly chunkWritten: Written;
  /** The map as the hook found it, at its own path. */
  readonly mapWritten: Written;
}

/** A verdict as the index holds it: the map to read, relative to `distDir`, or none. */
interface IndexEntry extends Written {
  readonly map: string | null;
}

/** Hooks this module returned, so one handed back to it is not wrapped a second time. */
const wrappedHooks = new WeakSet<AfterProductionCompile>();

/**
 * A digest of a chunk's code, without the directives at its end or the space around them.
 *
 * Over the bytes, so that the hundreds of megabytes of a large build's server chunks are hashed as
 * they were read rather than decoded first; the directives are ASCII, and found from the end.
 */
function codeDigest(bytes: Buffer): string {
  let end = bytes.length;
  for (;;) {
    while (end > 0 && SPACE.has(bytes[end - 1] ?? 0)) {
      end -= 1;
    }
    const start = end === 0 ? 0 : bytes.lastIndexOf(NEWLINE, end - 1) + 1;
    const line = bytes.toString('latin1', start, Math.min(end, start + DIRECTIVE_PREFIX));
    if (end === 0 || !TRAILING_DIRECTIVE.test(line)) {
      return createHash('sha256').update(bytes.subarray(0, end)).digest('hex');
    }
    end = start;
  }
}

async function written(file: string): Promise<Written> {
  const { size, mtimeMs } = await stat(file);
  return { size, mtimeMs };
}

/** `written`, or nothing for a file that is not there. */
async function writtenIfThere(file: string): Promise<Written | undefined> {
  try {
    return await written(file);
  } catch {
    return undefined;
  }
}

function sameWrite(a: Written, b: Written): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Every chunk under the directories a chunk with a map can be in. */
async function chunksIn(distDir: string): Promise<string[]> {
  const chunks: string[] = [];
  for (const root of CHUNK_ROOTS) {
    let entries;
    try {
      entries = await readdir(path.join(distDir, root), { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && CHUNK_EXTENSIONS.has(path.extname(entry.name))) {
        chunks.push(path.join(entry.parentPath, entry.name));
      }
    }
  }
  return chunks;
}

/** `work` over every item, at most `limit` of them in flight at once. */
async function eachAtMost<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const lane = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, lane));
}

/** `to` as a second name for `from`, or a copy where a link cannot be made; `undefined` if neither. */
async function linkOrCopy(from: string, to: string): Promise<boolean | undefined> {
  try {
    await link(from, to);
    return true;
  } catch {
    try {
      await copyFile(from, to);
      return false;
    } catch {
      return undefined;
    }
  }
}

/** One chunk as it was before the hook, with its map linked aside; nothing for one without. */
async function recordChunk(
  distDir: string,
  chunk: string,
  linkOnce: (map: string) => Promise<boolean | undefined>,
): Promise<Recorded | undefined> {
  const bytes = await readFile(chunk);
  const mapFile = mapFileOf(bytes.toString('utf8', Math.max(0, bytes.length - TAIL_BYTES)), chunk);
  if (mapFile === undefined || !isUnder(distDir, mapFile)) {
    return undefined;
  }
  const map = path.relative(distDir, mapFile);
  const linked = await linkOnce(map);
  if (linked === undefined) {
    return undefined;
  }
  return {
    chunk: path.relative(distDir, chunk),
    map,
    code: codeDigest(bytes),
    linked,
    chunkWritten: await written(chunk),
    mapWritten: await written(path.join(distDir, map)),
  };
}

/** Link every map a chunk names into the kept directory, and note what each chunk was. */
async function recordMaps(distDir: string, keptDir: string): Promise<Recorded[]> {
  // What a previous build left, for a project that keeps its build directory between builds.
  await rm(keptDir, { recursive: true, force: true });
  const recorded: Recorded[] = [];
  /**
   * The link of each map, by where it is: taken before anything is awaited, so two chunks naming
   * one map — read at once — share one link rather than racing to make it.
   */
  const taken = new Map<string, Promise<boolean | undefined>>();
  const linkOnce = (map: string): Promise<boolean | undefined> => {
    const known = taken.get(map);
    if (known !== undefined) {
      return known;
    }
    const keptFile = path.join(keptDir, map);
    const linking = (async () => {
      await mkdir(path.dirname(keptFile), { recursive: true });
      return linkOrCopy(path.join(distDir, map), keptFile);
    })();
    taken.set(map, linking);
    return linking;
  };
  await eachAtMost(await chunksIn(distDir), CONCURRENCY, async (chunk) => {
    try {
      const entry = await recordChunk(distDir, chunk, linkOnce);
      if (entry !== undefined) {
        recorded.push(entry);
      }
    } catch {
      // A chunk that cannot be read, or names its map in a way that is not a path, is one the
      // hook is not watched for; the others still are.
    }
  });
  return recorded;
}

/** Whether a chunk's code is what it was before the hook, a comment at its end aside. */
async function sameCode(distDir: string, entry: Recorded, now: Written): Promise<boolean> {
  // A chunk nobody wrote to is the chunk it was, and is not read again — most of a build's.
  if (sameWrite(now, entry.chunkWritten)) {
    return true;
  }
  return codeDigest(await readFile(path.join(distDir, entry.chunk))) === entry.code;
}

/**
 * The map that describes a recorded chunk now, relative to `distDir`, or `null` for none.
 *
 * `shared` when another chunk names the same map: rewritten, it may have been rewritten for that
 * one, and describes neither for certain.
 */
async function verdict(
  distDir: string,
  keptDir: string,
  entry: Recorded,
  shared: boolean,
): Promise<string | null> {
  const now = await written(path.join(distDir, entry.chunk));
  const kept = path.relative(distDir, path.join(keptDir, entry.map));
  // A link is the build's own file, so a map written in place since shows through it; a copy is
  // the map as it was, whatever happened to the build's.
  const keptNow = entry.linked ? await writtenIfThere(path.join(keptDir, entry.map)) : undefined;
  const rewritten =
    entry.linked && (keptNow === undefined || !sameWrite(keptNow, entry.mapWritten));
  if (await sameCode(distDir, entry, now)) {
    return shared && rewritten ? null : kept;
  }
  if (shared) {
    return null;
  }
  if (rewritten) {
    return kept;
  }
  // Replaced rather than rewritten — a new file where the map was, which a link does not follow —
  // or rewritten where only a copy was kept.
  const liveNow = await writtenIfThere(path.join(distDir, entry.map));
  return liveNow !== undefined && !sameWrite(liveNow, entry.mapWritten) ? entry.map : null;
}

/** Posix separators in the index, so it reads the same wherever it was written. */
function indexKey(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * Write down what the hook left each recorded chunk: by chunk, relative to the build directory, each
 * with the chunk as it was when the hook was done. A chunk written since — by a later build into a
 * build directory that is not emptied between them (`cleanDistDir: false`), say — is not the chunk
 * the verdict was about, and `readKeptMaps` leaves it to its own comment.
 *
 * A map two chunks name is kept for them only where neither chunk nor map has changed: rewritten
 * for one of them, it no longer says which code it describes.
 */
async function settleMaps(
  distDir: string,
  keptDir: string,
  recorded: readonly Recorded[],
): Promise<void> {
  const sharers = new Map<string, number>();
  for (const entry of recorded) {
    sharers.set(entry.map, (sharers.get(entry.map) ?? 0) + 1);
  }
  const maps: Record<string, IndexEntry> = {};
  await eachAtMost(recorded, CONCURRENCY, async (entry) => {
    try {
      const map = await verdict(distDir, keptDir, entry, (sharers.get(entry.map) ?? 0) > 1);
      // The chunk as the verdict saw it, asked again after: what `readKeptMaps` checks it against.
      const now = await written(path.join(distDir, entry.chunk));
      maps[indexKey(entry.chunk)] = { map: map === null ? null : indexKey(map), ...now };
    } catch {
      // A chunk that cannot be judged is left out, and reads its own comment: what it would have
      // been given had the hook not been watched at all.
    }
  });
  await mkdir(keptDir, { recursive: true });
  await writeFile(path.join(keptDir, INDEX_FILE), JSON.stringify({ maps }));
}

function warn(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `@stayingupwind/adapter: the build's source maps could not be kept through runAfterProductionCompile (${reason}); a chunk whose map that hook removes is read as built`,
  );
}

/**
 * The project's `runAfterProductionCompile`, with the build's maps kept through it; `undefined` when
 * there is nothing to wrap — no hook, which leaves the maps where Next.js wrote them, or one this
 * already wrapped.
 *
 * The hook's own failure is the build's, as it was: it is awaited as it would have been, and what
 * it throws reaches Next.js unchanged.
 */
export function keepMapsThrough(hook: unknown): AfterProductionCompile | undefined {
  if (typeof hook !== 'function' || wrappedHooks.has(hook as AfterProductionCompile)) {
    return undefined;
  }
  const run = hook as AfterProductionCompile;
  const wrapped: AfterProductionCompile = async (metadata) => {
    const keptDir = path.join(metadata.distDir, KEPT_DIR);
    let recorded: Recorded[] | undefined;
    try {
      recorded = await recordMaps(metadata.distDir, keptDir);
    } catch (error) {
      warn(error);
    }
    await run(metadata);
    if (recorded !== undefined) {
      try {
        await settleMaps(metadata.distDir, keptDir, recorded);
      } catch (error) {
        warn(error);
      }
    }
  };
  wrappedHooks.add(wrapped);
  return wrapped;
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    (typeof entry['map'] === 'string' || entry['map'] === null) &&
    typeof entry['size'] === 'number' &&
    typeof entry['mtimeMs'] === 'number'
  );
}

/** Whether `chunk` is as it was when its verdict was written. Synchronous: asked as a bundler loads. */
function stillWritten(chunk: string, entry: Written): boolean {
  try {
    const { size, mtimeMs } = statSync(chunk);
    return sameWrite({ size, mtimeMs }, entry);
  } catch {
    return false;
  }
}

/**
 * What the hook left this build's chunks, or `undefined` when there is no word of it: no hook ran,
 * or the index could not be written.
 */
export async function readKeptMaps(distDir: string): Promise<KeptMaps | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(distDir, KEPT_DIR, INDEX_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  const maps =
    typeof parsed === 'object' && parsed !== null ? (parsed as { maps?: unknown }).maps : undefined;
  if (typeof maps !== 'object' || maps === null) {
    return undefined;
  }
  const table = new Map<string, IndexEntry>();
  for (const [chunk, entry] of Object.entries(maps as Record<string, unknown>)) {
    if (isIndexEntry(entry)) {
      table.set(chunk, entry);
    }
  }
  const keptDir = path.join(distDir, KEPT_DIR);
  return {
    mapFor(chunk) {
      const entry = table.get(indexKey(path.relative(distDir, chunk)));
      if (entry === undefined || !stillWritten(chunk, entry)) {
        return UNSEEN;
      }
      const file = entry.map === null ? undefined : path.join(distDir, entry.map);
      if (file === undefined || !isUnder(distDir, file)) {
        return NO_MAP;
      }
      // A map kept here is at the build's own path for it, under the kept directory (`recordMaps`).
      const origin = isUnder(keptDir, file)
        ? path.join(distDir, path.relative(keptDir, file))
        : file;
      return { seen: true, file, origin };
    },
  };
}
