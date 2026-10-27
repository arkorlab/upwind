import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ONE_PASS_BUNDLE_VERSION, packPrerenders } from '@stayingupwind/core/bundle';
import { type Plugin, type ResolveIdResult, rolldown } from 'rolldown';

import { BlobStore } from '../blobs.ts';
import { assertBuildPaths } from '../build-paths.ts';
import { bundleConfig } from '../bundle-config.ts';
import { jsLiteral } from '../codegen.ts';
import {
  type BuildContext,
  bundleRouting,
  bypassTokenOf,
  collectEntrypoints,
  deploymentId,
  edgeEntryOf,
  imagesConfig,
  isStaticExport,
  middlewareMatchers,
  middlewareOutput,
} from '../collect.ts';
import type { EdgeEntry } from '../edge.ts';
import { ensureStaticRoutes } from '../ensure-static.ts';
import { exists } from '../fs.ts';
import { declaredGates } from '../gates.ts';
import type { AdapterOptions } from '../index.ts';
import { readKeptMaps } from '../kept-maps.ts';
import { collectPageBodies } from '../page-body-layout.ts';
import { readProjectConfig } from '../project-config.ts';
import { carriesMaps } from '../source-maps.ts';
import { collectStaticFiles } from '../static-files.ts';
import { GLOBAL_OBJECT, globalObjectPlugin, THROWING_GLOBALS } from '../throwing-globals.ts';
import { EDGE_ANSWER_SOURCE, EDGE_ANSWER_WRAPPER } from './edge-answer.ts';
import {
  NATIVE_EDGE_WEB_GLOBALS,
  NATIVE_EDGE_WEB_OBJECT,
  nativeEdgeWebPlugin,
} from './edge-web.ts';
import { imageEncoderFiles } from './encoder-files.ts';
import { copyNativeFiles, nativeAssetSources, nativeTraceFiles } from './files.ts';
import { nativeEdgeGraphPlugin } from './graph.ts';
import { type ImageCacheField, imageCacheField } from './image-cache-field.ts';
import { NATIVE_RUNTIME_FIELDS } from './runtime-fields.ts';

const MIDDLEWARE_ID = '/_middleware';
const SERVER_FILE = 'server.mjs';
const CACHE_WORKER_FILE = 'cache-worker.mjs';

/** A separate format prevents an older Workers uploader from mistaking this for its bundle. */
export interface NativeDeploymentManifest extends ImageCacheField {
  readonly format: 'upwind-node';
  readonly v: 1;
  readonly deploymentId: string;
  readonly buildId: string;
  readonly nextVersion: string;
  readonly generatedAt: string;
  readonly projectDir: string;
  readonly distDir: string;
}

async function filesUnder(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(file)));
    else if (!file.endsWith('.nft.json')) files.push(file);
  }
  return files;
}

async function rootManifests(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => {
      return (
        entry.isFile() &&
        (entry.name === 'BUILD_ID' ||
          (entry.name.endsWith('.json') && !entry.name.endsWith('.nft.json')))
      );
    })
    .map((entry) => path.join(directory, entry.name));
}

async function tracedSources(trace: string): Promise<readonly string[]> {
  return (await exists(trace)) ? nativeTraceFiles(trace) : [];
}

async function nativeSources(ctx: BuildContext): Promise<string[]> {
  const outputs = [
    ...ctx.outputs.appPages,
    ...ctx.outputs.appRoutes,
    ...ctx.outputs.pages,
    ...ctx.outputs.pagesApi,
    ...(ctx.outputs.middleware === undefined ? [] : [ctx.outputs.middleware]),
  ];
  const sources = new Set<string>();
  for (const output of outputs) {
    sources.add(output.filePath);
    for (const source of nativeAssetSources(output.assets, ctx.distDir)) sources.add(source);
  }
  const serverFiles = await filesUnder(path.join(ctx.distDir, 'server'));
  const manifests = await rootManifests(ctx.distDir);
  for (const file of serverFiles) sources.add(file);
  for (const file of manifests) sources.add(file);
  const traces = new Set([
    ...outputs
      .filter((output) => output.runtime !== 'edge')
      .map((output) => `${output.filePath}.nft.json`),
    path.join(ctx.distDir, 'next-server.js.nft.json'),
    path.join(ctx.distDir, 'server/instrumentation.js.nft.json'),
  ]);
  for (const trace of traces) {
    const traced = await tracedSources(trace);
    for (const source of traced) sources.add(source);
  }
  // The nearest package declaration controls whether copied .js files are CJS or ESM.
  const manifest = path.join(ctx.projectDir, 'package.json');
  if (await exists(manifest)) sources.add(manifest);
  return [...sources];
}

