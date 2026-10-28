import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NativeAddonEntryTrace } from '../src/native-addons.ts';
import {
  assertNodeProofFiles,
  isNodeProofCompilerModule,
  proveNodeFunction,
} from '../src/node-proof.ts';
import { vercelOgImageResponsePatch } from '../src/patches/vercel-og.ts';

describe('original physical Node Function proof', () => {
  let directory: string;
  let distDir: string;
  let entry: string;
  let binary: string;
  let assets: Record<string, string>;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-node-proof-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    distDir = path.join(directory, '.next');
    await mkdir(path.join(distDir, 'server/chunks'), { recursive: true });
    entry = path.join(distDir, 'server/entry.cjs');
    binary = path.join(distDir, 'server/addon.node');
    await writeFile(path.join(directory, 'package.json'), '{"name":"node-proof-fixture"}\n');
    // No native bytes are executed. This is the original-source bundling and audit contract.
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    assets = { entry, binary };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function input(instrumentation?: string, traces?: readonly NativeAddonEntryTrace[]) {
    return {
      kind: 'app' as const,
      projectDir: directory,
      outDir: path.join(directory, '.arkor'),
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: traces ?? [{ id: '/native', assets }],
      patch: {
        projectDir: directory,
        distDir,
        chunks: [] as string[],
        instrumentation,
        wasm: [],
      },
    };
  }

  it('exempts only the exact compiler-generated interop helper identity', () => {
    expect(
      [
        '\0rolldown/runtime.js',
        '\0application/runtime.js',
        '\0rolldown/runtime.js?application',
        '/application/rolldown/runtime.js',
      ].map((id) => isNodeProofCompilerModule(id)),
    ).toStrictEqual([true, false, false, false]);
  });

  it('proves native source with actual Node built-ins and checks the original copied bytes', async () => {
    await writeFile(
      entry,
      "exports.process=require('node:process');exports.vm=require('node:vm');exports.native=()=>require('./addon.node');\n",
    );
    const proof = await proveNodeFunction(input());
    const files = await Promise.all(
      proof.files.map(async (file) => ({ name: file.file, bytes: await readFile(file.file) })),
    );
    const physical = {
      files,
      sourcePaths: new Map(files.map((file) => [file.name, file.name])),
      nameOf: (file: string) => file,
    };
    const missing = { ...physical, files: [] };
    const changed = {
      ...physical,
      files: files.map((file) => ({ ...file, bytes: new Uint8Array([9]) })),
    };

    expect(proof.native).toStrictEqual([
      { kind: 'direct', importer: entry, binary, owners: ['/native'] },
    ]);
    expect(proof.dependencies.externals).toStrictEqual(['node:path', 'node:process', 'node:vm']);
    expect(proof.dependencies.stubs).toStrictEqual([]);
    expect(() => {
      assertNodeProofFiles(proof, physical, new Map());
    }).not.toThrow(Error);
    expect(() => {
      assertNodeProofFiles(proof, missing, new Map());
    }).toThrow('absent or changed');
    expect(() => {
      assertNodeProofFiles(proof, changed, new Map());
    }).toThrow('absent or changed');
  });

  it('does not let a Worker stub hide another owned native operation', async () => {
    const dependency = path.join(directory, 'node_modules/critters');
    await mkdir(dependency, { recursive: true });
    const source = path.join(dependency, 'index.js');
    const second = path.join(dependency, 'second.node');
    await writeFile(path.join(dependency, 'package.json'), '{"name":"critters","main":"index.js"}');
    await writeFile(source, "module.exports=()=>require('./second.node');\n");
    await writeFile(second, new Uint8Array([3, 4]));
    await writeFile(
      entry,
      "exports.native=()=>require('./addon.node');exports.original=require('critters');\n",
    );
    assets = { ...assets, source, second };
    const proof = await proveNodeFunction(input());
    const actualBinaries = proof.native
      .map((load) => load.binary)
      .toSorted((a, b) => a.localeCompare(b));
    const expectedBinaries = [binary, second].toSorted((a, b) => a.localeCompare(b));

    expect(actualBinaries).toStrictEqual(expectedBinaries);
    expect(proof.files.some((file) => file.file === source)).toBe(true);
    expect(proof.dependencies.stubs).toStrictEqual([]);
  });

  it('follows the original Node OG branch instead of the Worker edge replacement', async () => {
    const next = path.join(directory, 'node_modules/next');
    const response = path.join(next, 'dist/server/og/image-response.js');
    const original = path.join(next, 'dist/compiled/@vercel/og/index.node.js');
    const second = path.join(path.dirname(original), 'second.node');
    await mkdir(path.dirname(response), { recursive: true });
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(path.join(next, 'package.json'), '{"name":"next","version":"16.4.3"}');
    const source =
      "exports.load=()=>import(process.env.NEXT_RUNTIME === 'edge' ? 'next/dist/compiled/@vercel/og/index.edge.js' : 'next/dist/compiled/@vercel/og/index.node.js');\n";
    await writeFile(response, source);
    await writeFile(original, "module.exports=()=>require('./second.node');\n");
    await writeFile(second, new Uint8Array([5, 6]));
    await writeFile(
      entry,
      "exports.native=()=>require('./addon.node');exports.og=require('next/dist/server/og/image-response.js');\n",
    );
    assets = { ...assets, response, original, second };
    const options = input();
    const worker = vercelOgImageResponsePatch.apply(source, response, options.patch);
    const proof = await proveNodeFunction(options);
    const actualBinaries = proof.native
      .map((load) => load.binary)
      .toSorted((a, b) => a.localeCompare(b));
    const expectedBinaries = [binary, second].toSorted((a, b) => a.localeCompare(b));

    expect(worker.contents).toContain('index.edge.js');
    expect(actualBinaries).toStrictEqual(expectedBinaries);
    expect(proof.dependencies.patches).toStrictEqual([]);
  });

  it('refuses an uncertified compiler-shaped runtime after analysis linking', async () => {
    const runtime = path.join(distDir, 'server/chunks/[turbopack]_runtime.js');
    const chunk = path.join(distDir, 'server/chunks/native.js');
    await writeFile(
      runtime,
      [
        "const path=require('node:path');const RUNTIME_ROOT=__dirname;",
        'function first(chunkPath){const resolved = path.resolve(RUNTIME_ROOT, chunkPath);const chunkModules = require(resolved);return chunkModules}',
        'function second(chunkPath){const resolved = path.resolve(RUNTIME_ROOT, chunkPath);const chunkModules = require(resolved);return chunkModules}',
        'module.exports={first,second};',
      ].join('\n'),
    );
    await writeFile(chunk, "module.exports=()=>require('../addon.node');\n");
    await writeFile(entry, "module.exports=require('./chunks/[turbopack]_runtime.js');\n");
    assets = { ...assets, runtime, chunk };
    const options = input();
    options.patch.chunks.push(chunk);

    await expect(proveNodeFunction(options)).rejects.toThrow(
      'uncertified Turbopack runtime rewrite',
    );
  });

  it('links and proves the original project instrumentation explicitly', async () => {
    const hook = path.join(distDir, 'server/instrumentation.js');
    await writeFile(entry, 'module.exports={handler:()=>42};\n');
    await writeFile(hook, "exports.register=async()=>require('./addon.node');\n");
    const proof = await proveNodeFunction(
      input(hook, [{ id: 'instrumentation', assets: { hook, binary } }]),
    );

    expect(proof.native).toStrictEqual([
      { kind: 'direct', importer: hook, binary, owners: ['instrumentation'] },
    ]);
  });

  it('refuses an unrelated guarded dynamic load on the real Node graph', async () => {
    await writeFile(
      entry,
      "exports.native=()=>require('./addon.node');exports.unknown=(name)=>{try{return require(name)}catch{return 42}};\n",
    );

    await expect(proveNodeFunction(input())).rejects.toThrow('load the bundler could not follow');
  });

  it('does not let a Node-created loader hide a second physical native graph', async () => {
    await writeFile(
      entry,
      "const {createRequire}=require('node:module');exports.native=()=>require('./addon.node');exports.other=name=>createRequire(__filename)(name);\n",
    );

    const refused = proveNodeFunction(input());

    await expect(refused).rejects.toThrow('unproved Node');
    await expect(refused).rejects.toThrow('".next/server/entry.cjs"');
    await expect(refused).rejects.not.toThrow(directory);
  });

  it('refuses a retained unexpanded Turbopack external reference', async () => {
    const chunk = path.join(distDir, 'server/chunks/external.js');
    await writeFile(
      chunk,
      "module.exports=[1,(context)=>{context.y('unproved-native-package')}];\n",
    );
    await writeFile(
      entry,
      "exports.native=()=>require('./addon.node');exports.other=require('./chunks/external.js');\n",
    );
    assets = { ...assets, chunk };

    await expect(proveNodeFunction(input())).rejects.toThrow('unproved Turbopack external import');
  });

  it('does not infer a runtime capability from an unused traced binary', async () => {
    await writeFile(entry, 'module.exports={handler:()=>42};\n');

    await expect(proveNodeFunction(input())).rejects.toThrow(
      'no retained, owned native capability',
    );
  });
});
