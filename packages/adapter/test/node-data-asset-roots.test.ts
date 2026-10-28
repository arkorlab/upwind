import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import { WasmCollector } from '../src/wasm.ts';

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = {
    ...actual,
    readFile: vi.fn<() => Promise<never>>().mockRejectedValue(new Error('unowned file read')),
  };
  vi.spyOn(mocked, 'stat');
  return mocked;
});

const ENTRY = 'exports.value=42;';
const DATA = "module.exports=require('dev-only');";
const UNCLOSED = 'The first existing Node package target is outside its closed trace';
const directories: string[] = [];
const COPY_ROLES = ['file', 'trace'] as const;
type CopyRole = (typeof COPY_ROLES)[number];

async function fixture(role: CopyRole = 'file', entryCode = ENTRY) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-node-data-asset-'));
  const root = await realpath(temporary);
  directories.push(root);
  const entry = path.join(root, 'entry.js');
  const asset = path.join(root, 'data.js');
  const dependency = path.join(root, 'node_modules/dev-only.js');
  await mkdir(path.dirname(dependency), { recursive: true });
  // All source strings are authored filesystem data and are never loaded or evaluated.
  await writeFile(entry, entryCode);
  await writeFile(asset, DATA);
  await writeFile(dependency, 'exports.untraced=true;');
  const input: BuildFunctionInput = {
    kind: 'app',
    projectDir: root,
    repoRoot: root,
    outDir: path.join(root, 'output'),
    patch: {
      projectDir: root,
      distDir: path.join(root, '.next'),
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    },
    entries: [{ id: '/authored', filePath: entry }],
    entryTraces: role === 'trace' ? [{ id: '/authored', assets: { 'data.js': asset } }] : [],
    edgeEntries: [],
    wasm: new WasmCollector(),
    manifests: [],
    runtimeManifest: '{}',
    cacheHostModule: undefined,
    blobs: [],
    files: role === 'file' ? [{ name: 'data.js', filePath: asset }] : [],
    blobStore: new BlobStore(path.join(root, 'blobs')),
  };
  return { root, entry, asset, dependency, input, entryCode };
}

function reads(own: Awaited<ReturnType<typeof fixture>>, asset = true): void {
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(own.entryCode));
  if (asset) vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(DATA));
}

function missingMetadata(file: unknown): Promise<never> {
  // No package manifests are authored; only in-fixture metadata misses are expected.
  if (
    typeof file === 'string' &&
    path.basename(file) === 'package.json' &&
    directories.some((root) => file.startsWith(`${root}${path.sep}`))
  )
    return Promise.reject(Object.assign(new Error('authored absent metadata'), { code: 'ENOENT' }));
  return Promise.reject(new Error('unowned file read'));
}

describe('copied Node data assets and executable alias roots from authored tiny FS only', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<{ stat: typeof stat }>('node:fs/promises');
    vi.mocked(readFile).mockReset().mockImplementation(missingMetadata);
    vi.mocked(stat).mockReset().mockImplementation(actual.stat);
  });

  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it.each(COPY_ROLES)(
    'copies a %s JS data asset without requiring its installed but untraced dependency',
    async (role) => {
      const own = await fixture(role);
      reads(own);
      const physical = await nodePhysicalFiles(own.input, []);
      const asset = physical.files.find((file) => file.name === 'project/data.js');

      expect(asset?.bytes).toStrictEqual(new Uint8Array(Buffer.from(DATA)));
      expect(physical.sourcePaths.get('project/data.js')).toBe(own.asset);
      expect(physical.files.map((file) => file.name)).toStrictEqual([
        'project/entry.js',
        'project/data.js',
      ]);
      expect(physical.links).toStrictEqual([]);
      expect(
        vi.mocked(readFile).mock.calls.filter(([file]) => file === own.entry || file === own.asset),
      ).toHaveLength(2);
    },
  );

  it.each(COPY_ROLES)(
    'promotes a %s JS asset reached by the entry and refuses its unclosed dependency',
    async (role) => {
      const own = await fixture(role, "require('./data.js');exports.value=42;");
      reads(own);

      await expect(nodePhysicalFiles(own.input, [])).rejects.toThrow(UNCLOSED);
    },
  );

  it.each(COPY_ROLES)('keeps a %s data asset strict when it is also an entry', async (role) => {
    const own = await fixture(role);
    reads(own);

    await expect(
      nodePhysicalFiles(
        {
          ...own.input,
          entries: [...own.input.entries, { id: '/also-entry', filePath: own.asset }],
        },
        [],
      ),
    ).rejects.toThrow(UNCLOSED);
  });

  it.each(COPY_ROLES)(
    'keeps a %s data asset strict when it is an explicit source pin',
    async (role) => {
      const own = await fixture(role);
      reads(own);
      const metadata = [
        { file: own.asset, sha256: createHash('sha256').update(DATA).digest('hex') },
      ];

      await expect(nodePhysicalFiles(own.input, [], metadata)).rejects.toThrow(UNCLOSED);
    },
  );

  it.each(COPY_ROLES)('keeps a %s data asset strict when it is the project hook', async (role) => {
    const own = await fixture(role);
    const hook = path.join(own.input.patch.distDir, 'server/instrumentation.js');
    await mkdir(path.dirname(hook), { recursive: true });
    await symlink(path.relative(path.dirname(hook), own.asset), hook);
    reads(own);

    await expect(
      nodePhysicalFiles(
        { ...own.input, patch: { ...own.input.patch, instrumentation: './authored-hook' } },
        [],
      ),
    ).rejects.toThrow(UNCLOSED);
  });

  it.each(COPY_ROLES)('still requires a missing %s data asset to exist', async (role) => {
    const own = await fixture(role);
    await rm(own.asset);
    reads(own, false);

    await expect(nodePhysicalFiles(own.input, [])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('refuses a directory in hard data files even though it is not an executable root', async () => {
    const own = await fixture();
    await rm(own.asset);
    await mkdir(own.asset);
    reads(own, false);

    await expect(nodePhysicalFiles(own.input, [])).rejects.toThrow('kind=directory');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('refuses nonregular data metadata before reading it', async () => {
    const own = await fixture();
    const actual = await vi.importActual<{ stat: typeof stat }>('node:fs/promises');
    const nonregular = await actual.stat(own.asset);
    Object.defineProperties(nonregular, {
      isFile: { value: () => false },
      isDirectory: { value: () => false },
    });
    vi.mocked(stat).mockImplementation((file, options) =>
      file === own.asset ? Promise.resolve(nonregular) : actual.stat(file, options),
    );
    reads(own, false);

    await expect(nodePhysicalFiles(own.input, [])).rejects.toThrow('kind=nonregular');
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