function appModuleSource(
  modules: readonly { readonly id: string; readonly filePath: string }[],
  pathOf: (file: string) => string,
  distDir: string,
): string {
  return [
    "const path = require('node:path');",
    `const distDir = path.resolve(__dirname, ${jsLiteral(distDir)});`,
    'function load(file) {',
    '  const loaded = require(file);',
    '  const normalize = (entry) => {',
    '    if (entry.routeModule !== undefined) entry.routeModule.distDir = path.relative(process.cwd(), distDir);',
    '    return entry;',
    '  };',
    '  return typeof loaded?.then === "function" ? Promise.resolve(loaded).then(normalize) : normalize(loaded);',
    '}',
    'module.exports = { entries: {',
    ...modules.map((entry) => {
      const file = jsLiteral(`./${pathOf(entry.filePath)}`);
      return `  ${jsLiteral(entry.id)}: () => load(${file}),`;
    }),
    '} };',
    '',
  ].join('\n');
}

function edgeModuleSource(entries: readonly EdgeEntry[], pathOf: (file: string) => string): string {
  if (entries.length === 0) return 'module.exports = { entries: {} };\n';
  const inline = entries.flatMap((entry) => entry.inlineAssets);
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    EDGE_ANSWER_SOURCE,
    ...(inline.length === 0
      ? []
      : [
          `const assets = new Map(${jsLiteral(inline.map((asset) => [asset.name, pathOf(asset.filePath)]))});`,
          'const nativeFetch = globalThis.fetch;',
          'globalThis.fetch = (input, init) => {',
          '  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;',
          '  const file = url.startsWith("blob:") ? assets.get(url.slice(5)) : undefined;',
          '  return file === undefined ? nativeFetch(input, init) : Promise.resolve(new Response(fs.readFileSync(path.resolve(__dirname, file))));',
          '};',
        ]),
    'module.exports = { entries: {',
    ...entries.map((entry) => {
      return [
        `  ${jsLiteral(entry.id)}: () => {`,
        ...(Object.keys(entry.env).length === 0
          ? []
          : [`    Object.assign(process.env, ${jsLiteral(entry.env)});`]),
        ...entry.wasm.map(
          (wasm) =>
            `    globalThis[${jsLiteral(wasm.global)}] ??= new WebAssembly.Module(fs.readFileSync(path.resolve(__dirname, ${jsLiteral(pathOf(wasm.filePath))})));`,
        ),
        ...entry.files.map((file) => {
          const name = jsLiteral(`./${pathOf(file)}`);
          return `    require(${name});`;
        }),
        '    const config = globalThis.__SERVER_FILES_MANIFEST?.config?.experimental;',
        '    if (config !== undefined) config.trustHostHeader = true;',
        `    const entry = globalThis._ENTRIES?.[${jsLiteral(entry.entryKey)}];`,
        '    if (entry === undefined) throw new Error("upwind: Edge entry registered no handler");',
        `    return { handler: ${EDGE_ANSWER_WRAPPER}(entry[${jsLiteral(entry.handlerExport)}]) };`,
        '  },',
      ].join('\n');
    }),
    '} };',
    '',
  ].join('\n');
}

