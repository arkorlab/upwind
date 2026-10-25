import { isNodeContainerFunction, type FunctionModule } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appFunctionsOf, type FunctionsContext } from '../src/app-functions.ts';
import { BlobStore } from '../src/blobs.ts';
import type { BuildContext, RouteCode, ShippedBlob } from '../src/collect.ts';
import { AuditError, auditFunctionSize, type FunctionSize } from '../src/dependencies.ts';
import { buildFunction, type BuildFunctionInput, type BuiltFunction } from '../src/function.ts';
import { NativeFunctionRequiredError } from '../src/native-loads.ts';
import { buildNodeFunction, type NodeBuiltFunction } from '../src/node-function.ts';

vi.mock(import('../src/function.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildFunction: vi.fn<typeof actual.buildFunction>() };
});
vi.mock(import('../src/node-function.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildNodeFunction: vi.fn<typeof actual.buildNodeFunction>() };
});

const MIB = 1024 * 1024;
const WORKER_CODE = 62 * MIB;
const NODE_ARCHIVE = 128 * MIB;
function body(digit: string, bytes: number, route: string): ShippedBlob {
  return { sha256: digit.repeat(64), bytes: new Uint8Array(bytes), routes: [route] };
}
const SMALL = body('a', MIB / 2, '/worker');
const LARGE = [body('b', 2 * MIB, '/worker'), body('c', 2 * MIB, '/worker')];
const NATIVE_BODY = body('d', 2 * MIB, '/native');
const ALL = [SMALL, ...LARGE, NATIVE_BODY];
const MANIFEST = {
  v: 3,
  entrypoints: [
    { id: '/native', pathname: '/native', kind: 'app-route' as const },
    { id: '/worker', pathname: '/worker', kind: 'app-route' as const },
  ],
  prerenders: [],
};

function dependencies(size: FunctionSize): BuiltFunction['dependencies'] {
  return {
    buildOutput: [],
    packages: {},
    other: [],
    externals: [],
    stubs: [],
    patches: [],
    dynamicRequires: [],
    wasmModules: [],
    modules: [],
    size,
  };
}

function worker(input: BuildFunctionInput): Promise<BuiltFunction> {
  if (input.entries.some((entry) => entry.id === '/native'))
    throw new NativeFunctionRequiredError([
      {
        kind: 'direct',
        importer: '/project/native.js',
        binary: '/project/addon.node',
        owners: ['/native'],
      },
    ]);
  const module: FunctionModule = {
    name: 'app.cjs',
    type: 'commonjs',
    blob: { sha256: '0'.repeat(64), byteLength: WORKER_CODE, contentType: 'text/javascript' },
  };
  const modules = [
    module,
    ...input.blobs.map((blob): FunctionModule => {
      return {
        name: `blobs/${blob.sha256}`,
        type: 'data',
        blob: {
          sha256: blob.sha256,
          byteLength: blob.bytes.byteLength,
          contentType: 'application/octet-stream',
        },
      };
    }),
  ];
  const size = {
    bytes: modules.reduce((sum, item) => sum + item.blob.byteLength, 0),
    gzipBytes: 0,
  };
  auditFunctionSize('app', { modules, size }, input.deferSizeAudit === true);
  return Promise.resolve({
    spec: {
      mainModule: 'app.cjs',
      modules,
      compatibilityDate: '2026-09-15',
      compatibilityFlags: [],
    },
    dependencies: dependencies(size),
    sourceMaps: [],
    inputs: [],
  });
}

function node(): Promise<NodeBuiltFunction> {
  return Promise.resolve({
    spec: {
      runtime: 'node-container',
      artifact: {
        sha256: 'f'.repeat(64),
        byteLength: NODE_ARCHIVE,
        contentType: 'application/gzip',
      },
      entrypoint: 'upwind/server.mjs',
      abi: {
        nodeVersion: '24.22.1',
        nodeAbi: '137',
        platform: 'linux',
        arch: 'x64',
        libc: 'glibc',
      },
    },
    dependencies: dependencies({ bytes: NODE_ARCHIVE, gzipBytes: NODE_ARCHIVE }),
    sourceMaps: [],
    inputs: [],
  });
}

function route(id: string): RouteCode {
  return {
    id,
    kind: 'app-route',
    module: { id, filePath: `/project${id}.js` },
    edge: undefined,
    chunks: [],
    wasm: [],
    assets: {},
  };
}

