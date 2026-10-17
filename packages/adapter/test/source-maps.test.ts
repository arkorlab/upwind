import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BlobRef } from '@stayingupwind/core/bundle';
import {
  MAX_SOURCE_CONTENT_BYTES,
  parseSourceArchiveIndex,
  SOURCE_ARCHIVE_PREFIX_BYTES,
  sourceArchiveIndexLength,
} from '@stayingupwind/core/source-archive';
import { rolldown } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import { projectOnly } from '../src/project-maps.ts';
import {
  functionSourceMaps,
  linkClientMaps,
  sourceMapsPlugin,
  sourcemapOutput,
  storeSourceMap,
} from '../src/source-maps.ts';

/** Read an archive's sources by the byte ranges a host would request independently. */
async function contentsOf(dir: string, ref: BlobRef | undefined): Promise<(string | null)[]> {
  if (ref === undefined) throw new Error('no source artifact');
  const bytes = await readFile(path.join(dir, 'blobs', ref.sha256));
  const indexLength = sourceArchiveIndexLength(bytes.subarray(0, SOURCE_ARCHIVE_PREFIX_BYTES));
  if (indexLength === undefined) throw new Error('no source index');
  const payloadStart = SOURCE_ARCHIVE_PREFIX_BYTES + indexLength;
  const rawIndex = bytes.subarray(SOURCE_ARCHIVE_PREFIX_BYTES, payloadStart);
  const count = (JSON.parse(rawIndex.toString('utf8')) as unknown[]).length;
  const index = parseSourceArchiveIndex(rawIndex, count, bytes.byteLength - payloadStart);
  if (index === undefined) throw new Error('invalid source index');
  return index.map((range) => {
    return range === null
      ? null
      : bytes
          .subarray(payloadStart + range[0], payloadStart + range[0] + range[1])
          .toString('utf8');
  });
}

describe('the sources kept beside a compact map', () => {
  let dir: string;
  let blobs: BlobStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'upwind-source-maps-'));
    blobs = new BlobStore(dir);
    await blobs.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves filtered source contents in the reindexed mapping order', () => {
    const text = JSON.stringify({
      version: 3,
      sources: ['../../src/first.ts', '../../node_modules/pkg/index.js', '../../src/last.ts'],
      sourcesContent: ['first source', 'package source', 'last source'],
      names: [],
      mappings: 'AEAA,KDAA,KDAA',
    });
    const filtered = JSON.parse(
      projectOnly(
        text,
        path.join(dir, 'out/work/app.cjs.map'),
        {
          projectDir: dir,
          distDir: path.join(dir, '.next'),
          outDir: path.join(dir, 'out'),
        },
        true,
      ),
    ) as { sources: string[]; sourcesContent: string[] };

    expect(filtered.sources).toStrictEqual(['../../src/last.ts', '../../src/first.ts']);
    expect(filtered.sourcesContent).toStrictEqual(['last source', 'first source']);
  });

  it('extracts a flattened browser index map without keeping source text in its map', async () => {
    const file = path.join(dir, 'chunk.js');
    const mapFile = `${file}.map`;
    await writeFile(file, 'throw new Error("broken");\n//# sourceMappingURL=chunk.js.map\n');
    await writeFile(
      mapFile,
      JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: {
              version: 3,
              sources: ['src/page.tsx'],
              sourcesContent: ['throw new Error("日本語");'],
              names: [],
              mappings: 'AAAA',
            },
          },
        ],
      }),
    );

    const [ref] = await linkClientMaps(
      [{ pathname: '/_next/static/chunks/chunk.js', filePath: file }],
      new Map([['/_next/static/chunks/chunk.js.map', mapFile]]),
      blobs,
    );
    const compact = JSON.parse(
      await readFile(path.join(dir, 'blobs', ref?.blob.sha256 ?? ''), 'utf8'),
    ) as Record<string, unknown>;

    expect(compact['sourcesContent']).toBeUndefined();
    expect(compact['sections']).toBeUndefined();
    await expect(contentsOf(dir, ref?.sources)).resolves.toStrictEqual([
      'throw new Error("日本語");',
    ]);
  });

  it('keeps a Function source archive outside the module it describes', async () => {
    const file = path.join(dir, 'app.cjs');
    await writeFile(file, 'throw new Error("broken");');
    await writeFile(
      `${file}.map`,
      JSON.stringify({
        version: 3,
        sources: ['src/hello.ts'],
        sourcesContent: ['throw new Error("original");'],
        names: [],
        mappings: 'AAAA',
      }),
    );

    const [ref] = await functionSourceMaps(blobs, 'app', { app: file, edge: undefined });
    const compact = JSON.parse(
      await readFile(path.join(dir, 'blobs', ref?.blob.sha256 ?? ''), 'utf8'),
    ) as Record<string, unknown>;

    expect(ref?.name).toBe('app/app.cjs');
    expect(compact['sourcesContent']).toBeUndefined();
    await expect(contentsOf(dir, ref?.sources)).resolves.toStrictEqual([
      'throw new Error("original");',
    ]);
    await expect(readFile(file, 'utf8')).resolves.toBe('throw new Error("broken");');
  });

  it('composes original contents through a chunk before extracting the Function archive', async () => {
    const entry = path.join(dir, 'entry.cjs');
    const chunk = path.join(dir, 'chunk.js');
    const original = 'export function hello() { return "日本語"; }';
    await writeFile(entry, 'module.exports = require("./chunk.js");');
    await writeFile(
      chunk,
      'module.exports = function hello() { return "日本語"; };\n//# sourceMappingURL=chunk.js.map\n',
    );
    await writeFile(
      `${chunk}.map`,
      JSON.stringify({
        version: 3,
        sources: ['src/hello.ts'],
        sourcesContent: [original],
        names: [],
        mappings: 'AAAA',
      }),
    );
    await using bundle = await rolldown({
      cwd: dir,
      input: entry,
      platform: 'node',
      plugins: [sourceMapsPlugin()],
    });
    const { output } = await bundle.generate({ format: 'cjs', ...sourcemapOutput(true) });
    const stored = await storeSourceMap(blobs, JSON.stringify(output[0].map), 'app.cjs.map');

    await expect(contentsOf(dir, stored.sources)).resolves.toContain(original);
  });

  it('retains a usable compact map when source contents are absent or too large', async () => {
    const stored = await storeSourceMap(
      blobs,
      JSON.stringify({
        version: 3,
        sources: ['src/large.ts', 'src/absent.ts'],
        sourcesContent: ['x'.repeat(MAX_SOURCE_CONTENT_BYTES + 1), null],
        names: [],
        mappings: 'AAAA',
      }),
      'app.cjs.map',
    );
    const compact = JSON.parse(
      await readFile(path.join(dir, 'blobs', stored.blob.sha256), 'utf8'),
    ) as Record<string, unknown>;

    expect(stored.sources).toBeUndefined();
    expect(compact['sources']).toStrictEqual(['src/large.ts', 'src/absent.ts']);
    expect(compact['mappings']).toBe('AAAA');
    expect(compact['sourcesContent']).toBeUndefined();
  });
});
