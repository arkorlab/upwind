import type { FunctionModule } from '@stayingupwind/core/bundle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appFunctionsOf, type FunctionsContext } from '../src/app-functions.ts';
import { BlobStore } from '../src/blobs.ts';
import type { BuildContext, ShippedBlob } from '../src/collect.ts';
import { AuditError, auditFunctionSize } from '../src/dependencies.ts';
import { buildFunction, type BuildFunctionInput, type BuiltFunction } from '../src/function.ts';

/**
 * The app Functions of a build that left its large page bodies to the limit, as `appFunctionsOf`
 * hands them to `buildFunction`: what each layout ships, whether the runtime links the host's reader,
 * and whether the size is audited as the Function is made. Bundling itself is not the question, so
 * `buildFunction` is replaced by one that weighs what it is given and audits it as the real one does.
 */

vi.mock(import('../src/function.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildFunction: vi.fn<typeof actual.buildFunction>() };
});

const MIB = 1024 * 1024;
const CODE_BYTES = 62 * MIB;

function shippedBlob(digit: string, byteLength: number): ShippedBlob {
  return { sha256: digit.repeat(64), bytes: new Uint8Array(byteLength), routes: ['/page'] };
}

const SMALL = shippedBlob('a', MIB / 2);
const EVERY = [SMALL, shippedBlob('b', 2 * MIB), shippedBlob('c', 2 * MIB)];
const MANIFEST = { v: 1, entrypoints: [], prerenders: [] };

function dataModule(name: string, byteLength: number): FunctionModule {
  return {
    name,
    type: 'data',
    blob: { sha256: '0'.repeat(64), byteLength, contentType: 'application/octet-stream' },
  };
}

/** A module as the dependency record lists it. */
function recorded(module: FunctionModule): { name: string; type: string; bytes: number } {
  return { name: module.name, type: module.type, bytes: module.blob.byteLength };
}

/** A Function of `CODE_BYTES` of code and the blobs it is handed, audited as `buildFunction` is. */
function weighed(input: BuildFunctionInput): Promise<BuiltFunction> {
  const name = input.name ?? input.kind;
  const modules = [
    dataModule(`${name}.cjs`, CODE_BYTES),
    ...input.blobs.map((blob) => dataModule(`blobs/${blob.sha256}`, blob.bytes.byteLength)),
  ];
  const size = {
    bytes: modules.reduce((total, module) => total + module.blob.byteLength, 0),
    gzipBytes: 0,
  };
  auditFunctionSize(name, { modules, size }, input.deferSizeAudit === true);
  return Promise.resolve({
    spec: {
      mainModule: 'index.mjs',
      modules,
      compatibilityDate: '2026-09-15',
      compatibilityFlags: [],
    },
    dependencies: {
      buildOutput: [],
      packages: {},
      other: [],
      externals: [],
      stubs: [],
      patches: [],
      dynamicRequires: [],
      wasmModules: [],
      modules: modules.map((module) => recorded(module)),
      size,
    },
    sourceMaps: [],
    inputs: [],
  });
}

/** A build with no route of its own to bundle: only the blobs decide what its Function weighs. */
function functionsContext(
  layout: Partial<
    Pick<FunctionsContext, 'shipped' | 'requireBundleBlobReader' | 'shippedOverLimit'>
  >,
): FunctionsContext {
  return {
    ctx: {
      projectDir: '/project',
      distDir: '/project/.next',
      repoRoot: '/project',
      config: { basePath: '' },
    } as unknown as BuildContext,
    outDir: '/project/.arkor',
    blobs: new BlobStore('/project/.arkor'),
    cacheHostModule: '/host/cache.mjs',
    sourceMaps: undefined,
    keptMaps: undefined,
    manifests: [],
    hook: { file: undefined, chunks: [], wasm: [], assets: {} },
    cacheHandlers: undefined,
    middleware: { output: undefined, node: [], edge: [], chunks: [], wasm: [] },
    modules: [],
    chunks: [],
    wasm: [],
    edgeEntries: [],
    routes: [],
    shipped: EVERY,
    staticBlobs: [],
    files: { app: [], middleware: [] },
    workflowSdk: false,
    previewData: false,
    ...layout,
  };
}

