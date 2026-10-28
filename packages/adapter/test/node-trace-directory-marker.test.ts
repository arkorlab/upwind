import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import { WasmCollector } from '../src/wasm.ts';

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: vi.fn<() => Promise<never>>().mockRejectedValue(new Error('unowned file read')),
  };
});

const ENTRY = 'exports.value=42;';
const CHILD = 'independently traced payload';
const directories: string[] = [];
const HARD_ROLES = ['entry', 'file', 'edge', 'manifest', 'metadata', 'instrumentation'] as const;
type HardRole = (typeof HARD_ROLES)[number];

async function fixture(markerFirst = true) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-trace-directory-'));
  const directory = await realpath(temporary);
  directories.push(directory);
  const root = path.join(directory, 'project');
  const marker = path.join(root, 'assets');
  const child = path.join(marker, 'kept.txt');
  const entry = path.join(root, 'entry.js');
  await mkdir(marker, { recursive: true });
  await writeFile(entry, ENTRY);
  await writeFile(child, CHILD);
  await writeFile(path.join(marker, 'unowned.txt'), 'not independently traced');
  const pairs: readonly (readonly [string, string])[] = markerFirst
    ? [
        ['assets', marker],
        ['assets/kept.txt', child],
      ]
    : [
        ['assets/kept.txt', child],
        ['assets', marker],
      ];
  const assets: Record<string, string> = Object.fromEntries(pairs);
  const input: BuildFunctionInput = {
    kind: 'app',
    projectDir: root,
    repoRoot: root,
    outDir: path.join(directory, 'output'),
    patch: {
      projectDir: root,
      distDir: path.join(root, '.next'),
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    },
    entries: [{ id: '/authored', filePath: entry }],
    entryTraces: [{ id: '/authored', assets }],
    edgeEntries: [],
    wasm: new WasmCollector(),
    manifests: [],
    runtimeManifest: '{}',
    cacheHostModule: undefined,
    blobs: [],
    files: [],
    blobStore: new BlobStore(path.join(directory, 'blobs')),
  };
  return { directory, root, marker, child, entry, assets, input };
}

function reads(child = true): void {
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(ENTRY));
  if (child) vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(CHILD));
}

async function withHardRole(
  own: Awaited<ReturnType<typeof fixture>>,
  role: HardRole,
  file: string,
) {
  const input = own.input;
  switch (role) {
    case 'entry': {
      return { input: { ...input, entries: [...input.entries, { id: '/hard', filePath: file }] } };
    }
    case 'file': {
      return { input: { ...input, files: [{ name: 'hard', filePath: file }] } };
    }
    case 'edge': {
      return {
        input: {
          ...input,
          edgeEntries: [
            {
              id: '/edge',
              entryKey: 'edge',
              handlerExport: 'handler',
              files: [file],
              wasm: [],
              inlineAssets: [],
              env: {},
            },
          ],
        },
      };
    }
    case 'manifest': {
      return {
        input: { ...input, manifests: [{ name: 'hard.json', contents: '{}', routeFile: file }] },
      };
    }
    case 'metadata': {
      return { input, metadata: [{ file, sha256: '0'.repeat(64) }] };
    }
    case 'instrumentation': {
      const hook = path.join(input.patch.distDir, 'server/instrumentation.js');
      await mkdir(path.dirname(hook), { recursive: true });
      await symlink(path.relative(path.dirname(hook), file), hook);
      return { input: { ...input, patch: { ...input.patch, instrumentation: './authored-hook' } } };
    }
  }
}

const hardCases = HARD_ROLES.flatMap((role) => {
  return [false, true].flatMap((alias) =>
    [false, true].map((markerFirst) => ({ role, alias, markerFirst })),
  );
});

