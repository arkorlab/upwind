import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import { WasmCollector } from '../src/wasm.ts';

const directories: string[] = [];

/** An authored project: an entry, a server output beside it, and a package nothing traces. */
async function project() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-server-output-'));
  const root = await realpath(temporary);
  directories.push(root);
  const dist = path.join(root, '.next');
  const entry = path.join(dist, 'server/app/page.js');
  const files: Record<string, string> = {
    'package.json': '{}',
    '.next/BUILD_ID': 'build',
    '.next/routes-manifest.json': '{}',
    '.next/server/app/page.js': 'exports.page=1;',
    '.next/server/app/page.js.nft.json': '{"version":1,"files":[]}',
    '.next/server/app/page_client-reference-manifest.js': 'globalThis.manifest={};',
    // A chunk names a package no trace carries: copied, never an executable root.
    '.next/server/chunks/ssr/chunk.js': "exports.chunk=()=>require('untraced');",
    '.next/server/route-cache/APP_PAGE/index.html': '<p>prerendered</p>',
    '.next/static/chunks/client.js': 'client',
    'node_modules/untraced/index.js': 'exports.untraced=true;',
    'node_modules/untraced/package.json': '{"name":"untraced"}',
  };
  for (const [name, code] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), code);
  }
  const input: BuildFunctionInput = {
    kind: 'app',
    projectDir: root,
    repoRoot: root,
    outDir: path.join(root, 'output'),
    patch: { projectDir: root, distDir: dist, chunks: [], instrumentation: undefined, wasm: [] },
    entries: [{ id: '/', filePath: entry }],
    entryTraces: [],
    edgeEntries: [],
    wasm: new WasmCollector(),
    manifests: [],
    runtimeManifest: '{}',
    cacheHostModule: undefined,
    blobs: [],
    files: [],
    blobStore: new BlobStore(path.join(root, 'blobs')),
  };
  return { root, dist, input };
}

describe('a Node artifact carrying the whole server output', () => {
  afterEach(async () => {
    for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('copies every server file and the root manifests, without traces or client assets', async () => {
    const own = await project();
    const physical = await nodePhysicalFiles(own.input, [], [], { serverOutput: true });
    const names = new Set(physical.files.map((file) => file.name));

    expect(
      [
        '.next/BUILD_ID',
        '.next/routes-manifest.json',
        '.next/server/app/page.js',
        '.next/server/app/page_client-reference-manifest.js',
        '.next/server/chunks/ssr/chunk.js',
        '.next/server/route-cache/APP_PAGE/index.html',
      ].map((name) => names.has(physical.nameOf(path.join(own.root, name)))),
    ).toStrictEqual([true, true, true, true, true, true]);
    expect(
      ['.next/server/app/page.js.nft.json', '.next/static/chunks/client.js'].map((name) =>
        names.has(physical.nameOf(path.join(own.root, name))),
      ),
    ).toStrictEqual([false, false]);
  });

  it('carries only the traced closure without the option', async () => {
    const own = await project();
    const physical = await nodePhysicalFiles(own.input, [], []);
    const names = new Set(physical.files.map((file) => file.name));
    const chunk = physical.nameOf(path.join(own.dist, 'server/chunks/ssr/chunk.js'));

    expect(names.has(chunk)).toBe(false);
  });

  it('refuses a link inside the server output', async () => {
    const own = await project();
    await symlink(
      path.join(own.root, 'node_modules/untraced/index.js'),
      path.join(own.dist, 'server/chunks/linked.js'),
    );

    await expect(nodePhysicalFiles(own.input, [], [], { serverOutput: true })).rejects.toThrow(
      'Node server output holds a link or special file',
    );
  });
});
