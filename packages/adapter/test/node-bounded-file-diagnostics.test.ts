import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import { WasmCollector } from '../src/wasm.ts';

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: vi.fn<() => Promise<never>>().mockRejectedValue(new Error('unexpected file read')),
  };
});

const MAX_BYTES = 134_217_728;
const directories: string[] = [];

async function fixture(entryName = 'entry.js') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-node-file-diagnostic-'));
  const root = await realpath(temporary);
  directories.push(root);
  const entry = path.join(root, entryName);
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
    edgeEntries: [],
    wasm: new WasmCollector(),
    manifests: [],
    runtimeManifest: '{}',
    cacheHostModule: undefined,
    blobs: [],
    files: [],
    blobStore: new BlobStore(path.join(root, 'blobs')),
  };
  return { root, entry, input };
}

function refusal(identity: string, kind: string, bytes: number): string {
  return `Node artifact requires bounded, regular input files: ${JSON.stringify(identity)} (kind=${kind}, bytes=${bytes}, maxBytes=${MAX_BYTES})`;
}

describe('bounded physical file refusal diagnostics from authored FS only', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it('keeps a directory refused and reports its relative identity and observed size', async () => {
    const name = 'authored-"directory"\n';
    const own = await fixture(name);
    await mkdir(own.entry);
    const info = await stat(own.entry);

    await expect(nodePhysicalFiles(own.input, [])).rejects.toThrow(
      refusal(name, 'directory', info.size),
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it('keeps a sparse oversize regular file refused before reading any content', async () => {
    const own = await fixture();
    await writeFile(own.entry, '');
    await truncate(own.entry, MAX_BYTES + 1);

    await expect(nodePhysicalFiles(own.input, [])).rejects.toThrow(
      refusal('entry.js', 'regular', MAX_BYTES + 1),
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it('uses the same root-relative diagnostic for an invalid ancestor package manifest', async () => {
    const own = await fixture();
    const code = 'exports.value=42;';
    await writeFile(own.entry, code);
    const manifest = path.join(own.root, 'package.json');
    await mkdir(manifest);
    const info = await stat(manifest);
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(code));

    await expect(nodePhysicalFiles(own.input, [])).rejects.toThrow(
      refusal('package.json', 'directory', info.size),
    );
    expect(readFile).toHaveBeenCalledExactlyOnceWith(own.entry);
  });

  it('bounds the quoted identity without exposing the absolute tracing root', async () => {
    const name = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)].join('/');
    const own = await fixture(name);
    await mkdir(own.entry, { recursive: true });
    const info = await stat(own.entry);
    const bounded = `${name.slice(0, 240)}…`;

    await expect(nodePhysicalFiles(own.input, [])).rejects.toThrow(
      refusal(bounded, 'directory', info.size),
    );
    expect(readFile).not.toHaveBeenCalled();
  });
});