describe('explicit trace directory markers represented by copied files only', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset().mockRejectedValue(new Error('unowned file read'));
  });

  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it.each([false, true])(
    'accepts only the independently copied descendant with markerFirst=%s',
    async (markerFirst) => {
      const own = await fixture(markerFirst);
      reads();
      const physical = await nodePhysicalFiles(own.input, []);

      expect(physical.files.map((file) => file.name)).toStrictEqual([
        'project/entry.js',
        'project/assets/kept.txt',
      ]);
      expect(physical.sourcePaths.has('project/assets')).toBe(false);
      expect(physical.files.some((file) => file.name.endsWith('unowned.txt'))).toBe(false);
      expect(readFile).toHaveBeenCalledTimes(2);
      expect(physical.links).toStrictEqual([]);
    },
  );

  it('preserves a logical directory symlink using the original trace aliases', async () => {
    const own = await fixture();
    const alias = path.join(own.root, 'logical-assets');
    await symlink('assets', alias);
    const input = {
      ...own.input,
      entryTraces: [
        {
          id: '/authored',
          assets: { 'logical-assets': own.marker, 'logical-assets/kept.txt': own.child },
        },
      ],
    };
    reads();
    const physical = await nodePhysicalFiles(input, []);

    expect(physical.links).toStrictEqual([
      { path: 'project/logical-assets', target: 'project/assets' },
    ]);
    expect(physical.sourcePaths.has('project/assets')).toBe(false);
    expect(physical.sourcePaths.get('project/assets/kept.txt')).toBe(own.child);
  });

  it('refuses a standalone marker even when it contains unowned regular children', async () => {
    const own = await fixture();
    const input = {
      ...own.input,
      entryTraces: [{ id: '/authored', assets: { assets: own.marker } }],
    };
    reads(false);

    await expect(nodePhysicalFiles(input, [])).rejects.toThrow(
      'no independently copied regular descendant',
    );
    expect(readFile).toHaveBeenCalledExactlyOnceWith(own.entry);
  });

  it('refuses an empty marker instead of synthesizing a directory archive entry', async () => {
    const own = await fixture();
    const empty = path.join(own.root, 'empty');
    await mkdir(empty);
    const input = { ...own.input, entryTraces: [{ id: '/authored', assets: { empty } }] };
    reads(false);

    await expect(nodePhysicalFiles(input, [])).rejects.toThrow(
      'no independently copied regular descendant',
    );
  });

  it.each(hardCases)(
    'keeps hard $role regular with alias=$alias markerFirst=$markerFirst',
    async ({ role, alias, markerFirst }) => {
      const own = await fixture(markerFirst);
      const logical = path.join(own.root, 'hard-alias');
      await symlink('assets', logical);
      const selected = await withHardRole(own, role, alias ? logical : own.marker);
      reads(false);

      await expect(nodePhysicalFiles(selected.input, [], selected.metadata)).rejects.toThrow(
        'bounded, regular input files',
      );
    },
  );

  it('rejects an explicit outside-layout directory before considering its descendants', async () => {
    const own = await fixture();
    const outside = path.join(own.directory, 'outside');
    await mkdir(outside);
    const input = { ...own.input, entryTraces: [{ id: '/authored', assets: { outside } }] };
    reads(false);

    await expect(nodePhysicalFiles(input, [])).rejects.toThrow(
      'escapes both its tracing root and build output',
    );
    expect(readFile).toHaveBeenCalledExactlyOnceWith(own.entry);
  });

  it('keeps an oversized traced regular file refused before reading it', async () => {
    const own = await fixture();
    const oversized = path.join(own.marker, 'oversized.bin');
    await writeFile(oversized, '');
    await truncate(oversized, 134_217_729);
    const input = {
      ...own.input,
      entryTraces: [{ id: '/authored', assets: { assets: own.marker, oversized } }],
    };
    reads(false);

    await expect(nodePhysicalFiles(input, [])).rejects.toThrow(
      'kind=regular, bytes=134217729, maxBytes=134217728',
    );
    expect(readFile).toHaveBeenCalledExactlyOnceWith(own.entry);
  });
});