function context(
  shipped: readonly ShippedBlob[],
  fallback: (() => Promise<readonly ShippedBlob[]>) | undefined,
): FunctionsContext {
  const routes = [route('/native'), route('/worker')];
  return {
    ctx: {
      projectDir: '/project',
      repoRoot: '/project',
      distDir: '/project/.next',
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
    modules: routes.flatMap((entry) => (entry.module === undefined ? [] : [entry.module])),
    chunks: [],
    wasm: [],
    edgeEntries: [],
    routes,
    shipped,
    staticBlobs: [],
    files: { app: [], middleware: [] },
    workflowSdk: false,
    previewData: false,
    requireBundleBlobReader: false,
    shippedOverLimit: fallback,
  };
}

function summary(input: BuildFunctionInput) {
  return {
    blobs: input.blobs.map((blob) => blob.sha256),
    reader: input.requireBundleBlobReader,
    deferred: input.deferSizeAudit === true,
    cacheHost: input.cacheHostModule,
  };
}

describe('mixed native and Worker prerender body limits', () => {
  beforeEach(() => {
    vi.mocked(buildFunction).mockReset().mockImplementation(worker);
    vi.mocked(buildNodeFunction).mockReset().mockImplementation(node);
    vi.spyOn(console, 'log').mockImplementation(vi.fn());
    vi.spyOn(console, 'warn').mockImplementation(vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { label: 'automatic', budget: undefined },
    { label: 'bounded', budget: { maxBytes: 64 * MIB, maxCodeBytes: 64 * MIB } },
  ])(
    'retries $label placement with selected bodies and reader in both final backends',
    async ({ budget }) => {
      const fallback = vi.fn(() => Promise.resolve([SMALL]));
      const built = await appFunctionsOf(context(ALL, fallback), MANIFEST, budget);
      const workers = vi
        .mocked(buildFunction)
        .mock.calls.map(([input]) => input)
        .filter((input) => !input.entries.some((entry) => entry.id === '/native'));
      const first = workers[0];
      const final = workers.at(-1);
      const native = vi.mocked(buildNodeFunction).mock.calls.at(-1)?.[0];
      if (first === undefined || final === undefined || native === undefined)
        throw new Error('Missing mixed layout inputs');
      const workerSpec = built.built.find((entry) => !isNodeContainerFunction(entry.built.spec));

      expect(summary(first)).toStrictEqual({
        blobs: [SMALL, ...LARGE].map((blob) => blob.sha256),
        reader: false,
        deferred: true,
        cacheHost: '/host/cache.mjs',
      });
      expect({ worker: summary(final), native: summary(native) }).toStrictEqual({
        worker: {
          blobs: [SMALL.sha256],
          reader: true,
          deferred: false,
          cacheHost: '/host/cache.mjs',
        },
        native: { blobs: [], reader: true, deferred: false, cacheHost: '/host/cache.mjs' },
      });
      expect({
        left: built.bodiesLeftOut,
        workerBytes: workerSpec?.built.dependencies.size.bytes,
        nativeCount: built.built.filter((entry) => isNodeContainerFunction(entry.built.spec))
          .length,
      }).toStrictEqual({
        left: { count: 3, bytes: 6 * MIB },
        workerBytes: WORKER_CODE + SMALL.bytes.byteLength,
        nativeCount: 1,
      });
      expect(fallback).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('does not apply the Worker module limit to a larger Node archive', async () => {
    const fallback = vi.fn(() => Promise.resolve([]));
    const built = await appFunctionsOf(
      context([SMALL, NATIVE_BODY], fallback),
      MANIFEST,
      undefined,
    );

    expect({
      left: built.bodiesLeftOut,
      count: built.built.length,
      nodeBytes: built.built.find((entry) => isNodeContainerFunction(entry.built.spec))?.built
        .dependencies.size.bytes,
    }).toStrictEqual({ left: undefined, count: 2, nodeBytes: NODE_ARCHIVE });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('still refuses an oversized Worker when no body omission is configured', async () => {
    const built = appFunctionsOf(context(ALL, undefined), MANIFEST, undefined);

    await expect(built).rejects.toBeInstanceOf(AuditError);
    await expect(built).rejects.toThrow('66.5 MiB, over the 64.0 MiB limit');
  });
});
