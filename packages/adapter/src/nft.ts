import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { exists } from './fs.ts';

const SERVER_CHUNKS_SEGMENT = `${path.sep}server${path.sep}chunks${path.sep}`;

/** Every file a `.nft.json` trace next to an entry names, resolved against the entry. */
async function nftFiles(entryFile: string): Promise<string[]> {
  const traceFile = `${entryFile}.nft.json`;
  if (!(await exists(traceFile))) {
    return [];
  }
  const trace = JSON.parse(await readFile(traceFile, 'utf8')) as { files?: string[] };
  const dir = path.dirname(entryFile);
  return (trace.files ?? []).map((file) => path.resolve(dir, file));
}

/** Chunks named by a `.nft.json` trace next to an entry that `onBuildComplete` does not describe. */
export async function nftChunks(entryFile: string): Promise<string[]> {
  return (await nftFiles(entryFile)).filter(
    (file) => file.endsWith('.js') && file.includes(SERVER_CHUNKS_SEGMENT),
  );
}

/**
 * Everything such an entry's trace names, keyed as an output's `assets` are: what it reads through
 * `node:fs` is among them, beside its code, for `tracedFiles` to tell apart.
 */
export async function nftAssets(
  entryFile: string,
  repoRoot: string,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await nftFiles(entryFile)).map((file) => {
      const logical = path.relative(repoRoot, file).split(path.sep).join('/');
      return [logical, file];
    }),
  );
}

/**
 * The WebAssembly such an entry reaches. The instrumentation hook is the one entry the adapter
 * finds this way rather than being handed, and its chunks go into both Functions — so a `.wasm` it
 * imports has to be collected the same way, or the loader those chunks carry is rewritten with a
 * table that does not name it (and, when the build has no other WebAssembly, is not rewritten at
 * all and fails the build instead).
 */
export async function nftWasm(entryFile: string): Promise<string[]> {
  return [...new Set((await nftFiles(entryFile)).filter((file) => file.endsWith('.wasm')))];
}
