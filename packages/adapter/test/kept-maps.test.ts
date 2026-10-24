import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AfterProductionCompile, keepMapsThrough, readKeptMaps } from '../src/kept-maps.ts';

/**
 * The build's maps kept through `runAfterProductionCompile`, against hooks that do to a build
 * what the plugins of error-reporting services do: delete the browser maps and the comments that
 * name them (`@sentry/nextjs`), or stamp every chunk in front of its code, rewrite its map in
 * place to match, and delete the lot (`@posthog/nextjs-config`) — and against hooks that leave a
 * map that no longer describes its chunk.
 */

const CLIENT = path.join('static', 'chunks', 'page.js');
const SERVER = path.join('server', 'chunks', 'ssr', 'route.js');
const SNIPPET = '!function(){globalThis.__stamp=1}();';

function mapFor(name: string): string {
  return JSON.stringify({ version: 3, sources: [`src/${name}.ts`], names: [], mappings: 'AAAA' });
}

/** A chunk that names `map` beside it, and that map. */
async function writeChunk(distDir: string, chunk: string, map: string): Promise<void> {
  await mkdir(path.dirname(path.join(distDir, chunk)), { recursive: true });
  await writeFile(
    path.join(distDir, chunk),
    `console.log(${JSON.stringify(chunk)});\n//# sourceMappingURL=${path.basename(map)}\n`,
  );
  await writeFile(path.join(distDir, path.dirname(chunk), path.basename(map)), mapFor(chunk));
}

async function stamp(file: string): Promise<void> {
  await writeFile(file, `${SNIPPET}\n${await readFile(file, 'utf8')}`);
}

