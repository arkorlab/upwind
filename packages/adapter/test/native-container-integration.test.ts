import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { isNodeContainerFunction } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it } from 'vitest';

import { appFunctionsOf, type FunctionsContext } from '../src/app-functions.ts';
import { BlobStore } from '../src/blobs.ts';
import type { BuildContext, RouteCode } from '../src/collect.ts';

const execute = promisify(execFile);
const ENABLED = process.env['UPWIND_NATIVE_FUNCTION_INTEGRATION'] === '1';
const CONTROL = 'native-function-ci-control-token-0000000000000000000000';
const ADDRESS = 'http://127.0.0.1:8080';
const NAPI_SOURCE = `
#include <stddef.h>
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
extern int napi_create_string_utf8(napi_env, const char*, size_t, napi_value*);
extern int napi_set_named_property(napi_env, napi_value, const char*, napi_value);
__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value text;
  if (napi_create_string_utf8(env, "native-function-real", 20, &text) != 0) return NULL;
  if (napi_set_named_property(env, exports, "message", text) != 0) return NULL;
  return exports;
}
`;

function runtimeManifest(deploymentId: string) {
  return {
    v: 3,
    routerReferences: 'one-pass' as const,
    deploymentId,
    nextVersion: '16.4.3',
    buildId: 'native-ci',
    config: { basePath: '', trailingSlash: false, poweredByHeader: false },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'RSC',
        varyHeader:
          'RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch',
        prefetchHeader: 'Next-Router-Prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'Next-Router-Segment-Prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [
      { id: '/native', pathname: '/native', kind: 'app-route' as const },
      { id: '/worker', pathname: '/worker', kind: 'app-route' as const },
      { id: '/edge', pathname: '/edge', kind: 'app-route' as const, runtime: 'edge' as const },
    ],
    prerenders: [],
    staticFiles: [],
  };
}