function nativeModules(runtimeRoot: string, cacheHost: string): Plugin {
  const resolved: Readonly<Record<string, { readonly id: string; readonly external: boolean }>> = {
    'arkor:app': { id: './app.cjs', external: true },
    'arkor:edge': { id: './edge.cjs', external: true },
    'arkor:native-function': { id: './function.mjs', external: true },
    'arkor:cache-host': { id: cacheHost, external: false },
    'arkor:wasm': { id: '\0native-wasm', external: false },
  };
  const replacements = new Map([
    [path.join(runtimeRoot, 'delivery.ts'), path.join(runtimeRoot, 'native/delivery.ts')],
    [path.join(runtimeRoot, 'environment.ts'), path.join(runtimeRoot, 'native/environment.ts')],
    [path.join(runtimeRoot, 'image-cache.ts'), path.join(runtimeRoot, 'native/image-cache.ts')],
    [path.join(runtimeRoot, 'image-encoder.ts'), path.join(runtimeRoot, 'native/image-encoder.ts')],
    [
      path.join(runtimeRoot, 'image-source-fetch.ts'),
      path.join(runtimeRoot, 'native/image-source-fetch.ts'),
    ],
    [path.join(runtimeRoot, 'node-bridge.ts'), path.join(runtimeRoot, 'native/entry.ts')],
    [path.join(runtimeRoot, 'rewrite-fetch.ts'), path.join(runtimeRoot, 'native/rewrite-fetch.ts')],
    [path.join(runtimeRoot, 'static-file.ts'), path.join(runtimeRoot, 'native/static-file.ts')],
  ]);
  return {
    name: 'upwind-native-runtime',
    resolveId(source, importer): ResolveIdResult {
      if (source.startsWith('cloudflare:'))
        throw new Error('@stayingupwind/adapter: native runtime imports a Cloudflare-only module');
      if (Object.hasOwn(resolved, source)) return resolved[source] ?? null;
      if (importer !== undefined && source.startsWith('.')) {
        const replacement = replacements.get(path.resolve(path.dirname(importer), source));
        return replacement === undefined ? null : { id: replacement, external: false };
      }
      return null;
    },
    load: (id) => (id === '\0native-wasm' ? 'export {};' : null),
  };
}

async function bundleNativeModule(
  entry: string,
  file: string,
  plugins: readonly Plugin[] = [],
): Promise<void> {
  const unresolved: string[] = [];
  await using bundle = await rolldown({
    input: entry,
    platform: 'node',
    resolve: { conditionNames: ['node', 'default'] },
    external: [/^node:/u],
    plugins: [globalObjectPlugin(), ...plugins],
    transform: {
      target: 'es2023',
      inject: GLOBAL_OBJECT,
      define: {
        ...THROWING_GLOBALS,
        'process.env.NODE_ENV': '"production"',
        __ARKOR_FUNCTION_KIND__: '"app"',
        __ARKOR_FUNCTION_NAME__: '"app"',
        __ARKOR_WORKFLOW_SDK__: 'false',
        __ARKOR_BUNDLE_ROOT__: 'import.meta.dirname',
        __dirname: 'import.meta.dirname',
        __filename: 'import.meta.filename',
      },
    },
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT') unresolved.push(log.message);
    },
  });
  await bundle.generate({ format: 'esm', codeSplitting: false });
  if (unresolved.length > 0)
    throw new Error(
      `@stayingupwind/adapter: native runtime imports cannot be resolved\n${unresolved.join('\n')}`,
    );
  await bundle.write({ file, format: 'esm', codeSplitting: false, comments: { legal: false } });
}

async function emitNativeEdge(
  outDir: string,
  entries: readonly EdgeEntry[],
  pathOf: (file: string) => string,
): Promise<void> {
  const output = path.join(outDir, 'edge.cjs');
  const source = edgeModuleSource(entries, pathOf);
  if (entries.length === 0) {
    await writeFile(output, source);
    return;
  }
  const entry = path.join(outDir, 'edge-entry.cjs');
  await writeFile(entry, source);
  const unresolved: string[] = [];
  await using bundle = await rolldown({
    input: entry,
    platform: 'node',
    external: [/^node:/u],
    plugins: [
      globalObjectPlugin(),
      nativeEdgeWebPlugin(),
      nativeEdgeGraphPlugin(),
      {
        name: 'upwind-native-edge',
        resolveId(specifier) {
          if (specifier.startsWith('cloudflare:'))
            throw new Error(
              '@stayingupwind/adapter: native Edge entry imports a Cloudflare-only module',
            );
          return null;
        },
      },
    ],
    transform: {
      target: 'es2023',
      inject: { ...GLOBAL_OBJECT, ...NATIVE_EDGE_WEB_OBJECT },
      define: {
        ...THROWING_GLOBALS,
        ...NATIVE_EDGE_WEB_GLOBALS,
        'process.env.NODE_ENV': '"production"',
        'process.env.NEXT_RUNTIME': '"edge"',
        self: 'globalThis',
      },
    },
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT') unresolved.push(log.message);
    },
  });
  await bundle.generate({ format: 'cjs', codeSplitting: false });
  if (unresolved.length > 0)
    throw new Error(
      `@stayingupwind/adapter: native Edge imports cannot be resolved\n${unresolved.join('\n')}`,
    );
  await bundle.write({
    file: output,
    format: 'cjs',
    codeSplitting: false,
    comments: { legal: false },
  });
  await rm(entry);
}

