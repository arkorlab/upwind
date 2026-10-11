import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type FunctionModule,
  type FunctionSpec,
  type ManifestHead,
  manifestHead,
  type SourceMapRef,
} from '@stayingupwind/core/bundle';
import {
  type InputOptions,
  type OutputChunk,
  type Plugin as RolldownPlugin,
  rolldown,
} from 'rolldown';

import { type BlobStore, contentTypeFor } from './blobs.ts';
import { jsLiteral } from './codegen.ts';
import { constExportSettersPlugin } from './const-export-setters.ts';
import {
  auditTracedFiles,
  auditFunction,
  auditFunctionSize,
  bundled,
  bundleDependencies,
  type BundleTrace,
  type FunctionDependencies,
  functionDependencies,
  outputNameOf,
} from './dependencies.ts';
import { dynamicLoadsInChunk } from './dynamic-loads.ts';
import { bundleEdge, type EdgeEntry } from './edge.ts';
import { functionSize } from './function-size.ts';
import { APP_MODULE } from './generated-modules.ts';
import type { KeptMaps } from './kept-maps.ts';
import {
  bundleLinkedExternals,
  type LinkedExternals,
  linkedImportsPlugin,
} from './linked-externals.ts';
import type { TextModule } from './manifests.ts';
import {
  type AppliedPatch,
  externalsPlugin,
  OG_FONT_FILE,
  OG_FONT_MODULE,
  type PatchContext,
  PATCHES,
  patchesPlugin,
  sharedRuntimePlugin,
  stubPlugin,
  styledJsxPlugin,
  vendoredOtelPlugin,
  wasmModulePlugin,
  FUNCTION_BANNER,
} from './patches/index.ts';
import { bundleRuntimeModule } from './runtime-bundle.ts';
import {
  carriesMaps,
  codeModules,
  functionSourceMaps,
  type SourceMapsOption,
  sourceMapsPlugin,
  sourcemapOutput,
} from './source-maps.ts';
import { THROWING_GLOBALS, throwingGlobalsPlugin } from './throwing-globals.ts';
import type { TracedFile } from './traced-files.ts';
import { WASM_ENTRY_MODULE, type WasmCollector, wasmEntrySource, wasmModuleName } from './wasm.ts';

/**
 * The runtime the user Function is uploaded against. Pinned rather than following the platform's own
 * Functions: a deployment's semantics must not shift underneath it when the platform moves its date.
 */
export const FUNCTION_COMPATIBILITY_DATE = '2026-09-15';
/**
 * `global_fetch_strictly_public`: a `fetch()` to the application's own hostname goes out the front
 * door, as it does from `next start` or any other host, and reaches the application. Without it a
 * request to a hostname on the zone the Function serves goes to the zone's origin, past every Worker
 * routed there — for a Function served by a Worker on that zone's route, nothing — and fails at once
 * (`522`). Next.js makes such requests itself: a Server Action forwarded to the page that has it, the
 * RSC payload of the page an action redirects to; and applications make them to their own API routes.
 *
 * The flag is the zone's, not the hostname's: every `fetch()` to any hostname of that zone goes out the
 * front door, through whatever Workers and security the zone has, and none goes to its origin. It is
 * given to every Function the adapter builds, the middleware's as well as the application's.
 */
export const FUNCTION_COMPATIBILITY_FLAGS: readonly string[] = [
  'nodejs_compat',
  'global_fetch_strictly_public',
];

const RUNTIME_MODULE = 'index.mjs';
const RUNTIME_MANIFEST_MODULE = 'runtime.json';
const BLOB_MODULE_PREFIX = 'blobs/';

export interface EntryModule {
  /** Key the runtime asks for (`/[locale]`, `/api/auth/[...all]`, `/_middleware`). */
  readonly id: string;
  /** Absolute path of the built module (`.next/server/app/[locale]/page.js`). */
  readonly filePath: string;
}

/**
 * The Functions a deployment may have: `app` always, `middleware` when the project has a proxy, and
 * `workflow` when it uses the Workflow SDK (`workflow.ts`).
 */
export type FunctionKind = 'app' | 'middleware' | 'workflow';

