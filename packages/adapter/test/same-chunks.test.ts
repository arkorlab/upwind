import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sameChunks } from '../src/same-chunks.ts';

const CODE = 'module.exports=[1,()=>42];\n';
const PACKAGE_SOURCE = '../../../node_modules/next/dist/server/example.js';
const PROJECT_SOURCE = '../../../src/page.ts';

describe('identical chunks with project-only source maps', () => {
  let directory: string;
  let distDir: string;
  let chunks: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upwind-project-chunks-'));
    distDir = path.join(directory, '.next');
    chunks = path.join(distDir, 'server', 'chunks');
    await mkdir(chunks, { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function written(name: string, source: string, mappings: string): Promise<string> {
    const file = path.join(chunks, `${name}.js`);
    await writeFile(file, `${CODE}//# sourceMappingURL=${name}.js.map`);
    await writeFile(
      `${file}.map`,
      JSON.stringify({ version: 3, sources: [source], names: [], mappings }),
    );
    return file;
  }

  function projectMaps() {
    return {
      carried: true,
      project: { projectDir: directory, distDir, outDir: path.join(directory, '.out') },
    };
  }

  it('merges package-only twins whose dropped mappings leave different unmapped boundaries', async () => {
    const a = await written('a', PACKAGE_SOURCE, 'AAAA;AACA');
    const b = await written('b', PACKAGE_SOURCE, 'KAAA;;EACA');

    await expect(sameChunks([a, b], projectMaps())).resolves.toStrictEqual(new Map([[b, a]]));
  });

  it('keeps the same package mappings distinct when the whole maps are carried', async () => {
    const a = await written('a', PACKAGE_SOURCE, 'AAAA;AACA');
    const b = await written('b', PACKAGE_SOURCE, 'KAAA;;EACA');

    await expect(sameChunks([a, b], { carried: true })).resolves.toStrictEqual(new Map());
  });

  it('preserves different frames in retained project sources', async () => {
    const a = await written('a', PROJECT_SOURCE, 'AAAA');
    const b = await written('b', PROJECT_SOURCE, 'AACA');

    await expect(sameChunks([a, b], projectMaps())).resolves.toStrictEqual(new Map());
  });

  it('keeps a map with project frames apart from one with none', async () => {
    const a = await written('a', PACKAGE_SOURCE, 'AAAA');
    const b = await written('b', PROJECT_SOURCE, 'AAAA');

    await expect(sameChunks([a, b], projectMaps())).resolves.toStrictEqual(new Map());
  });
});