async function adapterRoot(): Promise<string> {
  let directory = import.meta.dirname;
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (await exists(manifest)) {
      const value = JSON.parse(await readFile(manifest, 'utf8')) as { readonly name?: string };
      if (value.name === '@stayingupwind/adapter') return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error('@stayingupwind/adapter: cannot find the native server templates');
    directory = parent;
  }
}

/** Public installs carry compiled templates; a source checkout compiles these same entries. */
async function emitNativeHost(outDir: string, plugin: Plugin): Promise<void> {
  const root = await adapterRoot();
  const templates = path.join(root, 'dist/native');
  if (
    (await exists(path.join(templates, SERVER_FILE))) &&
    (await exists(path.join(templates, CACHE_WORKER_FILE)))
  ) {
    await Promise.all(
      [SERVER_FILE, CACHE_WORKER_FILE].map((name) =>
        copyFile(path.join(templates, name), path.join(outDir, name)),
      ),
    );
    return;
  }
  await bundleNativeModule(
    path.join(root, 'src/native/server.ts'),
    path.join(outDir, SERVER_FILE),
    [plugin],
  );
  const worker = path.join(root, '../cache/src/native/worker.ts');
  await bundleNativeModule(worker, path.join(outDir, CACHE_WORKER_FILE));
}

function assertNativeOptions(options: AdapterOptions): void {
  if ((options.durableObjects?.length ?? 0) > 0 || (options.cloudflareWorkflows?.length ?? 0) > 0) {
    throw new Error(
      '@stayingupwind/adapter: native Node deployments do not provide Cloudflare Durable Objects, Containers, or Workflows',
    );
  }
  if (
    (options.instrumentationModules?.length ?? 0) > 0 ||
    (options.edgeInstrumentationModules?.length ?? 0) > 0 ||
    options.workflowWorldModule !== undefined
  ) {
    throw new Error(
      '@stayingupwind/adapter: native Node deployments do not support host instrumentation or a host Workflow World; project instrumentation remains supported',
    );
  }
  if (
    options.unshippedOutputs === 'prefetch-segments' ||
    options.unshippedPrerenderBodies !== undefined
  ) {
    throw new Error(
      '@stayingupwind/adapter: native Node deployments carry every prerender output; unshipped outputs are not supported',
    );
  }
}

