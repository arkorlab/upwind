import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { proveNodeFunction } from '../src/node-proof.ts';
import { turbopackRuntimePatch } from '../src/patches/turbopack-runtime.ts';
import { sameChunks } from '../src/same-chunks.ts';

const CHUNK_SOURCE = 'module.exports=require("./dependency.cjs");\n';
const DEPENDENCY_SOURCE = 'exports.native=()=>require("./addon.node");\n';

describe('original Node chunk coordinates through Worker copy metadata', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-node-original-copies-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture() {
    const distDir = path.join(directory, '.next');
    const root = path.join(distDir, 'server/chunks');
    const canonical = path.join(root, 'a/chunk.js');
    const original = path.join(root, 'z/chunk.js');
    const runtime = path.join(root, '[turbopack]_runtime.js');
    const entry = path.join(distDir, 'server/entry.cjs');
    const dependencies: string[] = [];
    const binaries: string[] = [];
    await writeFile(path.join(directory, 'package.json'), '{"name":"original-chunk-coordinates"}');
    for (const chunk of [canonical, original]) {
      await mkdir(path.dirname(chunk), { recursive: true });
      await writeFile(chunk, CHUNK_SOURCE);
      const dependency = path.join(path.dirname(chunk), 'dependency.cjs');
      const binary = path.join(path.dirname(chunk), 'addon.node');
      await writeFile(dependency, DEPENDENCY_SOURCE);
      // These authored bytes are only traced/parsed; the addon is never loaded or executed.
      await writeFile(binary, new Uint8Array([0, 1, 2]));
      dependencies.push(dependency);
      binaries.push(binary);
    }
    const runtimeCode = [
      'const path=require("node:path");const RUNTIME_ROOT=__dirname;',
      'function first(chunkPath){const resolved = path.resolve(RUNTIME_ROOT, chunkPath);const chunkModules = require(resolved);return chunkModules}',
      'function second(chunkPath){const resolved = path.resolve(RUNTIME_ROOT, chunkPath);const chunkModules = require(resolved);return chunkModules}',
      'module.exports={first,second};',
    ].join('\n');
    await writeFile(runtime, runtimeCode);
    await writeFile(entry, 'module.exports=require("./chunks/[turbopack]_runtime.js");');
    const chunks = [original, canonical];
    const copies = await sameChunks(chunks, { carried: false });
    const files = [entry, runtime, ...chunks, ...dependencies, ...binaries];
    const input = {
      kind: 'app' as const,
      projectDir: directory,
      outDir: path.join(directory, '.arkor'),
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [
        { id: '/native', assets: Object.fromEntries(files.map((file) => [file, file])) },
      ],
      patch: Object.freeze({
        projectDir: directory,
        distDir,
        chunks,
        copies,
        instrumentation: undefined,
        wasm: [],
      }),
    };
    return { input, original, canonical, dependencies, binaries, runtime, runtimeCode, copies };
  }

  it('retains both original chunks and resolves each relative dependency and addon from that file', async () => {
    const own = await fixture();
    const proof = await proveNodeFunction(own.input);
    const sources = proof.files.map((file) => file.file);

    expect(own.copies.get(own.original)).toBe(own.canonical);
    expect(sources).toStrictEqual(
      expect.arrayContaining([own.original, own.canonical, ...own.dependencies]),
    );
    expect(
      proof.native
        .map((load) => load.importer)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(own.dependencies.toSorted((left, right) => left.localeCompare(right)));
    expect(
      proof.native.map((load) => load.binary).toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(own.binaries.toSorted((left, right) => left.localeCompare(right)));
    await expect(readFile(own.original, 'utf8')).resolves.toBe(CHUNK_SOURCE);
    await expect(readFile(own.canonical, 'utf8')).resolves.toBe(CHUNK_SOURCE);
  });

  it('keeps the ordinary Worker patch copy substitution and the caller context unchanged', async () => {
    const own = await fixture();
    const before = [...own.copies];
    const worker = turbopackRuntimePatch.apply(own.runtimeCode, own.runtime, own.input.patch);
    await proveNodeFunction(own.input);
    const originalPath = path
      .relative(own.input.patch.distDir, own.original)
      .split(path.sep)
      .join('/');

    expect(worker.contents).toContain(
      `case ${jsLiteral(originalPath)}: return require(${jsLiteral(own.canonical)});`,
    );
    expect(worker.contents).not.toContain(`require(${jsLiteral(own.original)})`);
    expect(own.input.patch.copies).toBe(own.copies);
    expect([...own.input.patch.copies]).toStrictEqual(before);
    expect(Object.isFrozen(own.input.patch)).toBe(true);
  });
});