export interface BuildFunctionInput {
  readonly kind: FunctionKind;
  /**
   * The Function's own name, where it is not its kind: `app-2`, `app-3`… for the app Functions
   * after the first of a build that split its routes across several (`split.ts`). It names the
   * Function's code modules, its source maps and everything the build writes for it, so that no two
   * Functions of one deployment name one thing alike.
   */
  readonly name?: string | undefined;
  readonly projectDir: string;
  readonly outDir: string;
  readonly patch: PatchContext;
  readonly entries: readonly EntryModule[];
  /** The entrypoints `next build` put on the edge runtime; they go into a bundle of their own. */
  readonly edgeEntries: readonly EdgeEntry[];
  /** The WebAssembly this Function carries, one module per distinct file (see `wasm.ts`). */
  readonly wasm: WasmCollector;
  readonly manifests: readonly TextModule[];
  /** Contents of `runtime.json`: what the runtime needs to know about the deployment. */
  readonly runtimeManifest: string;
  /** The module `arkor:cache-host` resolves to; a build given none gets no runtime cache. */
  readonly cacheHostModule: string | undefined;
  /** Blobs to ship inside the Function (prerendered bodies and postponed states). */
  readonly blobs: readonly { sha256: string; bytes: Uint8Array }[];
  /** The files the entries read through `node:fs`, at their paths in the project (`traced-files.ts`). */
  readonly files: readonly TracedFile[];
  readonly blobStore: BlobStore;
  /**
   * Carry a map from this Function's bundle back to the sources it was built from; `'project'`, to
   * the project's own files only (`projectOnly`).
   */
  readonly sourceMaps?: SourceMapsOption;
  /** The maps that came through the build's `runAfterProductionCompile` (`kept-maps.ts`). */
  readonly keptMaps?: KeptMaps | undefined;
  /**
   * Leave the Function's size to the caller to judge: a build that may yet split its routes builds
   * one Function first to weigh, and a Function too large is then a reason to split it rather than
   * a failure. Whatever is finally uploaded is held to the limit all the same.
   */
  readonly deferSizeAudit?: boolean | undefined;
  /** Whether the build carries the Workflow SDK, in any of its Functions (`workflow.ts`). */
  readonly workflowSdk?: boolean | undefined;
}

function nameOf(input: BuildFunctionInput): string {
  return input.name ?? input.kind;
}

/**
 * The runtime manifest as the middleware Function is given it: which deployment and build it is,
 * and its configuration — none of the routes, prerenders and files the app Function answers by.
 *
 * The middleware Function answers the middleware alone, run ahead of a shell the edge serves, and
 * reads the base path of the manifest to do it (`deploymentConfig`, in the runtime). The rest would
 * be parsed all the same on its first request — the manifest of an application with a few thousand
 * prerenders runs to megabytes — on the Function whose cold start that shell waits on. The runtime
 * reads it by the same list of fields (`MANIFEST_HEAD_KEYS`).
 */
export function middlewareManifest<T extends Readonly<Record<keyof ManifestHead, unknown>>>(
  manifest: T,
): Pick<T, keyof ManifestHead> {
  return manifestHead(manifest);
}

/** Module name a blob is shipped under; the runtime reads it back at `/bundle/blobs/<sha256>`. */
function blobModuleName(sha256: string): string {
  return `${BLOB_MODULE_PREFIX}${sha256}`;
}

function appEntrySource(entries: readonly EntryModule[]): string {
  const table = entries
    .map((entry) => `  ${jsLiteral(entry.id)}: () => require(${jsLiteral(entry.filePath)}),`)
    .join('\n');
  return [
    '// Generated by @stayingupwind/adapter: the entrypoints `next build` produced, by route.',
    'module.exports = {',
    '  entries: {',
    table,
    '  },',
    '};',
    '',
  ].join('\n');
}

function runtimeEntry(): string {
  return fileURLToPath(import.meta.resolve('@stayingupwind/runtime/function'));
}

/** What the app bundle is built against: the rewrites it applies, and what it may resolve. */
export interface AppBundleContext {
  readonly patch: PatchContext;
  readonly wasm: WasmCollector;
  /** Compose the maps the build already wrote through into this bundle's own. */
  readonly sourceMaps?: boolean | undefined;
  /** Where to find a chunk's map that a hook took away (`kept-maps.ts`). */
  readonly keptMaps?: KeptMaps | undefined;
  /**
   * Whether this is the workflow Function: the one Function the Workflow SDK's engine is in, and the
   * one whose `node:vm` import is stubbed (`workflow.ts`). Anywhere else the audit refuses it.
   */
  readonly workflowFunction?: boolean | undefined;
}