/** Produce a standalone Node artifact while sharing the Workers runtime's routing and cache semantics. */
export async function emitNativeDeployment(
  ctx: BuildContext,
  options: AdapterOptions,
): Promise<void> {
  assertNativeOptions(options);
  const exported = isStaticExport(ctx.config);
  const staging = path.join(ctx.projectDir, '.arkor');
  if (!exported) assertBuildPaths(ctx.projectDir, ctx.distDir, staging);
  const project = await readProjectConfig(ctx.projectDir, options.hostConfigFiles);
  if (
    project.crons.length > 0 ||
    declaredGates() !== undefined ||
    Object.keys(project.deploy?.storage ?? {}).length > 0 ||
    project.deploy?.cspNonce !== undefined
  ) {
    throw new Error(
      '@stayingupwind/adapter: native Node deployments do not provide host cron jobs, route gates, Cloudflare storage bindings, or edge CSP nonces',
    );
  }
  await rm(staging, { recursive: true, force: true });
  const outDir = path.join(staging, 'node');
  await mkdir(outDir, { recursive: true });
  const blobs = new BlobStore(outDir);
  await blobs.init();
  const collected = collectEntrypoints(ctx.outputs);
  const { entrypoints } = collected;
  const middleware = middlewareOutput(ctx.outputs);
  const edgeEntries = [...collected.edgeEntries];
  const modules = [...collected.modules];
  if (middleware !== undefined) {
    if (middleware.runtime === 'edge') edgeEntries.push(edgeEntryOf(middleware, MIDDLEWARE_ID));
    else modules.push({ id: MIDDLEWARE_ID, filePath: middleware.filePath });
  }
  const { prerenders } = await collectPageBodies({
    outputs: ctx.outputs,
    blobs,
    basePath: ctx.config.basePath,
    rsc: ctx.routing.rsc,
    unshipped: 'none',
    entrypoints,
    edgeRuntimeRoutes: new Set(
      entrypoints.filter((entry) => entry.runtime === 'edge').map((entry) => entry.pathname),
    ),
    ensureStatic: exported
      ? new Set<string>()
      : await ensureStaticRoutes(ctx.distDir, ctx.config.basePath),
  });
  const maps = carriesMaps(options.sourceMaps) ? await readKeptMaps(ctx.distDir) : undefined;
  const { files: staticFiles } = await collectStaticFiles(
    ctx,
    blobs,
    carriesMaps(options.sourceMaps),
    maps,
  );
  const id = deploymentId();
  const generatedAt = new Date().toISOString();
  const bypassToken = bypassTokenOf(ctx.outputs);
  const images = await imagesConfig(ctx);
  const base = {
    v: ONE_PASS_BUNDLE_VERSION as number,
    routerReferences: 'one-pass' as const,
    resourceChanges: 1 as const,
    deploymentId: id,
    buildId: ctx.buildId,
    nextVersion: ctx.nextVersion,
    generatedAt,
    config: bundleConfig(ctx.config, images),
    routing: bundleRouting(ctx.routing, middleware),
    ...(bypassToken !== undefined && { bypassToken }),
    entrypoints,
    prerenders,
    staticFiles,
    ...(middleware !== undefined && { middleware: { matchers: middlewareMatchers(middleware) } }),
  };
  const runtime = { ...base, ...NATIVE_RUNTIME_FIELDS };
  await writeFile(
    path.join(outDir, 'runtime.json'),
    JSON.stringify({ ...runtime, prerenders: packPrerenders(prerenders) }),
  );
  const layout = await copyNativeFiles({
    files: exported
      ? []
      : [
          ...(await nativeSources(ctx)),
          // The encoder `/_next/image` resizes with, where the build has an optimizer to answer it.
          ...(images === undefined ? [] : await imageEncoderFiles(ctx.projectDir)),
        ],
    directories: [ctx.repoRoot, ctx.projectDir, ctx.distDir],
    outDir,
  });
  const manifest: NativeDeploymentManifest = {
    format: 'upwind-node',
    v: 1,
    deploymentId: id,
    buildId: ctx.buildId,
    nextVersion: ctx.nextVersion,
    generatedAt,
    projectDir: layout.pathOf(ctx.projectDir),
    distDir: layout.pathOf(ctx.distDir),
    ...imageCacheField(ctx, images),
  };
  // A static export still needs a real cwd, even though none of its route modules are loaded.
  await mkdir(path.join(outDir, manifest.projectDir), { recursive: true });
  await writeFile(
    path.join(outDir, 'app.cjs'),
    appModuleSource(modules, layout.pathOf, manifest.distDir),
  );
  await emitNativeEdge(outDir, edgeEntries, layout.pathOf);
  const runtimeRoot = path.dirname(
    fileURLToPath(import.meta.resolve('@stayingupwind/runtime/function')),
  );
  const host = path.join(runtimeRoot, 'native/cache-host.ts');
  const plugin = nativeModules(runtimeRoot, host);
  await bundleNativeModule(
    path.join(runtimeRoot, 'native/function.ts'),
    path.join(outDir, 'function.mjs'),
    [plugin],
  );
  await emitNativeHost(outDir, plugin);
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `@stayingupwind/adapter: wrote .arkor/node (${prerenders.length} prerenders, ${staticFiles.length} static files, ${layout.count} native files)`,
  );
}
