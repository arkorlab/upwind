import { readFile } from 'node:fs/promises';

import type { SourceMapRef } from '@stayingupwind/core/bundle';

import type { BuildFunctionInput } from './function.ts';
import type { NodeArchiveFile } from './node-archive.ts';
import type { NodePhysicalFiles } from './node-files.ts';
import { projectOnly } from './project-maps.ts';
import { carriesMaps, mapFileOf, storeSourceMap } from './source-maps.ts';

async function physicalSourceMap(
  input: BuildFunctionInput,
  file: NodeArchiveFile,
  original: string,
): Promise<SourceMapRef | undefined> {
  const saved = input.keptMaps?.mapFor(original);
  const map =
    saved?.seen === true ? saved.file : mapFileOf(new TextDecoder().decode(file.bytes), original);
  if (map === undefined) return undefined;
  try {
    const source = await readFile(map, 'utf8');
    const selected =
      input.sourceMaps === 'project'
        ? projectOnly(
            source,
            saved?.origin ?? map,
            {
              projectDir: input.projectDir,
              distDir: input.patch.distDir,
              outDir: input.outDir,
            },
            true,
          )
        : source;
    return {
      kind: 'function',
      name: `${input.name ?? input.kind}/${file.name}`,
      ...(await storeSourceMap(input.blobStore, selected, map)),
    };
  } catch {
    // A removed, stale or malformed map must not invent a source location.
    return undefined;
  }
}

/** Physical code retains its original map; rewritten protocol internals deliberately read as built. */
export async function nodeSourceMaps(
  input: BuildFunctionInput,
  physical: NodePhysicalFiles,
  rewritten: ReadonlyMap<string, NodeArchiveFile>,
): Promise<SourceMapRef[]> {
  if (!carriesMaps(input.sourceMaps)) return [];
  const maps: SourceMapRef[] = [];
  for (const file of physical.files) {
    if (!file.name.startsWith('project/') || !/\.[cm]?js$/u.test(file.name)) continue;
    const current = rewritten.get(file.name);
    if (current === undefined || Buffer.compare(file.bytes, current.bytes) !== 0) continue;
    const original = physical.sourcePaths.get(file.name);
    if (original === undefined) continue;
    const selected = await physicalSourceMap(input, file, original);
    if (selected !== undefined) maps.push(selected);
  }
  return maps;
}