/** What `bundleApp` collects as Rolldown runs, for the dependency record. */
export interface AppBundleSinks {
  readonly patches: AppliedPatch[];
  readonly stubs: string[];
  readonly externals: Set<string>;
  /** `.wasm` files the bundler resolved itself, as `<file> -> <global>`. */
  readonly wasm: string[];
  /** The names the chunks import packages linked under `.next/node_modules` by (`linked-externals.ts`). */
  readonly linked: Set<string>;
}

/**
 * Every plugin an app bundle is built with, named in one place.
 *
 * Each of these is the reason something that would otherwise fail the build or the Function does
 * not, or the reason the audit knows what it knows: a Next.js file rewritten, a module-loader
 * hook emptied, an optional package resolved to the copy Next.js ships, and the built-ins left
 * to the Function reported as they resolve. Dropping one is silent — the bundle still builds, and
 * what it broke shows up in a customer's build or in their running Function — so the set is
 * asserted by name. (The loads the bundler could not follow are read off what it rendered, not
 * collected as it runs: see `dynamicLoadsInChunk`.)
 */
export function appBundlePlugins(
  context: AppBundleContext,
  sinks: AppBundleSinks,
): RolldownPlugin[] {
  return [
    throwingGlobalsPlugin(),
    patchesPlugin(PATCHES, context.patch, (applied) => {
      sinks.patches.push(applied);
    }),
    // After the patches, so a file a patch rewrote is never given a map that no longer describes
    // it; see `sourceMapsPlugin`. Left out entirely for a build carrying no maps: it would read
    // the tail of every file the bundle loads for a comment nothing would use.
    ...(context.sourceMaps === true ? [sourceMapsPlugin(context.keptMaps)] : []),
    constExportSettersPlugin(),
    stubPlugin((specifier) => {
      sinks.stubs.push(specifier);
    }, context.workflowFunction === true),
    wasmModulePlugin(context.wasm, (file, global) => {
      sinks.wasm.push(`${file} -> ${global}`);
    }),
    vendoredOtelPlugin(),
    sharedRuntimePlugin(),
    styledJsxPlugin(context.patch.projectDir),
    externalsPlugin((specifier) => sinks.externals.add(specifier)),
    linkedImportsPlugin((id) => sinks.linked.add(id)),
  ];
}

/**
 * How the app Function's code is bundled: with the plugins above, and everything left to the
 * Function's own resolver reported — a module Rolldown cannot resolve, which it leaves to the
 * Function as it would a built-in, with a log, is recorded as an external too, for the audit to
 * refuse, which is what esbuild's refusal to build came to. Nothing else Rolldown has to say
 * reaches the build's output.
 */
export function appBundleOptions(
  projectDir: string,
  entryFile: string,
  context: AppBundleContext,
  sinks: AppBundleSinks,
): InputOptions {
  return {
    cwd: projectDir,
    input: entryFile,
    // Node built-ins, with or without the `node:` prefix, are the Function's own to resolve.
    platform: 'node',
    plugins: appBundlePlugins(context, sinks),
    transform: {
      inject: THROWING_GLOBALS,
      define: {
        'process.env.NEXT_RUNTIME': '"nodejs"',
        'process.env.NODE_ENV': '"production"',
      },
    },
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT' && log.exporter !== undefined) {
        sinks.externals.add(log.exporter);
      }
    },
  };
}

/**
 * The app Function's code: Next.js's CommonJS output, bundled by Rolldown into one CommonJS module
 * with the patches applied as each file is loaded. Rolldown's output is 5% smaller than esbuild's
 * for the same graph and comes 40% sooner (see EXPERIMENTS.md, V-03); the runtime bundle is
 * Rolldown's as well (`bundleRuntime`). Whitespace and syntax are minified, names are not: the
 * audit reads them.
 */
