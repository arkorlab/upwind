import { readFile, mkdir, realpath, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '@stayingupwind/core/artifact';
import type { NodeContainerFunctionSpec, SourceMapRef } from '@stayingupwind/core/bundle';
import { rolldown, type Plugin } from 'rolldown';

import { appEntrySource } from './app-entry.ts';
import { jsLiteral } from './codegen.ts';
import { AuditError, type FunctionDependencies } from './dependencies.ts';
import { bundleEdge } from './edge.ts';
import { buildFunction, type BuildFunctionInput } from './function.ts';
import { nativeLoaderSelectorKeys } from './native-loaders.ts';
import { NativeFunctionRequired, type NativeLoad } from './native-loads.ts';
import { nodeArtifactArchive } from './node-archive.ts';
import { nodePhysicalFiles } from './node-files.ts';
import { nodeSourceMaps } from './node-source-maps.ts';
import { fetchCacheWaitUntilPatch } from './patches/fetch-cache-wait-until.ts';
import { instrumentationPatch } from './patches/instrumentation.ts';
import { resourceCacheBridgePatch } from './patches/resource-cache-bridge.ts';

/** Only shared-cache/render semantics. No Worker loader, VM, native, fs or process substitutes. */
const NODE_PATCHES = [fetchCacheWaitUntilPatch, instrumentationPatch, resourceCacheBridgePatch];

export interface NodeBuiltFunction {
  readonly spec: NodeContainerFunctionSpec;
  readonly dependencies: FunctionDependencies;
  readonly sourceMaps: SourceMapRef[];
  readonly inputs: readonly { readonly file: string; readonly bytes: number }[];
}

function assertNativeAbi(): NodeContainerFunctionSpec['abi'] {
  const report = process.report?.getReport();
  const header =
    typeof report === 'object' && report !== null && 'header' in report ? report.header : undefined;
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    typeof header !== 'object' ||
    header === null ||
    !('glibcVersionRuntime' in header)
  ) {
    throw new AuditError(
      'Native Functions must be built with the host-pinned Linux x64 glibc Node.js image',
    );
  }
  return {
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules,
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
  };
}

function nativeElf(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 64 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[18] !== 62 ||
    bytes[19] !== 0
  ) {
    throw new AuditError('Native Function binary is not a Linux x64 ELF object');
  }
}

function nodeAliases(input: BuildFunctionInput): Plugin {
  const runtime = path.dirname(
    fileURLToPath(import.meta.resolve('@stayingupwind/runtime/function')),
  );
  const aliases: Readonly<Record<string, string>> = {
    environment: fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-environment')),
    'node-bridge': fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-http-bridge')),
    resources: fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-resources')),
  };
  return {
    name: 'upwind-node-runtime',
    resolveId(source, importer) {
      if (source === 'arkor:app') return { id: './app.cjs', external: true };
      if (source === 'arkor:edge') return { id: './edge.cjs', external: true };
      if (source === 'arkor:wasm') return { id: './wasm.mjs', external: true };
      if (source === 'arkor:cache-host') return input.cacheHostModule ?? '\0upwind-node-no-cache';
      if (
        importer !== undefined &&
        path.dirname(importer) === runtime &&
        /^\.\/(?:environment|node-bridge|resources)\.(?:ts|js)$/u.test(source)
      ) {
        return aliases[path.basename(source, path.extname(source))] ?? null;
      }
      return null;
    },
    load(id) {
      return id === '\0upwind-node-no-cache'
        ? 'export function createCacheHost(){return undefined} export const createBundleBlobReader=undefined;'
        : null;
    },
  };
}

async function bundleNode(
  input: BuildFunctionInput,
  settings: { entry: string; outFile: string; service?: boolean },
): Promise<void> {
  const unresolved: string[] = [];
  await using bundle = await rolldown({
    input: settings.entry,
    platform: 'node',
    resolve: { conditionNames: ['node', 'default'] },
    external: [/^node:/u, './function.mjs'],
    plugins: [nodeAliases(input)],
    transform: {
      target: 'es2024',
      define: {
        'process.env.NODE_ENV': '"production"',
        __ARKOR_FUNCTION_KIND__: jsLiteral(input.kind),
        __ARKOR_FUNCTION_NAME__: jsLiteral(input.name ?? input.kind),
        __ARKOR_WORKFLOW_SDK__: 'false',
        __dirname: '"/bundle"',
        __filename: '"/bundle/upwind/function.mjs"',
      },
    },
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT') unresolved.push(log.message);
    },
  });
  const result = await bundle.write({
    file: settings.outFile,
    format: 'esm',
    codeSplitting: false,
    banner:
      'import {createRequire as __upwindCreateRequire} from "node:module"; const require=__upwindCreateRequire(import.meta.url);',
    sourcemap: false,
  });
  if (
    unresolved.length > 0 ||
    result.output.some(
      (chunk) =>
        chunk.type === 'chunk' && chunk.imports.some((name) => name.startsWith('cloudflare:')),
    )
  ) {
    throw new AuditError('Node Function runtime has an unsupported or unresolved platform import');
  }
}