async function contextOf(directory: string): Promise<FunctionsContext> {
  const distDir = path.join(directory, '.next');
  const outDir = path.join(directory, '.arkor');
  const server = path.join(distDir, 'server');
  await mkdir(server, { recursive: true });
  await writeFile(
    path.join(directory, 'package.json'),
    '{"name":"native-function-ci","version":"1.0.0"}\n',
  );
  const binary = path.join(server, 'addon.node');
  const source = path.join(directory, 'addon.c');
  await writeFile(source, NAPI_SOURCE);
  await execute('cc', ['-shared', '-fPIC', '-o', binary, source], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const native = path.join(server, 'native.cjs');
  const worker = path.join(server, 'worker.cjs');
  const edgeFile = path.join(server, 'edge.js');
  await writeFile(
    native,
    "const loaded={routeModule:{distDir:'original-build-location'},handler:async(_req,res)=>{const addon=require('./addon.node');res.setHeader('content-type','text/plain');res.setHeader('x-native-dist',loaded.routeModule.distDir);res.end(addon.message)}};module.exports=Promise.resolve(loaded);\n",
  );
  await writeFile(worker, "exports.handler=async(_req,res)=>{res.end('worker-only')};\n");
  await writeFile(
    edgeFile,
    "globalThis._ENTRIES??={};globalThis._ENTRIES.edge_route={handler:async()=>new Response('edge-only')};\n",
  );
  const edge = {
    id: '/edge',
    entryKey: 'edge_route',
    handlerExport: 'handler',
    files: [edgeFile],
    wasm: [],
    inlineAssets: [],
    env: {},
  };
  const routes: RouteCode[] = [
    {
      id: '/native',
      kind: 'app-route',
      module: { id: '/native', filePath: native },
      edge: undefined,
      chunks: [],
      wasm: [],
      assets: { '.next/server/native.cjs': native, '.next/server/addon.node': binary },
    },
    {
      id: '/worker',
      kind: 'app-route',
      module: { id: '/worker', filePath: worker },
      edge: undefined,
      chunks: [],
      wasm: [],
      assets: { '.next/server/worker.cjs': worker },
    },
    {
      id: '/edge',
      kind: 'app-route',
      module: undefined,
      edge,
      chunks: [],
      wasm: [],
      assets: { '.next/server/edge.js': edgeFile },
    },
  ];
  const blobs = new BlobStore(outDir);
  await blobs.init();
  return {
    ctx: {
      projectDir: directory,
      repoRoot: directory,
      distDir,
      config: { basePath: '' },
    } as unknown as BuildContext,
    outDir,
    blobs,
    cacheHostModule: undefined,
    sourceMaps: undefined,
    keptMaps: undefined,
    manifests: [],
    hook: { file: undefined, chunks: [], wasm: [], assets: {} },
    edgeInstrumentation: undefined,
    cacheHandlers: undefined,
    middleware: { output: undefined, node: [], edge: [], chunks: [], wasm: [] },
    modules: routes.flatMap((route) => (route.module === undefined ? [] : [route.module])),
    routes,
    edgeEntries: [edge],
    chunks: [],
    wasm: [],
    shipped: [],
    staticBlobs: [],
    files: { app: [], middleware: [] },
    workflowSdk: false,
    previewData: false,
  };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
  try {
    await stopped;
  } finally {
    clearTimeout(kill);
  }
}

describe.skipIf(!ENABLED)('Linux native Function artifact integration', () => {
  let directory: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child !== undefined) await stop(child);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    // This opt-in CI job creates /bundle as an empty, dedicated extraction root.
    if (ENABLED) {
      for (const file of await readdir('/bundle'))
        await rm(path.join('/bundle', file), { recursive: true, force: true });
    }
  });

  it('loads a real N-API binary through the assembled Node artifact and keeps another Function on Workers', async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-runtime-ci-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    const context = await contextOf(directory);
    const manifest = runtimeManifest(createId('dpl'));
    const functions = await appFunctionsOf(context, manifest, undefined);
    const primary = functions.built.find((entry) => entry.name === 'app');
    const native = functions.built.find((entry) => isNodeContainerFunction(entry.built.spec));

    const primarySpec = primary?.built.spec;
    expect({
      version: functions.runtimeManifest.v,
      worker: primarySpec?.runtime,
      nativeName: native?.name,
      edgeOnWorker:
        primarySpec !== undefined &&
        !isNodeContainerFunction(primarySpec) &&
        primarySpec.modules.some((module) => module.name === 'edge.cjs'),
    }).toEqual({ version: 12, worker: undefined, nativeName: 'app-2', edgeOnWorker: true });
    if (native === undefined || !isNodeContainerFunction(native.built.spec))
      throw new Error('No native artifact was produced');
    const archive = path.join(directory, 'native.tar.gz');
    await writeFile(
      archive,
      await readFile(path.join(context.outDir, 'blobs', native.built.spec.artifact.sha256)),
    );
    await mkdir('/bundle', { recursive: true });
    await execute('tar', ['--no-same-owner', '-xzf', archive, '-C', '/bundle'], { timeout: 5000 });
    const selected = JSON.parse(await readFile('/bundle/upwind/native.json', 'utf8')) as {
      modules: { path: string; sha256: string }[];
    };

    expect(selected.modules).toHaveLength(1);
    child = spawn(process.execPath, ['/bundle/upwind/server.mjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ARKOR_NODE_RUNTIME: JSON.stringify({
          v: 1,
          deploymentId: manifest.deploymentId,
          functionName: native.name,
          controlToken: CONTROL,
          capabilities: { services: {} },
        }),
      },
    });
    await expect
      .poll(
        async () => {
          if (child?.exitCode !== null)
            throw new Error('The assembled Node service exited before readiness');
          try {
            return (
              await fetch(`${ADDRESS}/__upwind/ready`, {
                headers: { 'x-upwind-control-token': CONTROL },
                signal: AbortSignal.timeout(1000),
              })
            ).status;
          } catch {
            return 0;
          }
        },
        { timeout: 15_000, interval: 100 },
      )
      .toBe(200);
    const response = await fetch(ADDRESS, {
      headers: {
        'x-upwind-control-token': CONTROL,
        'x-upwind-request-url': 'https://native.example/native',
      },
      signal: AbortSignal.timeout(5000),
    });

    expect({
      status: response.status,
      body: await response.text(),
      dist: response.headers.get('x-native-dist'),
    }).toEqual({ status: 200, body: 'native-function-real', dist: '/bundle/project/.next' });
    const other = await fetch(ADDRESS, {
      headers: {
        'x-upwind-control-token': CONTROL,
        'x-upwind-request-url': 'https://native.example/worker',
      },
      signal: AbortSignal.timeout(5000),
    });

    expect(other.status).toBe(421);
    await other.body?.cancel();
  }, 90_000);
});