/** What each Function was built from, in the order it was built. */
function builds(): { blobs: string[]; reader: boolean | undefined; deferred: boolean }[] {
  return vi.mocked(buildFunction).mock.calls.map(([input]) => {
    return {
      blobs: input.blobs.map((blob) => blob.sha256),
      reader: input.requireBundleBlobReader,
      deferred: input.deferSizeAudit === true,
    };
  });
}

describe('app Functions with large page bodies left to the limit', () => {
  beforeEach(() => {
    vi.mocked(buildFunction).mockReset().mockImplementation(weighed);
  });

  it('builds a build with nothing left to the limit once, audited as it is made', async () => {
    const built = appFunctionsOf(
      functionsContext({ requireBundleBlobReader: false }),
      MANIFEST,
      undefined,
    );

    await expect(built).rejects.toBeInstanceOf(AuditError);
    await expect(built).rejects.toThrow(
      /the app server bundle is 66\.5 MiB, over the 64\.0 MiB limit/u,
    );
    expect(builds()).toStrictEqual([
      { blobs: EVERY.map((blob) => blob.sha256), reader: false, deferred: false },
    ]);
  });

  it('builds a build within the limit once, as the build without the option', async () => {
    const fallback = vi.fn(() => Promise.resolve([]));
    const shipped = [SMALL];
    const functions = await appFunctionsOf(
      functionsContext({ shipped, requireBundleBlobReader: false, shippedOverLimit: fallback }),
      MANIFEST,
      undefined,
    );
    const first = builds();
    const without = await appFunctionsOf(
      functionsContext({ shipped, requireBundleBlobReader: false }),
      MANIFEST,
      undefined,
    );

    expect(first).toStrictEqual([{ blobs: [SMALL.sha256], reader: false, deferred: true }]);
    expect(functions).toStrictEqual(without);
    expect(functions).not.toHaveProperty('bodiesLeftOut');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('builds the Function again without the large bodies, linking the host reader', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    const functions = await appFunctionsOf(
      functionsContext({
        requireBundleBlobReader: false,
        shippedOverLimit: () => Promise.resolve([SMALL]),
      }),
      MANIFEST,
      undefined,
    );

    expect(builds()).toStrictEqual([
      { blobs: EVERY.map((blob) => blob.sha256), reader: false, deferred: true },
      { blobs: [SMALL.sha256], reader: true, deferred: false },
    ]);
    expect(functions.built.map(({ name }) => name)).toStrictEqual(['app']);
    expect(functions.built[0]?.built.dependencies.size.bytes).toBe(
      CODE_BYTES + SMALL.bytes.byteLength,
    );
    expect(functions.bodiesLeftOut).toStrictEqual({ count: 2, bytes: 4 * MIB });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('left in bundle storage'));

    log.mockRestore();
  });

  it('weighs a build that cannot be split, rather than refusing it, before leaving bodies out', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    const warn = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
    const functions = await appFunctionsOf(
      functionsContext({
        requireBundleBlobReader: false,
        shippedOverLimit: () => Promise.resolve([SMALL]),
      }),
      MANIFEST,
      { maxBytes: 40 * MIB, maxCodeBytes: 20 * MIB },
    );

    expect(builds()).toStrictEqual([
      { blobs: EVERY.map((blob) => blob.sha256), reader: false, deferred: true },
      { blobs: [SMALL.sha256], reader: true, deferred: true },
    ]);
    expect(functions.plan).toBeUndefined();
    expect(functions.bodiesLeftOut).toStrictEqual({ count: 2, bytes: 4 * MIB });
    expect(warn).toHaveBeenCalledTimes(2);

    log.mockRestore();
    warn.mockRestore();
  });
});
