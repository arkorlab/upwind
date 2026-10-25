import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import { AuditError } from '../src/dependencies.ts';
import { buildFunction, type BuildFunctionInput, type FunctionKind } from '../src/function.ts';
import { NativeFunctionRequiredError } from '../src/native-loads.ts';
import type { RuntimeBundleInput } from '../src/runtime-bundle.ts';
import { WasmCollector } from '../src/wasm.ts';

// Keep the production app bundle and audit dispatch. This fixture needs no application runtime.
vi.mock(import('../src/runtime-bundle.ts'), () => {
  return {
    bundleRuntimeModule: async (input: RuntimeBundleInput) => {
      await writeFile(input.outFile, 'export default {};\n');
    },
  };
});

async function failureOf(input: BuildFunctionInput): Promise<unknown> {
  try {
    await buildFunction(input);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('native capability dispatch by Function kind', () => {
  let directory: string;
  let distDir: string;
  let entry: string;
  let binary: string;
  let outDir: string;
  let blobs: BlobStore;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-kind-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    distDir = path.join(directory, '.next');
    outDir = path.join(directory, '.arkor');
    entry = path.join(distDir, 'server/native.cjs');
    binary = path.join(distDir, 'server/addon.node');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"name":"native-kind-fixture"}\n');
    // The real app pipeline only reads these bytes as proof metadata, never as a loaded addon.
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(entry, "module.exports={handler:()=>require('./addon.node')};\n");
    blobs = new BlobStore(outDir);
    await blobs.init();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function input(kind: FunctionKind): BuildFunctionInput {
    return {
      kind,
      projectDir: directory,
      repoRoot: directory,
      outDir,
      patch: { projectDir: directory, distDir, chunks: [], instrumentation: undefined, wasm: [] },
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [{ id: '/native', assets: { entry, binary } }],
      edgeEntries: [],
      wasm: new WasmCollector(),
      manifests: [],
      runtimeManifest: '{}',
      cacheHostModule: undefined,
      blobs: [],
      files: [],
      blobStore: blobs,
    };
  }

  it.each(['middleware', 'workflow'] as const)(
    'refuses native requirements in %s with an explicit unsupported-runtime audit',
    async (kind) => {
      const error = await failureOf(input(kind));
      if (!(error instanceof Error)) throw new Error('The Function build did not throw an Error');

      expect(error).toBeInstanceOf(AuditError);
      expect(error.message).toContain(
        `Native Node.js addons are unsupported in the ${kind} Function`,
      );
    },
  );

  it('keeps the typed automatic placement signal for an app Function only', async () => {
    const error = await failureOf(input('app'));

    expect(error).toBeInstanceOf(NativeFunctionRequiredError);
    expect(error).toMatchObject({
      loads: [{ kind: 'direct', importer: entry, binary, owners: ['/native'] }],
    });
  });

  it('preserves an unrelated graph-audit refusal before native runtime dispatch', async () => {
    await writeFile(
      entry,
      "exports.native=require('./addon.node'); exports.other=(name)=>require(name);\n",
    );
    const error = await failureOf(input('middleware'));
    if (!(error instanceof Error)) throw new Error('The Function build did not throw an Error');

    expect(error).toBeInstanceOf(AuditError);
    expect(error.message).toContain('bundler could not follow');
  });
});
