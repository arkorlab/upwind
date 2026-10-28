import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { proveNodeFunction } from '../src/node-proof.ts';

describe('original CommonJS host loader before Node publication', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-original-host-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    "if(false) module.require('./unused.js');",
    'function unusedLoader(name){return module.require(name);}',
  ])('does not reject a loader removed from the retained graph: %s', async (deadLoader) => {
    const distDir = path.join(directory, '.next');
    const entry = path.join(distDir, 'server/entry.cjs');
    const binary = path.join(distDir, 'server/addon.node');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(entry, `exports.native=()=>require('./addon.node');\n${deadLoader}`);

    const proof = await proveNodeFunction({
      kind: 'app',
      projectDir: directory,
      outDir: path.join(directory, '.upwind'),
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [{ id: '/native', assets: { entry, binary } }],
      patch: { projectDir: directory, distDir, chunks: [], instrumentation: undefined, wasm: [] },
    });

    expect(proof.native).toHaveLength(1);
    expect(proof.files).toContainEqual(expect.objectContaining({ file: entry }));
  });

  it('refuses the real original module constructor even after CJS bundling introduces a module parameter', async () => {
    const distDir = path.join(directory, '.next');
    const entry = path.join(distDir, 'server/entry.cjs');
    const binary = path.join(distDir, 'server/addon.node');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(
      entry,
      [
        "exports.native=()=>require('./addon.node');",
        'exports.load=name=>module.constructor._load(name);',
      ].join('\n'),
    );
    const operation = proveNodeFunction({
      kind: 'app',
      projectDir: directory,
      outDir: path.join(directory, '.upwind'),
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [{ id: '/native', assets: { entry, binary } }],
      patch: { projectDir: directory, distDir, chunks: [], instrumentation: undefined, wasm: [] },
    });

    await expect(operation).rejects.toThrow('original CommonJS host loader');
  });
});
