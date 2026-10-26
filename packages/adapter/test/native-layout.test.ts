import { isNodeContainerFunction, MAX_APP_FUNCTIONS } from '@stayingupwind/core/bundle';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { layOutAppFunctions, type FunctionsContext } from '../src/app-functions.ts';
import { BlobStore } from '../src/blobs.ts';
import type { BuildContext, RouteCode } from '../src/collect.ts';
import { auditFunctionSize } from '../src/dependencies.ts';
import { buildFunction, type BuildFunctionInput, type BuiltFunction } from '../src/function.ts';
import { nativeFunctionLayout, nativeRouteOwners } from '../src/native-layout.ts';
import type { NativeLoad } from '../src/native-loads.ts';
import { buildNodeFunction, type NodeBuiltFunction } from '../src/node-function.ts';

vi.mock(import('../src/function.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildFunction: vi.fn<typeof actual.buildFunction>() };
});
vi.mock(import('../src/node-function.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildNodeFunction: vi.fn<typeof actual.buildNodeFunction>() };
});

const KIB = 1024;
const WORKER_ROUTE_BYTES = 100 * KIB;
const BUDGET = { maxBytes: 16 * KIB * KIB, maxCodeBytes: 150 * KIB };

function dependencies(bytes: number): BuiltFunction['dependencies'] {
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
    size: { bytes, gzipBytes: 0 },
  };
}

/** Inert code weights use the real split planner; no native bytes or handler are executed. */
function worker(input: BuildFunctionInput): Promise<BuiltFunction> {
  const bytes = input.entries.length * WORKER_ROUTE_BYTES;
  const spec: BuiltFunction['spec'] = {
    mainModule: 'app.cjs',
    modules: [
      {
        name: 'app.cjs',
        type: 'commonjs',
        blob: { sha256: '0'.repeat(64), byteLength: bytes, contentType: 'text/javascript' },
      },
    ],
    compatibilityDate: '2026-09-15',
    compatibilityFlags: [],
  };
  const own = dependencies(bytes);
  auditFunctionSize(
    input.name ?? 'app',
    { modules: spec.modules, size: own.size },
    input.deferSizeAudit === true,
  );
  return Promise.resolve({
    spec,
    dependencies: own,
    sourceMaps: [],
    inputs: input.entries.map((entry) => ({ file: entry.filePath, bytes: WORKER_ROUTE_BYTES })),
  });
}

function node(): Promise<NodeBuiltFunction> {
  return Promise.resolve({
    spec: {
      runtime: 'node-container',
      artifact: { sha256: 'f'.repeat(64), byteLength: 1, contentType: 'application/gzip' },
      entrypoint: 'upwind/server.mjs',
      abi: {
        nodeVersion: '24.22.1',
        nodeAbi: '137',
        platform: 'linux',
        arch: 'x64',
        libc: 'glibc',
      },
    },
    dependencies: dependencies(1),
    sourceMaps: [],
    inputs: [],
  });
}

function context(routes: RouteCode[]): FunctionsContext {
  return {
    // The mocked builders and real planner read only these build-context fields.
    ctx: {
      projectDir: '/project',
      repoRoot: '/project',
      distDir: '/project/.next',
      config: { basePath: '' },
    } as unknown as BuildContext,
    outDir: '/project/.arkor',
    blobs: new BlobStore('/project/.arkor'),
    cacheHostModule: undefined,
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
    shipped: [],
    staticBlobs: [],
    files: { app: [], middleware: [] },
    workflowSdk: false,
    previewData: false,
  };
}

function manifest(routes: RouteCode[]) {
  return {
    v: 3,
    entrypoints: routes.map(({ id }) => ({ id, pathname: id, kind: 'app-route' as const })),
    prerenders: [],
  };
}

function route(id: string, kind: RouteCode['kind'] = 'app-route', file = id): RouteCode {
  return {
    id,
    kind,
    module: { id, filePath: file },
    edge: undefined,
    chunks: [],
    wasm: [],
    assets: {},
  };
}

function edgeRoute(kind: RouteCode['kind']): RouteCode {
  const id = '/edge';
  return {
    ...route(id, kind),
    module: undefined,
    edge: {
      id,
      entryKey: id,
      handlerExport: 'handler',
      files: [],
      wasm: [],
      inlineAssets: [],
      env: {},
    },
  };
}

function load(...owners: string[]): NativeLoad[] {
  return [
    { kind: 'direct', importer: '/project/loader.cjs', binary: '/project/addon.node', owners },
  ];
}

