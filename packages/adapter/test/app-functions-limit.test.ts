import type { FunctionModule } from '@stayingupwind/core/bundle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppFunctions, appFunctionsOf, type FunctionsContext } from '../src/app-functions.ts';
import { BlobStore } from '../src/blobs.ts';
import type { BuildContext, RouteCode, ShippedBlob } from '../src/collect.ts';
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

function shippedBlob(digit: string, byteLength: number, route = '/page'): ShippedBlob {
  return { sha256: digit.repeat(64), bytes: new Uint8Array(byteLength), routes: [route] };
}

const SMALL = shippedBlob('a', MIB / 2);
const EVERY = [SMALL, shippedBlob('b', 2 * MIB), shippedBlob('c', 2 * MIB)];
const MANIFEST = { v: 1, entrypoints: [], prerenders: [] };

function functionModule(
  name: string,
  type: FunctionModule['type'],
  byteLength: number,
): FunctionModule {
  return {
    name,
    type,
    blob: { sha256: '0'.repeat(64), byteLength, contentType: 'application/octet-stream' },
  };
}

/** A module as the dependency record lists it. */
function recorded(module: FunctionModule): { name: string; type: string; bytes: number } {
  return { name: module.name, type: module.type, bytes: module.blob.byteLength };
}

/**
 * Functions of `codeBytes` of code each and the blobs they are handed, audited as `buildFunction`
 * audits them: as they are made, unless the caller defers it (`deferSizeAudit`).
 */
function weighedWith(codeBytes: number): (input: BuildFunctionInput) => Promise<BuiltFunction> {
  return (input) => weighed(input, codeBytes);
}

function weighed(input: BuildFunctionInput, codeBytes: number): Promise<BuiltFunction> {
  const name = input.name ?? input.kind;
  const modules = [
    functionModule(`${name}.cjs`, 'commonjs', codeBytes),
    ...input.blobs.map((blob) =>
      functionModule(`blobs/${blob.sha256}`, 'data', blob.bytes.byteLength),
    ),
  ];
  const size = {
    bytes: modules.reduce((total, module) => total + module.blob.byteLength, 0),
    gzipBytes: 0,
  };
  auditFunctionSize(name, { modules, size }, input.deferSizeAudit === true);
  return Promise.resolve(builtFunction(modules, size));
}

/** What `buildFunction` answers for those modules, as far as a layout reads it. */
function builtFunction(
  modules: FunctionModule[],
  size: { readonly bytes: number; readonly gzipBytes: number },
): BuiltFunction {
  return {
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
  };
}

/** A build with no route of its own to bundle: only the blobs decide what its Function weighs. */
function functionsContext(
  layout: Partial<
    Pick<FunctionsContext, 'routes' | 'shipped' | 'requireBundleBlobReader' | 'shippedOverLimit'>
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

/**
 * What each Function was built from, in the order it was built: its name, the bodies it carries,
 * whether its runtime links the host's reader, and whether its size was left to the caller.
 */
function builds(): {
  name: string;
  blobs: string[];
  reader: boolean | undefined;
  deferred: boolean;
}[] {
  return vi.mocked(buildFunction).mock.calls.map(([input]) => {
    return {
      name: input.name ?? input.kind,
      blobs: input.blobs.map((blob) => blob.sha256),
      reader: input.requireBundleBlobReader,
      deferred: input.deferSizeAudit === true,
    };
  });
}

/** What each Function that was made weighed, by its name, in the order it was built. */
function weights(): [string, number][] {
  const { calls, settledResults } = vi.mocked(buildFunction).mock;
  return settledResults.flatMap((result, at): [string, number][] => {
    const input = calls[at]?.[0];
    return input !== undefined && result.type === 'fulfilled'
      ? [[input.name ?? input.kind, result.value.dependencies.size.bytes]]
      : [];
  });
}

function digests(blobs: readonly ShippedBlob[]): string[] {
  return blobs.map((blob) => blob.sha256);
}

describe('app Functions with large page bodies left to the limit', () => {
  beforeEach(() => {
    vi.mocked(buildFunction).mockReset().mockImplementation(weighedWith(CODE_BYTES));
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
      { name: 'app', blobs: digests(EVERY), reader: false, deferred: false },
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

    expect(first).toStrictEqual([
      { name: 'app', blobs: [SMALL.sha256], reader: false, deferred: true },
    ]);
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
      { name: 'app', blobs: digests(EVERY), reader: false, deferred: true },
      { name: 'app', blobs: [SMALL.sha256], reader: true, deferred: false },
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
      { name: 'app', blobs: digests(EVERY), reader: false, deferred: true },
      { name: 'app', blobs: [SMALL.sha256], reader: true, deferred: true },
    ]);
    expect(functions.plan).toBeUndefined();
    expect(functions.bodiesLeftOut).toStrictEqual({ count: 2, bytes: 4 * MIB });
    expect(warn).toHaveBeenCalledTimes(2);

    log.mockRestore();
    warn.mockRestore();
  });
});

