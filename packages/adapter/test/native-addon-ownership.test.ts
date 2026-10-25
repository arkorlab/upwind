import type { AdapterOutput } from 'next';
import { INSTRUMENTATION_HOOK_FILENAME } from 'next/dist/lib/constants.js';
import { AdapterOutputType } from 'next/dist/shared/lib/constants.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAppFunction,
  buildMiddlewareFunction,
  type FunctionsContext,
  type MiddlewareParts,
} from '../src/app-functions.ts';
import { BlobStore } from '../src/blobs.ts';
import type { BuildContext, RouteCode } from '../src/collect.ts';
import { AuditError } from '../src/dependencies.ts';
import { buildFunction, type BuildFunctionInput } from '../src/function.ts';
import { nativeAddonAuditError } from '../src/native-addons.ts';

/** Hold assembly at its existing bundler boundary: these assertions concern owned inputs alone. */
vi.mock(import('../src/function.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, buildFunction: vi.fn<typeof original.buildFunction>() };
});

const REFUSAL = new AuditError('the original graph audit refusal');
const MIDDLEWARE = '/_middleware';
const MIDDLEWARE_ASSETS = { 'node_modules/middleware/addon.node': '/project/middleware.node' };
const HOOK_FILE = '/project/.next/server/instrumentation.js';
const HOOK_ASSETS = { 'node_modules/instrumentation/addon.node': '/project/instrumentation.node' };

function route(id: string): RouteCode {
  return {
    id,
    kind: 'app-page',
    module: { id, filePath: `/project/.next/server/app${id}/page.js` },
    edge: undefined,
    chunks: [],
    wasm: [],
    assets: { [`node_modules${id}/addon.node`]: `/project${id}.node` },
  };
}

/** Both middleware runtimes carry the same trace through their own, different entry graph. */
function middleware(runtime: 'edge' | 'nodejs'): MiddlewareParts {
  const filePath = '/project/.next/server/middleware.js';
  const output: AdapterOutput['MIDDLEWARE'] = {
    id: MIDDLEWARE,
    type: AdapterOutputType.MIDDLEWARE,
    pathname: MIDDLEWARE,
    sourcePage: '/middleware',
    runtime,
    filePath,
    assets: MIDDLEWARE_ASSETS,
    assetsHashes: {},
    config: { matchers: [] },
  };
  return {
    output,
    node: runtime === 'nodejs' ? [{ id: MIDDLEWARE, filePath }] : [],
    edge:
      runtime === 'edge'
        ? [
            {
              id: MIDDLEWARE,
              entryKey: 'middleware',
              handlerExport: 'handler',
              files: [],
              wasm: [],
              inlineAssets: [],
              env: {},
            },
          ]
        : [],
    chunks: [],
    wasm: [],
  };
}

