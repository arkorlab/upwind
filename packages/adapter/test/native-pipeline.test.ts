import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appBundleOptions, type AppBundleSinks } from '../src/app-bundle.ts';
import { appEntrySource } from '../src/app-entry.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';
import { FUNCTION_BANNER } from '../src/patches/banner.ts';
import { WasmCollector } from '../src/wasm.ts';

describe('native proof through the production app bundle pipeline', () => {
  let directory: string;
  let distDir: string;
  let entry: string;
  let native: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-pipeline-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    distDir = path.join(directory, '.next');
    await mkdir(path.join(distDir, 'server'), { recursive: true });
    entry = path.join(directory, 'app-entry.cjs');
    native = path.join(distDir, 'server/native.cjs');
    binary = path.join(distDir, 'server/addon.node');
    await writeFile(path.join(directory, 'package.json'), '{"name":"native-pipeline-fixture"}\n');
    // Only source is bundled here. The fake native bytes must never be imported or executed.
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(
      entry,
      appEntrySource([{ id: '/native', filePath: native }], {
        external: false,
        runtimeDistDir: '.next',
      }),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function bundled(source: string) {
    await writeFile(native, source);
    const proof = nativeLoadsPlugin([
      {
        id: '/native',
        assets: { '.next/server/native.cjs': native, '.next/server/addon.node': binary },
      },
    ]);
    const sinks: AppBundleSinks = {
      patches: [],
      stubs: [],
      externals: new Set(),
      wasm: [],
      linked: new Set(),
    };
    await using build = await rolldown(
      appBundleOptions(
        directory,
        entry,
        {
          nativeCapabilities: proof.plugin,
          patch: {
            projectDir: directory,
            distDir,
            chunks: [],
            instrumentation: undefined,
            wasm: [],
          },
          wasm: new WasmCollector(),
        },
        sinks,
      ),
    );
    // These are the actual writeAppBundle output settings, including production compression.
    const output = await build.generate({
      format: 'cjs',
      codeSplitting: false,
      banner: FUNCTION_BANNER,
      minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
      comments: { legal: false },
    });
    const chunk = output.output.find((item): item is OutputChunk => item.type === 'chunk');
    if (chunk === undefined) throw new Error('The pipeline fixture produced no chunk');
    return { code: chunk.code, loads: await proof.retained(chunk), chunk, proof };
  }

  it('retains an owned native call inside an asynchronous lazy route handler', async () => {
    const output = await bundled(
      "const loaded={routeModule:{distDir:'original-build-location'},handler:async(_req,res)=>{const addon=require('./addon.node');res.setHeader('content-type','text/plain');res.end(addon.message)}};module.exports=Promise.resolve(loaded);\n",
    );

    expect(output.code).toContain('__UPWIND_NATIVE_CAPABILITY__');
    expect(output.loads).toStrictEqual([
      { kind: 'direct', importer: native, binary, owners: ['/native'] },
    ]);
  });

  it('keeps a traced binary out of classification when its only call is dead', async () => {
    const output = await bundled(
      "if(false)require('./addon.node');module.exports={handler:async(_req,res)=>res.end('worker-only')};\n",
    );

    expect(output.code).not.toContain('__UPWIND_NATIVE_CAPABILITY__');
    expect(output.loads).toStrictEqual([]);
  });

  it.each([
    '__UPWIND_NATIVE_CAPABILITY__()',
    '__UPWIND_NATIVE_CAPABILITY__(0)',
    // eslint-disable-next-line no-template-curly-in-string -- This malformed marker is deliberately executable source text.
    '__UPWIND_NATIVE_CAPABILITY__(`id${1}`)',
    '__UPWIND_NATIVE_CAPABILITY__("0","extra")',
    '__UPWIND_NATIVE_CAPABILITY__("unknown")',
    '__UPWIND_NATIVE_WORKER_CHILD__()',
    '__UPWIND_NATIVE_WORKER_CHILD__("unknown")',
  ])('refuses a malformed or unrecognized retained marker: %s', async (code) => {
    const output = await bundled('module.exports = 42;\n');

    await expect(output.proof.retained({ ...output.chunk, code })).rejects.toThrow(Error);
  });
});