describe('keepMapsThrough', () => {
  let distDir: string;

  beforeEach(async () => {
    distDir = await mkdtemp(path.join(tmpdir(), 'adapter-kept-maps-'));
    for (const chunk of [CLIENT, SERVER]) {
      await writeChunk(distDir, chunk, `${path.basename(chunk)}.map`);
    }
  });

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true });
  });

  async function run(hook: AfterProductionCompile): Promise<void> {
    const wrapped = keepMapsThrough(hook);
    await wrapped?.({ projectDir: path.dirname(distDir), distDir });
  }

  /** The map the build will read for `chunk`: its text, `false` for none, `undefined` for no word. */
  async function verdict(chunk: string): Promise<string | false | undefined> {
    const left = (await readKeptMaps(distDir))?.mapFor(path.join(distDir, chunk));
    if (left?.seen !== true) {
      return undefined;
    }
    return left.file !== undefined && readFile(left.file, 'utf8');
  }

  it('keeps the maps a hook deletes along with the comments that named them', async () => {
    await run(async () => {
      const file = path.join(distDir, CLIENT);
      const code = await readFile(file, 'utf8');
      await writeFile(file, code.slice(0, code.lastIndexOf('//# sourceMappingURL=')));
      await rm(`${file}.map`);
    });

    await expect(verdict(CLIENT)).resolves.toBe(mapFor(CLIENT));
    // A map the hook left alone is still where Next.js wrote it, and kept all the same.
    await expect(verdict(SERVER)).resolves.toBe(mapFor(SERVER));
  });

  it('keeps the map a hook rewrote in place with its chunk, as rewritten', async () => {
    const rewritten = JSON.stringify({ ...JSON.parse(mapFor(SERVER)), mappings: ';AAAA' });
    await run(async () => {
      const file = path.join(distDir, SERVER);
      await stamp(file);
      await writeFile(`${file}.map`, rewritten);
      await rm(`${file}.map`);
    });

    await expect(verdict(SERVER)).resolves.toBe(rewritten);
  });

  it('gives no map to a chunk that changed under a map nobody rewrote, left beside it or not', async () => {
    await run(async () => {
      await stamp(path.join(distDir, CLIENT));
      await rm(path.join(distDir, `${CLIENT}.map`));
      // Left where it was, comment and all: the map the chunk still names is the stale one.
      await stamp(path.join(distDir, SERVER));
    });

    await expect(verdict(CLIENT)).resolves.toBe(false);
    await expect(verdict(SERVER)).resolves.toBe(false);
  });

  /**
   * A map replaced by another file rather than written in place. The link still names the old one;
   * the file where the map was is the new one — and gone, where the hook went on to delete it.
   */
  it('follows a map a hook replaced with a new file for a chunk it changed', async () => {
    const replacement = mapFor('replaced');
    await run(async () => {
      for (const chunk of [CLIENT, SERVER]) {
        const file = path.join(distDir, chunk);
        await stamp(file);
        await writeFile(`${file}.map.tmp`, replacement);
        await rename(`${file}.map.tmp`, `${file}.map`);
      }
      await rm(path.join(distDir, `${SERVER}.map`));
    });

    await expect(verdict(CLIENT)).resolves.toBe(replacement);
    await expect(verdict(SERVER)).resolves.toBe(false);
  });

  /** A map names its sources from where the build wrote it, wherever it is read from. */
  it('names where the build wrote each map, kept or replaced', async () => {
    await run(async () => {
      const file = path.join(distDir, SERVER);
      await stamp(file);
      await writeFile(`${file}.map.tmp`, mapFor('replaced'));
      await rename(`${file}.map.tmp`, `${file}.map`);
    });
    const kept = await readKeptMaps(distDir);
    const client = kept?.mapFor(path.join(distDir, CLIENT));
    const server = kept?.mapFor(path.join(distDir, SERVER));

    // Kept: read from the adapter's own directory, and written beside the chunk.
    expect(client?.file).not.toBe(path.join(distDir, `${CLIENT}.map`));
    expect(client?.origin).toBe(path.join(distDir, `${CLIENT}.map`));
    // Replaced: read where the hook left it, which is where it was written.
    expect(server?.file).toBe(path.join(distDir, `${SERVER}.map`));
    expect(server?.origin).toBe(server?.file);
  });

  /**
   * One map, two chunks naming it. Rewritten for the one that changed, it no longer describes the
   * other — and which of them it was rewritten for is not something a file's write time says.
   */
  it('gives no map to the chunks of a shared map once any of them changed', async () => {
    const other = path.join('static', 'chunks', 'other.js');
    await writeChunk(distDir, other, 'page.js.map');
    await run(async () => {
      const file = path.join(distDir, CLIENT);
      await stamp(file);
      await writeFile(`${file}.map`, mapFor('rewritten for page.js'));
    });

    await expect(verdict(CLIENT)).resolves.toBe(false);
    await expect(verdict(other)).resolves.toBe(false);
  });

  it('keeps the other maps when one chunk names its map in a way that is not a path', async () => {
    const broken = path.join('static', 'chunks', 'broken.js');
    await writeFile(
      path.join(distDir, broken),
      'console.log(1);\n//# sourceMappingURL=%E0%A4%A.map\n',
    );
    await run(async () => {
      await rm(path.join(distDir, `${CLIENT}.map`));
    });

    await expect(verdict(CLIENT)).resolves.toBe(mapFor(CLIENT));
    await expect(verdict(broken)).resolves.toBeUndefined();
  });

  /**
   * What a build directory that is not emptied between builds (`cleanDistDir: false`) holds: an
   * index written by an earlier build, beside a chunk a later one wrote.
   */
  it('has no word on a chunk written since its verdict', async () => {
    await run(async () => {
      await rm(path.join(distDir, `${CLIENT}.map`));
    });
    await writeFile(path.join(distDir, CLIENT), 'console.log("written by a later build");\n');

    await expect(verdict(CLIENT)).resolves.toBeUndefined();
  });

  it('lets the hook’s own failure fail the build, as it would have', async () => {
    const failure = new Error('upload refused');
    const wrapped = keepMapsThrough(() => Promise.reject(failure));

    await expect(wrapped?.({ projectDir: path.dirname(distDir), distDir })).rejects.toBe(failure);
  });

  it('wraps a hook once, and does not invent one where the project has none', () => {
    const wrapped = keepMapsThrough(() => Promise.resolve());

    expect(wrapped).toBeTypeOf('function');
    expect(keepMapsThrough(wrapped)).toBeUndefined();
    expect(keepMapsThrough(undefined)).toBeUndefined();
  });
});
