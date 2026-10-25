import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { proveNodeFunction } from '../src/node-proof.ts';

const FAKE_RUNTIME = [
  'const path=require("node:path");const RUNTIME_ROOT=__dirname;',
  'function first(chunkPath){const resolved = path.resolve(RUNTIME_ROOT, chunkPath);const chunkModules = require(resolved);return chunkModules}',
  'function second(chunkPath){const resolved = path.resolve(RUNTIME_ROOT, chunkPath);const chunkModules = require(resolved);return chunkModules}',
  'module.exports={first,second};',
].join('\n');

describe('retained original Node runtime rewrite certification', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-node-runtime-gate-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(runtimeCode?: string) {
    const distDir = path.join(directory, '.next');
    const entry = path.join(distDir, 'server/entry.cjs');
    const runtime = path.join(distDir, 'server/chunks/[turbopack]_runtime.js');
    const chunk = path.join(distDir, 'server/chunks/ordinary.js');
    const binary = path.join(distDir, 'server/addon.node');
    await mkdir(path.dirname(runtime), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"name":"runtime-gate-source-fixture"}');
    // Native bytes are author-created trace data, never imported or executed by these tests.
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(chunk, 'module.exports={value:42};');
    let code = 'exports.native=()=>require("./addon.node");';
    if (runtimeCode !== undefined) {
      await writeFile(runtime, runtimeCode);
      code += 'exports.runtime=require("./chunks/[turbopack]_runtime.js");';
    }
    await writeFile(entry, code);
    const files = runtimeCode === undefined ? [entry, binary] : [entry, binary, runtime, chunk];
    return {
      binary,
      entry,
      input: {
        kind: 'app' as const,
        projectDir: directory,
        outDir: path.join(directory, '.arkor'),
        entries: [{ id: '/native', filePath: entry }],
        entryTraces: [
          { id: '/native', assets: Object.fromEntries(files.map((file) => [file, file])) },
        ],
        patch: {
          projectDir: directory,
          distDir,
          chunks: runtimeCode === undefined ? [] : [chunk],
          instrumentation: undefined,
          wasm: [],
        },
      },
    };
  }

  it('still proves a literal owned native load with no rewritten compiler runtime', async () => {
    const own = await fixture();
    const proof = await proveNodeFunction(own.input);

    expect(proof.native).toStrictEqual([
      { kind: 'direct', importer: own.entry, binary: own.binary, owners: ['/native'] },
    ]);
    expect(proof.dependencies.patches).toStrictEqual([]);
  });

  it.each([FAKE_RUNTIME, `${FAKE_RUNTIME}\nexports.changed=true;`])(
    'does not grant compiler authority to a matching filename and rewritten load-site shapes',
    async (code) => {
      const own = await fixture(code);

      await expect(proveNodeFunction(own.input)).rejects.toThrow(
        'uncertified Turbopack runtime rewrite',
      );
    },
  );

  it('refuses a changed primary runtime carrying an unknown raw loader without full closure certification', async () => {
    const primary = await readFile(
      new URL('fixtures/node-runtime/production.txt', import.meta.url),
      'utf8',
    );
    const own = await fixture(`${primary}\nexports.unknown=name=>require(name);`);

    await expect(proveNodeFunction(own.input)).rejects.toThrow(
      'uncertified Turbopack runtime rewrite',
    );
  });
});
