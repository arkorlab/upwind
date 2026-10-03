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
 * which chunk named it and what that chunk's code was. After it runs, a map is kept only where it
 * still describes its chunk as the build will ship it:
 *
 * - the chunk's code is as it was (a comment at its end may have gone, which moves nothing), or
 * - the chunk changed and its map was rewritten with it — which the link sees, being the same file:
 *   a tool that writes a file in place writes the one the link names.
 *
 * A chunk that changed under a map nobody rewrote is one whose map would place every frame
 * somewhere else, and it is left with none: a frame read as built is honest, and one read against
 * the wrong map is not. The same goes for a tool that replaces a map with a new file rather than
 * writing the one there — the link keeps the old one, which cannot be told from a map left behind.
 *
 * Nothing here can fail a build. A map that could not be kept is a frame read as built.
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

/** The maps that came through, for the parts of the build that read a chunk's map. */
export interface KeptMaps {
  /** The kept map of the chunk at `chunk`, or `undefined` when none was kept for it. */
  mapFor(chunk: string): string | undefined;
}

/** A file's size and when it was last written: what tells a file written since from one not. */
interface Written {
  readonly size: number;
  readonly mtimeMs: number;
}

interface Recorded {
  /** The chunk, relative to `distDir`. */
  readonly chunk: string;
  /** Its map, relative to the kept directory — where it is relative to `distDir`. */
  readonly kept: string;
  /** A digest of the chunk's code, without the directives at its end. */
  readonly code: string;
  /** Whether the kept map is the build's own file under a second name, or a copy of it. */
  readonly linked: boolean;
  readonly chunkWritten: Written;
  readonly mapWritten: Written;
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

/** Link every map a chunk names into the kept directory, and note what each chunk was. */
async function recordMaps(distDir: string, keptDir: string): Promise<Recorded[]> {
  // What a previous build left, for a project that keeps its build directory between builds.
  await rm(keptDir, { recursive: true, force: true });
  const recorded: Recorded[] = [];
  /**
   * The link of each map, by where it is kept: taken before anything is awaited, so two chunks
   * naming one map — read at once — share one link rather than racing to make it.
   */
  const taken = new Map<string, Promise<boolean | undefined>>();
  const linkOnce = (
    mapFile: string,
    keptFile: string,
    kept: string,
  ): Promise<boolean | undefined> => {
    const known = taken.get(kept);
    if (known !== undefined) {
      return known;
    }
    const linking = (async () => {
      await mkdir(path.dirname(keptFile), { recursive: true });
      return linkOrCopy(mapFile, keptFile);
    })();
    taken.set(kept, linking);
    return linking;
  };
  await eachAtMost(await chunksIn(distDir), CONCURRENCY, async (chunk) => {
    const bytes = await readFile(chunk);
    const tail = bytes.toString('utf8', Math.max(0, bytes.length - TAIL_BYTES));
    const mapFile = mapFileOf(tail, chunk);
    if (mapFile === undefined || !isUnder(distDir, mapFile)) {
      return;
    }
    const kept = path.relative(distDir, mapFile);
    const keptFile = path.join(keptDir, kept);
    const linked = await linkOnce(mapFile, keptFile, kept);
    if (linked === undefined) {
      return;
    }
    recorded.push({
      chunk: path.relative(distDir, chunk),
      kept,
      code: codeDigest(bytes),
      linked,
      chunkWritten: await written(chunk),
      mapWritten: await written(keptFile),
    });
  });
  return recorded;
}

/**
 * Whether a recorded map still describes its chunk as the build now holds it; if it does, the chunk
 * as it is now, for the index to hold the map to.
 */
async function stillDescribes(
  distDir: string,
  keptDir: string,
  entry: Recorded,
): Promise<Written | undefined> {
  const chunk = path.join(distDir, entry.chunk);
  let now: Written;
  let bytes: Buffer;
  try {
    now = await written(chunk);
    // A chunk nobody wrote to is the chunk it was, and is not read again — most of a build's.
    if (sameWrite(now, entry.chunkWritten)) {
      return now;
    }
    bytes = await readFile(chunk);
  } catch {
    return undefined;
  }
  if (codeDigest(bytes) === entry.code) {
    return now;
  }
  const rewritten =
    entry.linked && !sameWrite(await written(path.join(keptDir, entry.kept)), entry.mapWritten);
  return rewritten ? now : undefined;
}

/** Posix separators in the index, so it reads the same wherever it was written. */
function indexKey(relative: string): string {
  return relative.split(path.sep).join('/');
}

/** A map that came through, as the index holds it: where it is kept, and the chunk it is for. */
interface IndexEntry extends Written {
  readonly map: string;
}

/**
 * Write down the maps that came through: by chunk, relative to the build directory, each with the
 * chunk as it was when the hook was done. A chunk written since — by a later build into a build
 * directory that is not emptied between them (`cleanDistDir: false`), say — is not the chunk the
 * map was kept for, and `readKeptMaps` gives it none.
 */
async function settleMaps(
  distDir: string,
  keptDir: string,
  recorded: readonly Recorded[],
): Promise<void> {
  const maps: Record<string, IndexEntry> = {};
  await eachAtMost(recorded, CONCURRENCY, async (entry) => {
    const now = await stillDescribes(distDir, keptDir, entry);
    if (now !== undefined) {
      maps[indexKey(entry.chunk)] = { map: indexKey(entry.kept), ...now };
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

/**
 * The maps kept for this build, or `undefined` when none were: no hook ran, or the index could not
 * be written. A chunk the index does not name has no map of its own to fall back to.
 */
export async function readKeptMaps(distDir: string): Promise<KeptMaps | undefined> {
  const keptDir = path.join(distDir, KEPT_DIR);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(keptDir, INDEX_FILE), 'utf8'));
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
  return {
    mapFor(chunk): string | undefined {
      const entry = table.get(indexKey(path.relative(distDir, chunk)));
      if (entry === undefined || !stillWritten(chunk, entry)) {
        return undefined;
      }
      const file = path.join(keptDir, entry.map);
      return isUnder(keptDir, file) ? file : undefined;
    },
  };
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['map'] === 'string' &&
    typeof entry['size'] === 'number' &&
    typeof entry['mtimeMs'] === 'number'
  );
}

/** Whether `chunk` is as it was when its map was kept. Synchronous, being asked as a bundler loads. */
function stillWritten(chunk: string, entry: Written): boolean {
  try {
    const { size, mtimeMs } = statSync(chunk);
    return sameWrite({ size, mtimeMs }, entry);
  } catch {
    return false;
  }
}