/** An App Router page with a module of its own: a unit the plan may place in any Function. */
function page(id: string): RouteCode {
  return {
    id,
    kind: 'app-page',
    module: { id, filePath: `/project/.next/server/app${id}/page.js` },
    edge: undefined,
    chunks: [],
    wasm: [],
    assets: {},
  };
}

/**
 * The budgets the routes below are split on. Each Function carries 1 MiB of code, `/a` 40 MiB of
 * bodies in every case and the other route at least 20 MiB: no two routes fit in one Function under
 * these budgets, so every plan below is two Functions, `app` holding `/a`.
 */
const BUDGET = { maxBytes: 50 * MIB, maxCodeBytes: 20 * MIB };
const ROUTE_CODE_BYTES = MIB;

/** The Functions a build kept, by name, with what each weighs. */
function sizes(functions: AppFunctions<unknown>): [string, number][] {
  return functions.built.map(({ name, built }) => [name, built.dependencies.size.bytes]);
}

/**
 * The same through a real plan (`planSplit`): routes the budgets keep apart, each with bodies of its
 * own, so that what decides is the Functions the plan makes rather than the one it weighed first.
 */
describe('split app Functions with large page bodies left to the limit', () => {
  beforeEach(() => {
    vi.mocked(buildFunction).mockReset().mockImplementation(weighedWith(ROUTE_CODE_BYTES));
  });

  it('keeps the bodies of a split whose every Function is within the limit', async () => {
    const fallback = vi.fn(() => Promise.resolve([]));
    const first = shippedBlob('1', 40 * MIB, '/a');
    const second = shippedBlob('2', 40 * MIB, '/b');
    const layout = { routes: [page('/a'), page('/b')], shipped: [first, second] };
    const functions = await appFunctionsOf(
      functionsContext({ ...layout, requireBundleBlobReader: false, shippedOverLimit: fallback }),
      MANIFEST,
      BUDGET,
    );
    const weighedOnly = { builds: builds(), weights: weights() };
    vi.mocked(buildFunction).mockClear();
    const without = await appFunctionsOf(
      functionsContext({ ...layout, requireBundleBlobReader: false }),
      MANIFEST,
      BUDGET,
    );

    // Weighed as one Function the application is past the limit, but neither Function of its plan
    // is, and those are what is uploaded: the bodies stay in them, as without the option.
    expect(weighedOnly.weights).toStrictEqual([
      ['app', 81 * MIB],
      ['app', 41 * MIB],
      ['app-2', 41 * MIB],
    ]);
    expect(weighedOnly.builds).toStrictEqual([
      { name: 'app', blobs: digests([first, second]), reader: false, deferred: true },
      { name: 'app', blobs: [first.sha256], reader: false, deferred: true },
      { name: 'app-2', blobs: [second.sha256], reader: false, deferred: true },
    ]);
    // Without the option, each Function of the plan is held to the limit as it is made.
    expect(builds()).toStrictEqual([
      { name: 'app', blobs: digests([first, second]), reader: false, deferred: true },
      { name: 'app', blobs: [first.sha256], reader: false, deferred: false },
      { name: 'app-2', blobs: [second.sha256], reader: false, deferred: false },
    ]);
    expect(sizes(functions)).toStrictEqual([
      ['app', 41 * MIB],
      ['app-2', 41 * MIB],
    ]);
    expect(functions).toStrictEqual(without);
    expect(functions).not.toHaveProperty('bodiesLeftOut');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('lays a split with a Function past the limit out again, without its large bodies', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    // What the range leaves out, all of it on `/big`; and what it does not, on either route.
    const large = ['2', '3', '4'].map((digit) => shippedBlob(digit, 25 * MIB, '/big'));
    const onA = shippedBlob('1', 40 * MIB, '/a');
    const onBig = shippedBlob('5', 20 * MIB, '/big');
    const functions = await appFunctionsOf(
      functionsContext({
        routes: [page('/a'), page('/big')],
        shipped: [onA, onBig, ...large],
        requireBundleBlobReader: false,
        shippedOverLimit: () => Promise.resolve([onA, onBig]),
      }),
      MANIFEST,
      BUDGET,
    );

    expect(builds()).toStrictEqual([
      { name: 'app', blobs: digests([onA, onBig, ...large]), reader: false, deferred: true },
      { name: 'app', blobs: [onA.sha256], reader: false, deferred: true },
      { name: 'app-2', blobs: digests([onBig, ...large]), reader: false, deferred: true },
      { name: 'app', blobs: digests([onA, onBig]), reader: true, deferred: true },
      { name: 'app', blobs: [onA.sha256], reader: true, deferred: false },
      { name: 'app-2', blobs: [onBig.sha256], reader: true, deferred: false },
    ]);
    expect(weights()).toStrictEqual([
      ['app', 136 * MIB],
      ['app', 41 * MIB],
      ['app-2', 96 * MIB],
      ['app', 61 * MIB],
      ['app', 41 * MIB],
      ['app-2', 21 * MIB],
    ]);
    expect(sizes(functions)).toStrictEqual([
      ['app', 41 * MIB],
      ['app-2', 21 * MIB],
    ]);
    expect(functions.bodiesLeftOut).toStrictEqual({ count: 3, bytes: 75 * MIB });
    expect(functions.plan).toMatchObject({
      functions: [
        { name: 'app', routes: ['/a'] },
        { name: 'app-2', routes: ['/big'] },
      ],
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('the app-2 server bundle is 96.0 MiB, over the 64.0 MiB limit.'),
    );

    log.mockRestore();
  });

  it('fails a split the range does not bring within the limit as before', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    const large = shippedBlob('2', 25 * MIB, '/big');
    const onA = shippedBlob('1', 40 * MIB, '/a');
    const onBig = shippedBlob('3', 70 * MIB, '/big');
    const built = appFunctionsOf(
      functionsContext({
        routes: [page('/a'), page('/big')],
        shipped: [onA, onBig, large],
        requireBundleBlobReader: false,
        shippedOverLimit: () => Promise.resolve([onA, onBig]),
      }),
      MANIFEST,
      BUDGET,
    );

    await expect(built).rejects.toBeInstanceOf(AuditError);
    await expect(built).rejects.toThrow(
      /^@stayingupwind\/adapter: the app-2 server bundle is 71\.0 MiB, over the 64\.0 MiB limit/u,
    );
    expect(builds().map(({ name, reader, deferred }) => [name, reader, deferred])).toStrictEqual([
      ['app', false, true],
      ['app', false, true],
      ['app-2', false, true],
      ['app', true, true],
      ['app', true, false],
      ['app-2', true, false],
    ]);
    // The last Function built, `app-2` at 71 MiB, is refused as it is made, so none is answered.
    expect(weights()).toStrictEqual([
      ['app', 136 * MIB],
      ['app', 41 * MIB],
      ['app-2', 96 * MIB],
      ['app', 111 * MIB],
      ['app', 41 * MIB],
    ]);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('1 completed page body (25.0 MiB) left in bundle storage'),
    );

    log.mockRestore();
  });
});