/** Host hooks are Node bundles; project hooks retain their original physical module graph. */
async function bundleNodeInstrumentation(
  input: BuildFunctionInput,
  settings: { outFile: string; nameOf: (file: string) => string },
): Promise<void> {
  if (input.patch.instrumentation === undefined) return;
  const unresolved: string[] = [];
  const root = path.resolve(input.repoRoot ?? input.projectDir);
  await using bundle = await rolldown({
    input: input.patch.instrumentation,
    platform: 'node',
    resolve: { conditionNames: ['node', 'default'] },
    external: [/^node:/u],
    plugins: [
      {
        name: 'upwind-node-instrumentation-project-files',
        resolveId(source) {
          if (!path.isAbsolute(source)) return null;
          const relative = path.relative(root, source);
          if (
            relative !== '' &&
            !relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative)
          ) {
            // The generated composed hook itself is the input, not a project module to externalize.
            if (source === input.patch.instrumentation) return null;
            return { id: `/bundle/${settings.nameOf(source)}`, external: true };
          }
          return null;
        },
      },
    ],
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT') unresolved.push(log.message);
    },
  });
  const result = await bundle.write({
    file: settings.outFile,
    format: 'cjs',
    codeSplitting: false,
    banner: "globalThis.AsyncLocalStorage ??= require('node:async_hooks').AsyncLocalStorage;",
  });
  if (
    unresolved.length > 0 ||
    result.output.some(
      (chunk) =>
        chunk.type === 'chunk' && chunk.imports.some((name) => name.startsWith('cloudflare:')),
    )
  ) {
    throw new AuditError('Host instrumentation cannot be represented by a Node Function artifact');
  }
}

