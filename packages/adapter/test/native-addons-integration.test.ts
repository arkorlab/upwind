import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appFunctionInput, buildAppFunction, type FunctionsContext } from '../src/app-functions.ts';
import { BlobStore } from '../src/blobs.ts';
import type { BuildContext, RouteCode } from '../src/collect.ts';
import { AuditError } from '../src/dependencies.ts';
import { buildFunction, type FunctionKind } from '../src/function.ts';
import { NativeFunctionRequiredError } from '../src/native-loads.ts';
import { bundleRuntimeModule, type RuntimeBundleInput } from '../src/runtime-bundle.ts';

/**
 * Keep the real app bundler, Function assembler and audit. Only the unrelated runtime module is
 * inert, so this small fixture needs neither a Next.js build nor a native binary to be compiled.
 */
vi.mock(import('../src/runtime-bundle.ts'), () => {
  return {
    bundleRuntimeModule: vi.fn((input: RuntimeBundleInput) =>
      writeFile(input.outFile, 'export default {};\n'),
    ),
  };
});

const ROUTE = '/native';
const NATIVE_ASSET = 'node_modules/native-addon/build/Release/addon.node';
const ORIGINAL_REFUSAL = 'the app Function would not run:';
const NATIVE_CONTEXT = 'This Function also traces native Node.js addons';

/** The entry's real dynamic loader survives app bundling and must fail the normal audit. */
const ENTRY_SOURCE = 'module.exports = function load(binary) { return require(binary); };\n';

async function contextOf(directory: string, native: boolean): Promise<FunctionsContext> {
  const outDir = path.join(directory, '.upwind');
  const blobs = new BlobStore(outDir);
  await blobs.init();
  const filePath = path.join(directory, 'entry.cjs');
  await writeFile(filePath, ENTRY_SOURCE);
  const module = { id: ROUTE, filePath };
  const assets = native ? { [NATIVE_ASSET]: path.join(directory, 'addon.node') } : {};
  const route: RouteCode = {
    id: ROUTE,
    kind: 'app-page',
    module,
    edge: undefined,
    chunks: [],
    wasm: [],
    assets,
  };
  return {
    // This entry-level fixture supplies only the BuildContext fields the real assembly reads.
    ctx: {
      projectDir: directory,
      repoRoot: directory,
      distDir: path.join(directory, '.next'),
      config: { basePath: '' },
    } as unknown as BuildContext,
    outDir,
    blobs,
    cacheHostModule: undefined,
    sourceMaps: undefined,
    keptMaps: undefined,
    manifests: [],
    hook: { file: undefined, chunks: [], wasm: [], assets: {} },
    cacheHandlers: undefined,
    middleware: { output: undefined, node: [], edge: [], chunks: [], wasm: [] },
    modules: [module],
    chunks: [],
    wasm: [],
    edgeEntries: [],
    routes: [route],
    shipped: [],
    staticBlobs: [],
    files: { app: [], middleware: [] },
    workflowSdk: false,
    previewData: false,
  };
}

async function refused(context: FunctionsContext): Promise<AuditError> {
  try {
    await buildAppFunction(context, '{}', undefined, false);
  } catch (error) {
    if (error instanceof AuditError) return error;
    throw error;
  }
  throw new Error('The authored dynamic loader was unexpectedly admitted');
}

async function placementInput(directory: string, kind: FunctionKind, fallbackOnly = false) {
  const context = await contextOf(directory, true);
  const filePath = context.modules[0]?.filePath;
  if (filePath === undefined) throw new Error('Expected the authored entry');
  const binary = path.join(directory, 'addon.node');
  await writeFile(binary, new Uint8Array([0, 1, 2]));
  const nativeSource = fallbackOnly
    ? "const {Worker}=require('node:worker_threads');try{exports.handler=new Worker('source',{eval:true});}catch{exports.handler=()=>42;}"
    : "const addon=require('./addon.node');exports.handler=()=>addon;";
  await writeFile(filePath, nativeSource);
  const input = await appFunctionInput(context, '{}', undefined, false);
  const nativeTrace = { id: ROUTE, assets: { entry: filePath, binary } };
  if (fallbackOnly) return { ...input, kind, entryTraces: [nativeTrace] };
  const worker = path.join(directory, 'worker.cjs');
  await writeFile(
    worker,
    "const {Worker}=require('node:worker_threads');exports.handler=()=>new Worker('source',{eval:true});",
  );
  return {
    ...input,
    kind,
    entries: [...input.entries, { id: '/worker', filePath: worker }],
    entryTraces: [nativeTrace, { id: '/worker', assets: { entry: worker } }],
  };
}

describe('native trace context through real app Function assembly', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upwind-native-trace-integration-'));
    vi.mocked(bundleRuntimeModule).mockClear();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('passes the owned route trace through buildAppFunction to the real audit refusal', async () => {
    const context = await contextOf(directory, true);
    const failure = await refused(context);

    expect(failure.cause).toBeInstanceOf(AuditError);
    expect(failure.message).toContain(ORIGINAL_REFUSAL);
    expect(failure.message).toContain('binary');
    expect(failure.message).toContain(NATIVE_CONTEXT);
    expect(failure.message).toContain(`"${ROUTE}": "${NATIVE_ASSET}"`);
    expect(bundleRuntimeModule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'app', name: 'app', edge: false, wasm: false }),
    );
  });

  it('preserves the same real audit refusal when no retained route traces a native addon', async () => {
    const context = await contextOf(directory, false);
    const failure = await refused(context);

    expect(failure.cause).toBeUndefined();
    expect(failure.message).toContain(ORIGINAL_REFUSAL);
    expect(failure.message).toContain('binary');
    expect(failure.message).not.toContain(NATIVE_CONTEXT);
    expect(bundleRuntimeModule).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'app', name: 'app', edge: false, wasm: false }),
    );
  });

  it('returns a native placement error before publishing an aggregate app Worker artifact', async () => {
    const input = await placementInput(directory, 'app');

    await expect(buildFunction(input)).rejects.toBeInstanceOf(NativeFunctionRequiredError);
  });

  it.each(['middleware', 'workflow'] as const)(
    'does not grant aggregate placement deferral to the %s Function',
    async (kind) => {
      const input = await placementInput(directory, kind);

      await expect(buildFunction(input)).rejects.toThrow('Node Worker');
    },
  );

  it('publishes a marker-free ordinary Worker for a plain fallback with build-only native assets', async () => {
    const input = await placementInput(directory, 'app', true);
    const built = await buildFunction(input);
    const appFile = path.join(input.outDir, 'work', 'app-app.cjs');
    const code = await readFile(appFile, 'utf8');

    expect(built.spec.mainModule).toBe('index.mjs');
    expect(code).not.toContain('__UPWIND_NATIVE_');
    expect(code).toContain('Worker');
  });
});