async function bundleApp(
  input: BuildFunctionInput,
  workDir: string,
): Promise<{ outFile: string; trace: BundleTrace; linked: ReadonlySet<string> }> {
  const entryFile = path.join(workDir, `${nameOf(input)}-entry.cjs`);
  const outFile = path.join(workDir, `${nameOf(input)}-${APP_MODULE}`);
  await writeFile(entryFile, appEntrySource(input.entries));
  const sinks: AppBundleSinks = {
    patches: [],
    stubs: [],
    externals: new Set(),
    wasm: [],
    linked: new Set(),
  };
  await using bundle = await rolldown(
    appBundleOptions(
      input.projectDir,
      entryFile,
      {
        patch: input.patch,
        wasm: input.wasm,
        ...(carriesMaps(input.sourceMaps) && { sourceMaps: true, keptMaps: input.keptMaps }),
        ...(input.kind === 'workflow' && { workflowFunction: true }),
      },
      sinks,
    ),
  );
  const { output } = await bundle.write({
    format: 'cjs',
    file: outFile,
    // One file, so an `import()` the bundler can follow — `@vercel/og`'s edge build, which the
    // `vercel-og` patch turns Turbopack's external into — is inlined into it rather than split
    // out into a chunk the Function would have to load. It stays lazy: the module it names is
    // wrapped in an initializer the `import()` runs, so the library is evaluated by the first
    // request that renders an image and by no other.
    codeSplitting: false,
    banner: FUNCTION_BANNER,
    minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
    comments: { legal: false },
    ...sourcemapOutput(carriesMaps(input.sourceMaps)),
  });
  const chunk = output.find((item): item is OutputChunk => item.type === 'chunk');
  if (chunk === undefined) {
    throw new Error(`@stayingupwind/adapter: the ${nameOf(input)} Function bundled to no chunk`);
  }
  return {
    outFile,
    trace: {
      inputs: Object.entries(chunk.modules).map(([file, module]) => bundled(file, module)),
      externals: [...sinks.externals],
      patches: sinks.patches,
      stubs: sinks.stubs,
      wasmModules: sinks.wasm,
      dynamicLoads: dynamicLoadsInChunk(chunk),
    },
    linked: sinks.linked,
  };
}

async function bundleRuntime(input: BuildFunctionInput, workDir: string): Promise<string> {
  const outFile = path.join(workDir, `${nameOf(input)}-${RUNTIME_MODULE}`);
  await bundleRuntimeModule({
    entry: runtimeEntry(),
    outFile,
    moduleName: RUNTIME_MODULE,
    kind: input.kind,
    name: nameOf(input),
    workflowSdk: input.workflowSdk === true,
    modules: codeModules(nameOf(input)),
    edge: input.edgeEntries.length > 0,
    wasm: input.wasm.hasCandidates,
    cacheHostModule: input.cacheHostModule,
  });
  return outFile;
}

export interface BuiltFunction {
  readonly spec: FunctionSpec;
  readonly dependencies: FunctionDependencies;
  /** The maps of this Function's own modules; empty unless the host asked for them. */
  readonly sourceMaps: SourceMapRef[];
  /**
   * What each file put into the Function's code, by the path the bundler read it at: `app.cjs`'s
   * and `edge.cjs`'s modules. What a plan weighs a route's code with (`split.ts`).
   */
  readonly inputs: readonly {
    readonly file: string;
    readonly bytes: number;
    /** Bundled into `edge.cjs` rather than `app.cjs`: a file both bundle is in each, weighed twice. */
    readonly edge?: true | undefined;
  }[];
}

/**
 * The two patches that can be the Turbopack WebAssembly loader, one per shape Next.js has shipped:
 * a module of its own from 16.3, and the Turbopack runtime itself in 16.2 (`wasm-loader.ts`). A
 * build reaches exactly one of them, and which is the version's business rather than this audit's.
 */
const WASM_LOADER_PATCHES: ReadonlySet<string> = new Set(['runtime-wasm-loader', 'wasm-loader']);
const OG_FONT_PATCH = 'vercel-og-font';

/**
 * The bytes of `next/og`'s fallback font, read from the very file the patch was applied to, or
 * `undefined` when this bundle carries no `@vercel/og` at all. Reading it off the patched file's
 * own directory is what keeps the two in step: the font that travels is the one that library
 * would have read.
 */