/** A separate physical artifact; app modules are never passed through the Worker patch bundle. */
export async function buildNodeFunction(
  input: BuildFunctionInput,
  selected: readonly NativeLoad[],
): Promise<NodeBuiltFunction> {
  if (selected.length === 0)
    throw new AuditError('A Node Function requires a retained, owned native load');
  let native: readonly NativeLoad[];
  try {
    await buildFunction({ ...input, nativeTargetAudit: true });
    throw new AuditError('The final Node Function has no required native capability');
  } catch (error) {
    if (!(error instanceof NativeFunctionRequired)) throw error;
    native = error.loads;
  }
  if (native.some((load) => load.esm === true))
    throw new AuditError(
      'Node.js cannot import a .node file as an ES module; use a Node-compatible CommonJS native entry',
    );
  if (input.workflowSdk === true)
    throw new AuditError('Native Functions currently cannot run a Workflow SDK World');
  if (input.patch.cacheHandlers !== undefined)
    throw new AuditError(
      'Native Functions currently require the shared platform cache handlers; custom handler closures are not supported',
    );
  const abi = assertNativeAbi();
  const physical = await nodePhysicalFiles(input, native);
  const files = new Map(physical.files.map((file) => [file.name, file]));
  const add = (name: string, bytes: Uint8Array): void => {
    const previous = files.get(name);
    if (previous !== undefined && Buffer.compare(previous.bytes, bytes) !== 0)
      throw new AuditError('Node artifact generated metadata conflicts with a physical input');
    files.set(name, { name, bytes });
  };
  const text = (name: string, value: string): void => add(name, new TextEncoder().encode(value));
  const work = path.join(input.outDir, 'work', `node-${input.name ?? input.kind}`);
  await mkdir(work, { recursive: true });
  if (input.patch.instrumentation !== undefined) {
    const hook = path.join(work, 'instrumentation.cjs');
    await bundleNodeInstrumentation(input, { outFile: hook, nameOf: physical.nameOf });
    add('upwind/instrumentation.cjs', new Uint8Array(await readFile(hook)));
  }
  const patchContext = {
    ...input.patch,
    instrumentation:
      input.patch.instrumentation === undefined ? undefined : '/bundle/upwind/instrumentation.cjs',
  };
  // Apply cache semantics to copied Next files only; the original output remains unchanged.
  for (const file of physical.files) {
    const original = file.name.startsWith('project/')
      ? path.join(input.repoRoot ?? input.projectDir, file.name.slice('project/'.length))
      : undefined;
    if (original === undefined || !/\.(?:c|m)?js$/u.test(original)) continue;
    let contents = new TextDecoder().decode(file.bytes);
    for (const patch of NODE_PATCHES) {
      if (patch.target.test(original) && (patch.marker === undefined || patch.marker(contents)))
        contents = patch.apply(contents, original, patchContext).contents;
    }
    files.set(file.name, { ...file, bytes: new TextEncoder().encode(contents) });
  }
  const modules: { path: string; sha256: string }[] = [];
  for (const binary of new Set(await Promise.all(native.map((load) => realpath(load.binary))))) {
    const filename = physical.nameOf(binary);
    const bytes = files.get(filename)?.bytes;
    if (bytes === undefined)
      throw new AuditError('Selected native binary was omitted from the Node artifact');
    nativeElf(bytes);
    modules.push({ path: filename, sha256: await sha256Hex(bytes) });
  }
  text('upwind/native.json', JSON.stringify({ modules }));
  text('upwind/links.json', JSON.stringify({ links: physical.links }));
  text('runtime.json', input.runtimeManifest);
  // Next's production entry reads the original JSON manifests from its real dist directory.
  for (const dir of [input.patch.distDir, path.join(input.patch.distDir, 'server')]) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.isFile() && item.name.endsWith('.json') && !item.name.endsWith('.nft.json')) {
        const file = path.join(dir, item.name);
        add(physical.nameOf(file), new Uint8Array(await readFile(file)));
      }
    }
  }
  for (const manifest of input.manifests) text(manifest.name, manifest.contents);
  // Web entry inline assets and runtime compatibility data retain their existing /bundle names.
  for (const file of input.files) add(file.name, new Uint8Array(await readFile(file.filePath)));
  for (const blob of input.blobs) add(`blobs/${blob.sha256}`, blob.bytes);
  const dist = physical.nameOf(input.patch.distDir);
  const table = await Promise.all(
    input.entries.map(async (entry) => {
      const file = physical.nameOf(await realpath(entry.filePath));
      return { id: entry.id, filePath: `/bundle/${file}` };
    }),
  );
  text(
    'upwind/app.cjs',
    `globalThis.AsyncLocalStorage ??= require('node:async_hooks').AsyncLocalStorage;\n${appEntrySource(table, { external: true, runtimeDistDir: `/bundle/${dist}` })}`,
  );
  if (input.edgeEntries.length > 0) {
    const edge = await bundleEdge({
      kind: 'node-edge',
      projectDir: input.projectDir,
      distDir: input.patch.distDir,
      workDir: work,
      entries: input.edgeEntries,
      instrumentation: input.edgeInstrumentation,
    });
    if (edge.trace.externals.some((name) => name.startsWith('cloudflare:')))
      throw new AuditError(
        'Native Function Edge instrumentation requires unsupported platform bindings',
      );
    add('upwind/edge.cjs', new Uint8Array(await readFile(edge.outFile)));
  } else text('upwind/edge.cjs', 'module.exports={entries:{}};');
  const wasm = input.wasm.modules.map((module) => {
    const name = `upwind/wasm/${module.sha256}.wasm`;
    add(name, module.bytes);
    return `const m_${module.sha256}=new WebAssembly.Module(readFileSync(new URL(${jsLiteral(`./wasm/${module.sha256}.wasm`)},import.meta.url)));${module.globals.map((global) => `globalThis[${jsLiteral(global)}]??=m_${module.sha256};`).join('')}`;
  });
  text('upwind/wasm.mjs', `import {readFileSync} from 'node:fs';${wasm.join('\n')}`);
  const runtime = path.join(work, 'function.mjs');
  await bundleNode(input, {
    entry: fileURLToPath(import.meta.resolve('@stayingupwind/runtime/function')),
    outFile: runtime,
  });
  add('upwind/function.mjs', new Uint8Array(await readFile(runtime)));
  const serverSource = path.join(work, 'server-source.mjs');
  const selectors = [
    ...new Set(
      (
        await Promise.all(
          native
            .filter((load) => load.kind === 'node-gyp-build')
            .map((load) => nativeLoaderSelectorKeys(load.importer)),
        )
      ).flat(),
    ),
  ];
  await writeFile(
    serverSource,
    [
      "import {env as runtimeEnv} from 'node:process';",
      `import {startNodeContainer} from ${jsLiteral(fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-container')))};`,
      "runtimeEnv.NODE_ENV='production';runtimeEnv.NEXT_RUNTIME='nodejs';",
      `if(${JSON.stringify(selectors)}.some(key=>Boolean(runtimeEnv[key])))throw new Error('Native loader environment overrides are unsupported');`,
      `process.chdir(${jsLiteral(`/bundle/${physical.cwd}`)});`,
      "const {default:entry}=await import('./function.mjs');",
      'await startNodeContainer({entry,port:8080});',
    ].join('\n'),
  );
  const server = path.join(work, 'server.mjs');
  await bundleNode(input, { entry: serverSource, outFile: server, service: true });
  add('upwind/server.mjs', new Uint8Array(await readFile(server)));
  const archive = nodeArtifactArchive([...files.values()]);
  const artifact = await input.blobStore.put(archive, 'application/gzip');
  return {
    spec: { runtime: 'node-container', artifact, entrypoint: 'upwind/server.mjs', abi },
    sourceMaps: await nodeSourceMaps(input, physical.files, files),
    inputs: physical.files.map((file) => ({ file: file.name, bytes: file.bytes.byteLength })),
    dependencies: {
      buildOutput: [],
      packages: {},
      other: [],
      externals: [],
      stubs: [],
      patches: [],
      dynamicRequires: [],
      wasmModules: [],
      modules: [],
      size: { bytes: archive.byteLength, gzipBytes: archive.byteLength },
    },
  };
}
