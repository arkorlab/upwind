import { readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '@stayingupwind/core/artifact';
import type { NodeContainerFunctionSpec, SourceMapRef } from '@stayingupwind/core/bundle';
import { rolldown, type Plugin } from 'rolldown';

import { jsLiteral } from './codegen.ts';
import { AuditError, type FunctionDependencies } from './dependencies.ts';
import { bundleEdge } from './edge.ts';
import type { BuildFunctionInput } from './function.ts';
import { nativeLoaderSelectorKeys } from './native-loaders.ts';
import type { NativeLoad } from './native-loads.ts';
import { nodeArtifactArchive } from './node-archive.ts';
import { NodeArtifactFiles } from './node-artifact-files.ts';
import { nodePhysicalFiles } from './node-files.ts';
import {
  assertNodeProofFiles,
  isNodeProofCompilerModule,
  nodeProofSource,
  proveNodeFunction,
} from './node-proof.ts';
import { nodeSourceMaps } from './node-source-maps.ts';

const NO_CACHE_MODULE = '\0upwind-node-no-cache';
const CLOUDFLARE_IMPORT_PREFIX = 'cloudflare:';

function glibcReport(header: unknown): boolean {
  return header !== null && typeof header === 'object' && 'glibcVersionRuntime' in header;
}

export interface NodeBuiltFunction {
  readonly spec: NodeContainerFunctionSpec;
  readonly dependencies: FunctionDependencies;
  readonly sourceMaps: SourceMapRef[];
  readonly inputs: readonly { readonly file: string; readonly bytes: number }[];
}

function assertNativeAbi(): NodeContainerFunctionSpec['abi'] {
  const report = process.report.getReport();
  const header = typeof report === 'object' && 'header' in report ? report.header : undefined;
  if (process.platform !== 'linux' || process.arch !== 'x64' || !glibcReport(header)) {
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

/** Resolve only the exact runtime-owned module identities, from any runtime subdirectory. */
export function nodeRuntimeAlias(
  source: string,
  importer: string | undefined,
  runtime: string,
): string | undefined {
  if (importer === undefined || !source.startsWith('.')) return undefined;
  const owner = path.relative(runtime, path.resolve(importer));
  if (owner === '..' || owner.startsWith(`..${path.sep}`) || path.isAbsolute(owner))
    return undefined;
  const resolved = path.relative(runtime, path.resolve(path.dirname(importer), source));
  if (
    !/^(?:environment|node-bindings|node-bridge|resources|rewrite-fetch)\.(?:ts|js)$/u.test(
      resolved,
    )
  )
    return undefined;
  return path.basename(resolved, path.extname(resolved));
}

function nodeAliases(input: BuildFunctionInput): Plugin {
  const runtime = path.dirname(
    fileURLToPath(import.meta.resolve('@stayingupwind/runtime/function')),
  );
  const aliases: Readonly<Record<string, string>> = {
    environment: fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-environment')),
    'rewrite-fetch': fileURLToPath(
      import.meta.resolve('@stayingupwind/runtime/node-rewrite-fetch'),
    ),
    'node-bridge': fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-http-bridge')),
    resources: fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-resources')),
  };
  return {
    name: 'upwind-node-runtime',

    resolveId(source, importer) {
      if (source === 'arkor:app') return { id: './app.cjs', external: true };
      if (source === 'arkor:edge') return { id: './edge.cjs', external: true };
      if (source === 'arkor:wasm') return { id: './wasm.mjs', external: true };
      if (source === 'arkor:cache-host') return { id: input.cacheHostModule ?? NO_CACHE_MODULE };
      const target = nodeRuntimeAlias(source, importer, runtime);
      // Both separately bundled entrypoints share one private bootstrap/cache module.
      // It consumes and removes the token-bearing environment value exactly once.
      if (target === 'node-bindings') return { id: './node-bindings.mjs', external: true };
      const alias = target === undefined ? undefined : aliases[target];
      return alias === undefined ? null : { id: alias };
    },
    load(id) {
      if (id === NO_CACHE_MODULE)
        return 'export function createCacheHost(){return undefined} export const createBundleBlobReader=undefined;';
      return null;
    },
  };
}

async function bundleNode(
  input: BuildFunctionInput,
  settings: { entry: string; outFile: string },
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
    result.output.some((chunk) => {
      return (
        chunk.type === 'chunk' &&
        chunk.imports.some((name) => name.startsWith(CLOUDFLARE_IMPORT_PREFIX))
      );
    })
  ) {
    throw new AuditError('Node Function runtime has an unsupported or unresolved platform import');
  }
}

/** Host hooks are Node bundles; project hooks retain their original physical module graph. */
async function bundleNodeInstrumentation(
  input: BuildFunctionInput,
  settings: {
    outFile: string;
    nameOf: (file: string) => string;
    instrumentation: string | undefined;
  },
): Promise<ReadonlyMap<string, string>> {
  if (input.patch.instrumentation === undefined) return new Map();
  const entry = await realpath(input.patch.instrumentation);
  if (entry === settings.instrumentation) {
    const projectHook = jsLiteral(`/bundle/${settings.nameOf(entry)}`);
    await writeFile(
      settings.outFile,
      `globalThis.AsyncLocalStorage??=require('node:async_hooks').AsyncLocalStorage;module.exports=require(${projectHook});`,
    );
    return new Map();
  }
  const unresolved: string[] = [];
  const originals = new Map<string, string>();
  await using bundle = await rolldown({
    input: input.patch.instrumentation,
    platform: 'node',
    resolve: { conditionNames: ['node', 'default'] },
    external: [/^node:/u],
    plugins: [
      {
        name: 'upwind-node-instrumentation-project-files',
        async resolveId(source) {
          if (!path.isAbsolute(source)) return null;
          const physical = await realpath(source);
          if (physical === settings.instrumentation) {
            return { id: `/bundle/${settings.nameOf(physical)}`, external: true };
          }
          return null;
        },
        load: {
          filter: { id: /\.(?:[cm]?[jt]sx?|json)$/u },
          async handler(id) {
            if (!path.isAbsolute(id)) return null;
            const file = await realpath(id);
            const bytes = await nodeProofSource(file);
            originals.set(file, await sha256Hex(bytes));
            return { code: bytes.toString('utf8') };
          },
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
    result.output.some((chunk) => {
      return (
        chunk.type === 'chunk' &&
        chunk.imports.some((name) => name.startsWith(CLOUDFLARE_IMPORT_PREFIX))
      );
    })
  ) {
    throw new AuditError('Host instrumentation cannot be represented by a Node Function artifact');
  }
  const modules = result.output.flatMap((chunk) => {
    return chunk.type === 'chunk'
      ? Object.keys(chunk.modules).filter((id) => !isNodeProofCompilerModule(id))
      : [];
  });
  return new Map(
    await Promise.all(
      modules.map(async (id) => {
        if (!path.isAbsolute(id))
          throw new AuditError('Node instrumentation contains an unproved virtual module');
        const file = await realpath(id);
        const hash = originals.get(file);
        // eslint-disable-next-line security/detect-possible-timing-attacks -- Presence of a public source digest is not a secret comparison.
        if (hash === undefined)
          throw new AuditError('Node instrumentation has no original physical source proof');
        return [file, hash] as const;
      }),
    ),
  );
}

function assertNativeSelection(
  selected: readonly NativeLoad[],
  native: readonly NativeLoad[],
): void {
  const missing = selected.some((load) => {
    return native.every((original) => {
      return !(
        original.kind === load.kind &&
        original.importer === load.importer &&
        original.binary === load.binary
      );
    });
  });
  if (missing)
    throw new AuditError(
      'Worker placement selected a native load absent from the original Node graph',
    );
}

function assertNodeTarget(input: BuildFunctionInput, native: readonly NativeLoad[]): void {
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
}

async function addNodeInstrumentation(
  files: NodeArtifactFiles,
  work: string,
): Promise<ReadonlyMap<string, string>> {
  if (files.input.patch.instrumentation === undefined) return new Map();
  const hook = path.join(work, 'instrumentation.cjs');
  const originals = await bundleNodeInstrumentation(files.input, {
    outFile: hook,
    nameOf: files.physical.nameOf,
    instrumentation: files.physical.instrumentation,
  });
  files.add('upwind/instrumentation.cjs', new Uint8Array(await readFile(hook)));
  return originals;
}

async function addNodeEdge(files: NodeArtifactFiles, work: string): Promise<void> {
  if (files.input.edgeEntries.length === 0) {
    files.text('upwind/edge.cjs', 'module.exports={entries:{}};');
    return;
  }
  const edge = await bundleEdge({
    kind: 'node-edge',
    projectDir: files.input.projectDir,
    distDir: files.input.patch.distDir,
    workDir: work,
    entries: files.input.edgeEntries,
    instrumentation: files.input.edgeInstrumentation,
  });
  if (edge.trace.externals.some((name) => name.startsWith(CLOUDFLARE_IMPORT_PREFIX)))
    throw new AuditError(
      'Native Function Edge instrumentation requires unsupported platform bindings',
    );
  files.add('upwind/edge.cjs', new Uint8Array(await readFile(edge.outFile)));
}

async function addNodeRuntime(files: NodeArtifactFiles, work: string): Promise<void> {
  const bindings = path.join(work, 'node-bindings.mjs');
  await bundleNode(files.input, {
    entry: fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-bindings')),
    outFile: bindings,
  });
  files.add('upwind/node-bindings.mjs', new Uint8Array(await readFile(bindings)));
  const runtime = path.join(work, 'function.mjs');
  await bundleNode(files.input, {
    entry: fileURLToPath(import.meta.resolve('@stayingupwind/runtime/function')),
    outFile: runtime,
  });
  files.add('upwind/function.mjs', new Uint8Array(await readFile(runtime)));
}

async function nativeSelectors(native: readonly NativeLoad[]): Promise<string[]> {
  const loaders = native.filter((load) => load.kind === 'node-gyp-build');
  const selectors = await Promise.all(
    loaders.map((load) => nativeLoaderSelectorKeys(load.importer)),
  );
  return [...new Set(selectors.flat())];
}

async function serverSource(files: NodeArtifactFiles): Promise<string> {
  const selectors = await nativeSelectors(files.native);
  const module = fileURLToPath(import.meta.resolve('@stayingupwind/runtime/node-container'));
  const containerModule = jsLiteral(module);
  const cwd = jsLiteral(`/bundle/${files.physical.cwd}`);
  return [
    "import {env as runtimeEnv} from 'node:process';",
    `import {startNodeContainer} from ${containerModule};`,
    "runtimeEnv.NODE_ENV='production';runtimeEnv.NEXT_RUNTIME='nodejs';",
    `if(${JSON.stringify(selectors)}.some(key=>Boolean(runtimeEnv[key])))throw new Error('Native loader environment overrides are unsupported');`,
    `process.chdir(${cwd});`,
    "await startNodeContainer({loadEntry:async()=>{const {default:entry}=await import('./function.mjs');return entry;},port:8080});",
  ].join('\n');
}

async function addNodeServer(files: NodeArtifactFiles, work: string): Promise<void> {
  const source = path.join(work, 'server-source.mjs');
  await writeFile(source, await serverSource(files));
  const server = path.join(work, 'server.mjs');
  await bundleNode(files.input, { entry: source, outFile: server });
  files.add('upwind/server.mjs', new Uint8Array(await readFile(server)));
}

/** A separate physical artifact; app modules are never passed through the Worker patch bundle. */
export async function buildNodeFunction(
  input: BuildFunctionInput,
  selected: readonly NativeLoad[],
): Promise<NodeBuiltFunction> {
  if (selected.length === 0)
    throw new AuditError('A Node Function requires a retained, owned native load');
  const proof = await proveNodeFunction(input);
  const native = proof.native;
  assertNativeSelection(selected, native);
  assertNodeTarget(input, native);
  const abi = assertNativeAbi();
  const physical = await nodePhysicalFiles(input, native);
  const files = new NodeArtifactFiles(input, physical, native);
  const work = path.join(input.outDir, 'work', `node-${input.name ?? input.kind}`);
  await mkdir(work, { recursive: true });
  const instrumentation = await addNodeInstrumentation(files, work);
  assertNodeProofFiles(proof, physical, instrumentation);
  files.rewriteNextFiles();
  await files.addNativeMetadata();
  await files.addNextManifests();
  await files.addPlatformFiles();
  await files.addAppEntry(proof.normalization);
  await addNodeEdge(files, work);
  files.addWasm();
  await addNodeRuntime(files, work);
  await addNodeServer(files, work);
  await files.assertAppEntryNormalization(proof.normalization);
  const archive = nodeArtifactArchive([...files.files.values()]);
  const artifact = await input.blobStore.put(archive, 'application/gzip');
  return {
    spec: { runtime: 'node-container', artifact, entrypoint: 'upwind/server.mjs', abi },
    sourceMaps: await nodeSourceMaps(input, physical, files.files),
    inputs: physical.files.map((file) => ({ file: file.name, bytes: file.bytes.byteLength })),
    dependencies: {
      ...proof.dependencies,
      size: { bytes: archive.byteLength, gzipBytes: archive.byteLength },
    },
  };
}