async function ogFallbackFont(applied: readonly AppliedPatch[]): Promise<Uint8Array | undefined> {
  const patched = applied.find((item) => item.patch === OG_FONT_PATCH);
  if (patched === undefined) {
    return undefined;
  }
  const font = path.join(path.dirname(patched.file), OG_FONT_FILE);
  return new Uint8Array(await readFile(font));
}

/**
 * The one patch that finds its file by what is in it rather than by its name, held to the same
 * word as the others: a build whose Node.js entrypoints bundle WebAssembly must have rewritten
 * Turbopack's loader. Without this, a loader that moved somewhere the patch does not look leaves
 * a Function that reads a `.wasm` off a file system it does not have, and says so on the first
 * request rather than here.
 *
 * The other way round is not a mismatch: a Function may bundle the loader from a chunk it shares
 * with something else while none of its own entrypoints reaches WebAssembly, and the table the
 * patch leaves is then empty and never asked.
 */
function auditWasmLoader(
  kind: string,
  patch: PatchContext,
  applied: readonly AppliedPatch[],
): void {
  if (patch.wasm.length === 0) {
    return;
  }
  if (applied.every((item) => !WASM_LOADER_PATCHES.has(item.patch))) {
    throw new Error(
      `@stayingupwind/adapter: the ${kind} Function's entrypoints bundle WebAssembly (${patch.wasm
        .map((item) => item.chunkPath)
        .join(', ')}) but no Turbopack WebAssembly loader was found to rewrite`,
    );
  }
}

/** The packages the chunks import from `.next/node_modules`, as modules of the Function's. */
async function linkedModules(
  blobStore: BlobStore,
  linked: LinkedExternals | undefined,
): Promise<FunctionModule[]> {
  if (linked === undefined) {
    return [];
  }
  return Promise.all(
    linked.modules.map(async (module) => {
      return {
        name: module.name,
        type: 'esm' as const,
        blob: await blobStore.putFile(module.file, 'text/javascript'),
      };
    }),
  );
}

/** The source of every such module, as the audit reads one bundle's. */
async function linkedSource(linked: LinkedExternals): Promise<string> {
  const sources = await Promise.all(linked.modules.map((module) => readFile(module.file, 'utf8')));
  return sources.join('\n');
}

/**
 * Bundle one Function and register its modules as blobs: the upload specification, and the record
 * of what went into it — audited, so a Function that would not run fails the build.
 */
