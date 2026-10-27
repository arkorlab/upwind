import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeProofRawSources, proveNodeFunction } from '../src/node-proof.ts';

const ENABLED = process.env['UPWIND_NATIVE_FUNCTION_INTEGRATION'] === '1';

// The actual compiler and original-source qualifier run only in the dedicated CI lane.
// The binary is inert fixture DATA and is never loaded or evaluated by these tests.
describe.skipIf(!ENABLED)('complete original Node export closure (dedicated CI)', () => {
  let directory: string;
  let distDir: string;
  let entry: string;
  let binary: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-raw-closure-'));
    directory = await realpath(temporary);
    distDir = path.join(directory, '.next');
    await mkdir(path.join(distDir, 'server'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"name":"raw-closure-control"}');
    entry = path.join(distDir, 'server/entry.cjs');
    binary = path.join(distDir, 'server/addon.node');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function input(files: readonly string[]) {
    return {
      kind: 'app' as const,
      projectDir: directory,
      outDir: path.join(directory, '.arkor'),
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [
        { id: '/native', assets: Object.fromEntries([entry, binary, ...files].map((f) => [f, f])) },
      ],
      patch: {
        projectDir: directory,
        distDir,
        chunks: [] as string[],
        instrumentation: undefined,
        wasm: [],
      },
    };
  }

  async function writeEntry(dependency: string) {
    await writeFile(
      entry,
      `exports.value=require(${JSON.stringify(dependency)}).used;exports.native=()=>require('./addon.node');`,
    );
  }

  it('keeps a static dependency exposed only by an otherwise unused CommonJS export', async () => {
    const dependency = path.join(distDir, 'server/dependency.cjs');
    const leaf = path.join(distDir, 'server/leaf.cjs');
    await writeFile(dependency, "exports.used=42;exports.unused=require('./leaf.cjs');");
    await writeFile(leaf, 'exports.value=17;');
    await writeEntry('./dependency.cjs');

    const proof = await proveNodeFunction(input([dependency, leaf]));
    const files = nodeProofRawSources(proof).map((source) => source.file);

    expect(files).toStrictEqual(expect.arrayContaining([entry, dependency, leaf]));
    expect(files).not.toContain(binary);
    expect(files.some((file) => file.endsWith('/work/node-proof-app/entry.cjs'))).toBe(false);
    expect(() => nodeProofRawSources({ ...proof })).toThrow(Error);
  });

  it('refuses a dynamic loader in an otherwise unused CommonJS export', async () => {
    const dependency = path.join(distDir, 'server/dependency.cjs');
    await writeFile(dependency, 'exports.used=42;exports.unused=(name)=>require(name);');
    await writeEntry('./dependency.cjs');

    await expect(proveNodeFunction(input([dependency]))).rejects.toThrow(
      'load the bundler could not follow',
    );
  });

  it('refuses a hidden loader helper behind an otherwise unused ES module export', async () => {
    const dependency = path.join(distDir, 'server/dependency.mjs');
    await writeFile(
      dependency,
      'function load(name){return require(name)}export const used=42;export const unused=load;',
    );
    await writeEntry('./dependency.mjs');

    await expect(proveNodeFunction(input([dependency]))).rejects.toThrow(
      'load the bundler could not follow',
    );
  });

  it('refuses a namespace without a complete compiler export witness', async () => {
    const dependency = path.join(distDir, 'server/dependency.mjs');
    await writeFile(dependency, 'export const first=17;export const second=42;');
    await writeFile(
      entry,
      "exports.value=require('./dependency.mjs');exports.native=()=>require('./addon.node');",
    );

    await expect(proveNodeFunction(input([dependency]))).rejects.toThrow(
      'raw source export was eliminated',
    );
  });
});