describe('native Function ownership', () => {
  it('keeps independent routes separate but preserves one shared built module', () => {
    const routes = [
      route('/native', 'app-route', 'shared.js'),
      route('/also-native', 'app-route', 'shared.js'),
      route('/worker'),
    ];

    expect([...nativeRouteOwners(routes, load('/native'), new Set())]).toStrictEqual([
      '/native',
      '/also-native',
    ]);
  });

  it('keeps the whole Pages Router and its revalidation API together', () => {
    const routes = [
      route('/blog/[slug]', 'pages'),
      route('/', 'pages'),
      route('/api/revalidate', 'pages-api'),
      route('/app'),
    ];

    expect([...nativeRouteOwners(routes, load('/blog/[slug]'), new Set())]).toStrictEqual([
      '/blog/[slug]',
      '/',
      '/api/revalidate',
    ]);
  });

  it.each(['pages', 'pages-api'] as const)(
    'keeps an independent Edge %s route outside the native Pages unit',
    (kind) => {
      const edge = edgeRoute(kind);
      const routes = [route('/blog', 'pages'), route('/api/revalidate', 'pages-api'), edge];

      expect([...nativeRouteOwners(routes, load('/blog'), new Set())]).toStrictEqual([
        '/blog',
        '/api/revalidate',
      ]);
      expect(edge.module).toBeUndefined();
      expect(edge.edge).toBeDefined();
    },
  );

  it('still refuses an explicit native requirement on an Edge route before building', async () => {
    const edge = edgeRoute('pages-api');

    await expect(
      nativeFunctionLayout(context([edge]), manifest([edge]), {
        budget: undefined,
        loads: load(edge.id),
        weighOnly: false,
      }),
    ).rejects.toThrow('move an Edge-runtime entrypoint');
  });

  it.each(['instrumentation', '/_middleware', '/_not-found'])(
    'attributes a native shared %s to every affected Function',
    (shared) => {
      const routes = [route('/native'), route('/worker'), route('/_not-found')];

      expect([
        ...nativeRouteOwners(routes, load(shared), new Set(['/_middleware', '/_not-found'])),
      ]).toStrictEqual(routes.map((entry) => entry.id));
    },
  );

  it('refuses a native load with an unrecognized owner', () => {
    expect(() => nativeRouteOwners([route('/worker')], load('unrecognized'), new Set())).toThrow(
      'unknown Function owner',
    );
  });
});

describe('native Function reserved layout', () => {
  beforeEach(() => {
    vi.mocked(buildFunction).mockReset().mockImplementation(worker);
    vi.mocked(buildNodeFunction).mockReset().mockImplementation(node);
  });

  it('passes computed trusted config to both final build backends without adding it to runtime data', async () => {
    const routes = [route('/worker'), route('/native')];
    const own = context(routes);
    const configured: FunctionsContext = {
      ...own,
      ctx: {
        ...own.ctx,
        config: { ...own.ctx.config, assetPrefix: 'https://cdn.example/assets///' },
      },
    };
    const built = await nativeFunctionLayout(configured, manifest(routes), {
      budget: undefined,
      loads: load('/native'),
      weighOnly: false,
    });

    expect(
      vi.mocked(buildFunction).mock.calls.map(([input]) => input.clientAssetPrefix),
    ).toStrictEqual(['https://cdn.example/assets/_next/', 'https://cdn.example/assets/_next/']);
    expect(
      vi.mocked(buildNodeFunction).mock.calls.map(([input]) => input.clientAssetPrefix),
    ).toStrictEqual(['https://cdn.example/assets/_next/']);
    expect(built.runtimeManifest).not.toHaveProperty('clientAssetPrefix');
  });

  it('replans exactly32 Worker clusters into31 before adding one sealed native owner', async () => {
    const workers = Array.from({ length: MAX_APP_FUNCTIONS }, (_, at) =>
      route(`/worker-${String(at).padStart(2, '0')}`),
    );
    const routes = [...workers, route('/native')];
    const built = await nativeFunctionLayout(context(routes), manifest(routes), {
      budget: BUDGET,
      loads: load('/native'),
      weighOnly: false,
    });
    const finalWorkers = vi
      .mocked(buildFunction)
      .mock.calls.slice(-(MAX_APP_FUNCTIONS - 1))
      .map(([input]) => input.entries.map((entry) => entry.id));

    expect(built.built).toHaveLength(MAX_APP_FUNCTIONS);
    expect(
      built.built
        .filter((item) => isNodeContainerFunction(item.built.spec))
        .map((item) => item.name),
    ).toStrictEqual([`app-${MAX_APP_FUNCTIONS}`]);
    expect(finalWorkers.flat().toSorted(compareCodeUnits)).toStrictEqual(
      workers.map((entry) => entry.id),
    );
    expect(finalWorkers.filter((ids) => ids.length === 2)).toHaveLength(1);
    expect(
      vi
        .mocked(buildNodeFunction)
        .mock.calls.map(([input]) => input.entries.map((entry) => entry.id)),
    ).toStrictEqual([['/native']]);
    expect(built.runtimeManifest.entrypoints).toContainEqual({
      id: '/native',
      pathname: '/native',
      kind: 'app-route',
      function: `app-${MAX_APP_FUNCTIONS}`,
    });
  });

  it.each([-1, MAX_APP_FUNCTIONS, 1.5, NaN, Infinity])(
    'refuses invalid reserved count %s before even an unsplit Worker build',
    async (reservedFunctions) => {
      const routes = [route('/worker')];

      await expect(
        layOutAppFunctions(context(routes), manifest(routes), undefined, {
          weighOnly: false,
          reservedFunctions,
        }),
      ).rejects.toThrow(RangeError);

      expect(buildFunction).not.toHaveBeenCalled();
    },
  );
});