export async function buildFunction(input: BuildFunctionInput): Promise<BuiltFunction> {
  const workDir = path.join(input.outDir, 'work');
  await mkdir(workDir, { recursive: true });
  const name = nameOf(input);
  const names = codeModules(name);
  const [app, runtimeFile, edge] = await Promise.all([
    bundleApp(input, workDir),
    bundleRuntime(input, workDir),
    input.edgeEntries.length === 0
      ? undefined
      : bundleEdge({
          kind: name,
          projectDir: input.projectDir,
          workDir,
          entries: input.edgeEntries,
          ...(carriesMaps(input.sourceMaps) && { sourceMaps: true, keptMaps: input.keptMaps }),
        }),
  ]);
  const appFile = app.outFile;
  // What the chunks import from `.next/node_modules`, named only once the app bundle has run.
  const linked = await bundleLinkedExternals({
    distDir: input.patch.distDir,
    workDir,
    kind: name,
    ids: app.linked,
  });
  const modules: FunctionModule[] = [
    {
      name: RUNTIME_MODULE,
      type: 'esm',
      blob: await input.blobStore.putFile(runtimeFile, contentTypeFor(runtimeFile)),
    },
    {
      name: names.app,
      type: 'commonjs',
      blob: await input.blobStore.putFile(appFile, contentTypeFor(appFile)),
    },
    ...(edge === undefined
      ? []
      : [
          {
            name: names.edge,
            type: 'commonjs' as const,
            blob: await input.blobStore.putFile(edge.outFile, contentTypeFor(edge.outFile)),
          },
        ]),
    {
      name: RUNTIME_MANIFEST_MODULE,
      type: 'text',
      blob: await input.blobStore.putText(input.runtimeManifest, 'application/json'),
    },
    ...(await linkedModules(input.blobStore, linked)),
  ];
  for (const manifest of input.manifests) {
    modules.push({
      name: manifest.name,
      type: 'text',
      blob: await input.blobStore.putText(manifest.contents, contentTypeFor(manifest.name)),
    });
  }
  for (const blob of input.blobs) {
    modules.push({
      name: blobModuleName(blob.sha256),
      type: 'data',
      blob: await input.blobStore.put(blob.bytes, 'application/octet-stream'),
    });
  }
  const wasmModules = input.wasm.modules;
  // Whenever the runtime bundle was built with a `./wasm.mjs` to import — which is decided
  // before the app bundle has resolved its `?module` imports — the module has to be there, even
  // if in the end nothing read any of the WebAssembly the traces offered.
  if (input.wasm.hasCandidates) {
    modules.push({
      name: WASM_ENTRY_MODULE,
      type: 'esm',
      blob: await input.blobStore.putText(wasmEntrySource(wasmModules), 'text/javascript'),
    });
    for (const module of wasmModules) {
      modules.push({
        name: wasmModuleName(module.sha256),
        type: 'wasm',
        blob: await input.blobStore.put(module.bytes, 'application/wasm'),
      });
    }
  }
  // `next/og`'s fallback font, when the bundle carries the library that reads it. Only then: it
  // is 126 KiB an application that renders no image never has to carry.
  const font = await ogFallbackFont(app.trace.patches);
  if (font !== undefined) {
    modules.push({
      name: OG_FONT_MODULE,
      type: 'data',
      blob: await input.blobStore.put(font, 'font/ttf'),
    });
  }
  // A file the application reads is found at its path in the project, which no module of the
  // Function's own may hold as well (`auditTracedFiles`).
  auditTracedFiles(name, modules, input.files);
  for (const file of input.files) {
    modules.push({
      name: file.name,
      type: 'data',
      blob: await input.blobStore.putFile(file.filePath, contentTypeFor(file.filePath)),
    });
  }
  const { distDir } = input.patch;
  const size = await functionSize(input.outDir, modules);
  const dependencies: FunctionDependencies = {
    ...functionDependencies(input.projectDir, distDir, app.trace, { modules, size }),
    ...(edge !== undefined && {
      edge: bundleDependencies(input.projectDir, distDir, edge.trace),
    }),
    ...(linked !== undefined && {
      linked: bundleDependencies(input.projectDir, distDir, linked.trace),
    }),
  };
  auditWasmLoader(name, input.patch, app.trace.patches);
  auditFunctionSize(name, { modules, size }, input.deferSizeAudit === true);
  auditFunction(
    name,
    {
      app: await readFile(appFile, 'utf8'),
      ...(edge !== undefined && { edge: await readFile(edge.outFile, 'utf8') }),
      ...(linked !== undefined && { linked: await linkedSource(linked) }),
    },
    dependencies,
    outputNameOf(input.projectDir, distDir),
  );
  return {
    spec: {
      mainModule: RUNTIME_MODULE,
      modules,
      compatibilityDate: FUNCTION_COMPATIBILITY_DATE,
      compatibilityFlags: [...FUNCTION_COMPATIBILITY_FLAGS],
    },
    dependencies,
    sourceMaps: await builtSourceMaps(input, { name, app: appFile, edge }),
    inputs: [
      ...app.trace.inputs,
      ...(edge === undefined
        ? []
        : edge.trace.inputs.map((each) => ({ ...each, edge: true as const }))),
    ],
  };
}

/** The maps of a Function's own code, as the host asked for them: none, whole, or the project's. */
async function builtSourceMaps(
  input: BuildFunctionInput,
  built: {
    readonly name: string;
    readonly app: string;
    readonly edge: { readonly outFile: string } | undefined;
  },
): Promise<SourceMapRef[]> {
  if (!carriesMaps(input.sourceMaps)) {
    return [];
  }
  const project =
    input.sourceMaps === 'project'
      ? { projectDir: input.projectDir, distDir: input.patch.distDir, outDir: input.outDir }
      : undefined;
  return functionSourceMaps(
    input.blobStore,
    built.name,
    { app: built.app, edge: built.edge?.outFile },
    project,
  );
}