function contextOf(parts: MiddlewareParts): FunctionsContext {
  const routes = [route('/owned'), route('/elsewhere')];
  return {
    ctx: {
      projectDir: '/project',
      repoRoot: '/project',
      distDir: '/project/.next',
      config: { basePath: '' },
    } as unknown as BuildContext,
    outDir: '/project/.upwind',
    blobs: new BlobStore('/project/.upwind'),
    cacheHostModule: undefined,
    sourceMaps: undefined,
    keptMaps: undefined,
    manifests: [],
    hook: { file: undefined, chunks: [], wasm: [], assets: {} },
    cacheHandlers: undefined,
    middleware: parts,
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

function observed(): Pick<BuildFunctionInput, 'kind' | 'entries' | 'edgeEntries' | 'entryTraces'> {
  const input = vi.mocked(buildFunction).mock.calls[0]?.[0];
  if (input === undefined) throw new Error('no Function was assembled');
  return {
    kind: input.kind,
    entries: input.entries,
    edgeEntries: input.edgeEntries,
    entryTraces: input.entryTraces,
  };
}

function inputAt(index: number): BuildFunctionInput {
  const input = vi.mocked(buildFunction).mock.calls[index]?.[0];
  if (input === undefined) throw new Error('no Function was assembled');
  return input;
}

function middlewareWithoutAssets(runtime: 'edge' | 'nodejs'): MiddlewareParts {
  const parts = middleware(runtime);
  if (parts.output === undefined) throw new Error('no middleware output');
  return { ...parts, output: { ...parts.output, assets: {} } };
}

function buildWithoutHook(
  context: FunctionsContext,
  kind: 'app' | 'middleware',
): ReturnType<typeof buildMiddlewareFunction> {
  return kind === 'app'
    ? buildAppFunction(context, '{}', { name: 'app-2', routes: new Set(['/owned']) }, false)
    : buildMiddlewareFunction(context, '{}');
}

function tracesWithoutHook(
  context: FunctionsContext,
  kind: 'app' | 'middleware',
): NonNullable<BuildFunctionInput['entryTraces']> {
  return kind === 'app'
    ? [context.routes[0]!, { id: MIDDLEWARE, assets: MIDDLEWARE_ASSETS }]
    : [{ id: MIDDLEWARE, assets: MIDDLEWARE_ASSETS }];
}

describe('native diagnostic trace ownership during Function assembly', () => {
  beforeEach(() => {
    vi.mocked(buildFunction).mockReset().mockRejectedValue(REFUSAL);
  });

  it.each(['nodejs', 'edge'] as const)(
    'carries only the %s middleware trace in its own Function',
    async (runtime) => {
      const parts = middleware(runtime);
      const context = contextOf(parts);

      await expect(buildMiddlewareFunction(context, '{}')).rejects.toBe(REFUSAL);
      expect(observed()).toStrictEqual({
        kind: 'middleware',
        entries: parts.node,
        edgeEntries: parts.edge,
        entryTraces: [{ id: MIDDLEWARE, assets: MIDDLEWARE_ASSETS }],
      });
    },
  );

  it.each(['nodejs', 'edge'] as const)(
    'keeps the %s middleware trace beside only a split app Function’s owned routes',
    async (runtime) => {
      const parts = middleware(runtime);
      const context = contextOf(parts);
      const owned = context.routes[0]!;

      await expect(
        buildAppFunction(context, '{}', { name: 'app-2', routes: new Set(['/owned']) }, false),
      ).rejects.toBe(REFUSAL);
      expect(observed()).toStrictEqual({
        kind: 'app',
        entries: [...(owned.module === undefined ? [] : [owned.module]), ...parts.node],
        edgeEntries: parts.edge,
        entryTraces: [owned, { id: MIDDLEWARE, assets: MIDDLEWARE_ASSETS }],
      });
    },
  );

  it('keeps every route for an unsplit app and adds no absent middleware', async () => {
    const context = contextOf({ output: undefined, node: [], edge: [], chunks: [], wasm: [] });

    await expect(buildAppFunction(context, '{}', undefined, false)).rejects.toBe(REFUSAL);
    expect(observed().entryTraces).toStrictEqual(context.routes);
  });

  it('assembles no middleware Function when the build has no middleware', async () => {
    const context = contextOf({ output: undefined, node: [], edge: [], chunks: [], wasm: [] });

    await expect(buildMiddlewareFunction(context, '{}')).resolves.toBeUndefined();
    expect(buildFunction).not.toHaveBeenCalled();
  });

  it.each(['nodejs', 'edge'] as const)(
    'attributes hook-only native traces to the app and %s middleware that carry the hook',
    async (runtime) => {
      const base = contextOf(middlewareWithoutAssets(runtime));
      const context: FunctionsContext = {
        ...base,
        routes: base.routes.map((entry) => ({ ...entry, assets: {} })),
        hook: { file: HOOK_FILE, chunks: [], wasm: [], assets: HOOK_ASSETS },
      };
      const own = context.routes[0]!;

      await expect(
        buildAppFunction(context, '{}', { name: 'app-2', routes: new Set(['/owned']) }, false),
      ).rejects.toBe(REFUSAL);

      await expect(buildMiddlewareFunction(context, '{}')).rejects.toBe(REFUSAL);

      const app = inputAt(0);
      const middlewareInput = inputAt(1);
      const hook = { id: INSTRUMENTATION_HOOK_FILENAME, assets: HOOK_ASSETS };

      expect({
        appHook: app.patch.instrumentation,
        appTraces: app.entryTraces,
        middlewareHook: middlewareInput.patch.instrumentation,
        middlewareTraces: middlewareInput.entryTraces,
      }).toStrictEqual({
        appHook: HOOK_FILE,
        appTraces: [own, { id: MIDDLEWARE, assets: {} }, hook],
        middlewareHook: HOOK_FILE,
        middlewareTraces: [{ id: MIDDLEWARE, assets: {} }, hook],
      });

      const appFailure = nativeAddonAuditError(REFUSAL, app.entryTraces ?? []);
      const middlewareFailure = nativeAddonAuditError(REFUSAL, middlewareInput.entryTraces ?? []);
      const tracedHook = '"instrumentation": "node_modules/instrumentation/addon.node"';

      expect({ app: appFailure.cause, middleware: middlewareFailure.cause }).toStrictEqual({
        app: REFUSAL,
        middleware: REFUSAL,
      });

      expect({
        app: appFailure.message.includes(tracedHook),
        middleware: middlewareFailure.message.includes(tracedHook),
      }).toStrictEqual({ app: true, middleware: true });
    },
  );

  it.each(['app', 'middleware'] as const)(
    'does not attribute leftover hook assets to the %s Function when no hook is carried',
    async (kind) => {
      const context: FunctionsContext = {
        ...contextOf(middleware('nodejs')),
        hook: { file: undefined, chunks: [], wasm: [], assets: HOOK_ASSETS },
      };

      await expect(buildWithoutHook(context, kind)).rejects.toBe(REFUSAL);

      const input = inputAt(0);
      const traces = tracesWithoutHook(context, kind);

      expect(input.patch.instrumentation).toBeUndefined();

      expect(input.entryTraces).toStrictEqual(traces);

      expect(nativeAddonAuditError(REFUSAL, input.entryTraces ?? []).message).not.toContain(
        'node_modules/instrumentation/addon.node',
      );
    },
  );
});
