import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type DurableObjectDeclaration,
  DURABLE_OBJECT_BUNDLE_VERSION,
  DURABLE_OBJECT_SPLIT_BUNDLE_VERSION,
  durableObjectDeclarationsSchema,
  DURABLE_OBJECT_EXPORT,
  type FunctionModule,
  type FunctionSpec,
  type SourceMapRef,
} from '@stayingupwind/core/bundle';
import { UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { type OutputChunk, type Plugin, rolldown } from 'rolldown';

import { type BlobStore } from './blobs.ts';
import { jsLiteral } from './codegen.ts';
import {
  auditFunction,
  auditFunctionSize,
  bundled,
  type BundleTrace,
  type FunctionDependencies,
  functionDependencies,
} from './dependencies.ts';
import { dynamicLoadsInChunk } from './dynamic-loads.ts';
import { functionSize } from './function-size.ts';
import { FUNCTION_COMPATIBILITY_DATE, FUNCTION_COMPATIBILITY_FLAGS } from './function.ts';
import { nodeBuiltinRequires } from './node-requires.ts';
import { objectWasm } from './object-wasm.ts';
import { projectOnly } from './project-maps.ts';
import { carriesMaps, type SourceMapsOption, sourcemapOutput } from './source-maps.ts';
import { watchBuildSources } from './source-watch.ts';
import { GLOBAL_OBJECT, globalObjectPlugin, THROWING_GLOBALS } from './throwing-globals.ts';
import { wasmModuleName } from './wasm.ts';

const OBJECT_MODULE = 'durable-object.mjs';
/** The id a class module's generated entry is bundled under: no file is read for it. */
const ENTRY_PREFIX = '\0upwind-durable-object:';
/**
 * What an import is tried with: Rolldown's own extensions, and a stylesheet's, which a module the
 * class shares with the application's pages may import (`moduleTypes`, below).
 */
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'];

export interface BundledDurableObject {
  readonly declaration: DurableObjectDeclaration;
  readonly source: string;
  /** Absolute dependency paths, for the local server's restart watch. */
  readonly inputs: readonly string[];
  readonly wasmModules: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly trace: BundleTrace;
  readonly map?: { readonly path: string; readonly source: string };
}

/** How `bundleDurableObjects` is asked to build. */
interface BundleOptions {
  readonly outDir?: string;
  readonly sourceMaps?: SourceMapsOption;
  /** Adapter output defaults to production; local resources select development. */
  readonly mode?: 'development' | 'production';
  /** Called before reading each source dependency, for local restart detection. */
  readonly onSourceFile?: (file: string) => void;
}

/** The class module's real path, and the project directory's, which the module is checked to be in. */
async function sourcePath(
  projectDir: string,
  declaration: DurableObjectDeclaration,
): Promise<{ readonly root: string; readonly module: string }> {
  const root = await realpath(projectDir);
  let module: string;
  try {
    module = await realpath(path.join(root, declaration.module));
  } catch (error) {
    throw new Error(
      `@stayingupwind/adapter: ${declaration.name}: the Durable Object module ${declaration.module} does not exist or cannot be resolved`,
      { cause: error },
    );
  }
  const relative = path.relative(root, module);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !(await stat(module)).isFile()
  ) {
    throw new Error(
      `@stayingupwind/adapter: ${declaration.name}: the Durable Object module must be a file inside the project directory`,
    );
  }
  return { root, module };
}

/**
 * Whether a module of the bundle is a file it read. A module of the bundler's own — the entry, a
 * built-in's or a compiled module's re-export, Rolldown's runtime — is named by a `\0` id, and an
 * external by its specifier.
 */
function isSourceFile(id: string): boolean {
  return path.isAbsolute(id);
}

/**
 * A file the bundle read, named under the project directory as the caller spells it. Rolldown names
 * a module by its real path, so a project directory reached through a symbolic link — a temporary
 * directory on macOS is one — would see its own files named elsewhere: missed by a caller that looks
 * for them under its own path, and named in the record by a path that climbs out of the project. A
 * file outside the project keeps its real path, which no spelling of the project's could name.
 */
function projectNamed(projectDir: string, root: string, file: string): string {
  const relative = path.relative(root, file);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? file
    : path.join(projectDir, relative);
}

/**
 * The generated entry — the class re-exported under the name the Function exports — and what the
 * build read for it: every module it loaded from a file, those tree-shaking left out of the bundle
 * among them, for the restart watch.
 */
function entryPlugin(id: string, source: string, read: Set<string>): Plugin {
  return {
    name: 'upwind-durable-object-entry',
    resolveId: (specifier, importer) => (specifier === id && importer === undefined ? id : null),
    load: (loaded) => (loaded === id ? source : null),
    buildEnd() {
      // eslint-disable-next-line unicorn/no-this-outside-of-class -- the plugin API hands the context as `this`
      for (const module of this.getModuleIds()) if (isSourceFile(module)) read.add(module);
    },
  };
}

/** One class module, bundled by Rolldown into one ES module of the class code alone. */
async function bundleDurableObject(
  projectDir: string,
  declaration: DurableObjectDeclaration,
  options: BundleOptions,
): Promise<BundledDurableObject> {
  const { root, module } = await sourcePath(projectDir, declaration);
  const named = (file: string): string => projectNamed(projectDir, root, file);
  // The restart watch is told of a file by the name the caller gave its project, as `inputs` are.
  const { onSourceFile } = options;
  const beforeRead =
    onSourceFile === undefined
      ? undefined
      : (file: string): void => {
          onSourceFile(named(file));
        };
  const nodeEnv = jsLiteral(options.mode ?? 'production');
  const entryId = `${ENTRY_PREFIX}${declaration.name}`;
  const read = new Set<string>();
  const wasm = objectWasm(beforeRead);
  const unresolved: string[] = [];
  await using bundle = await rolldown({
    cwd: projectDir,
    input: entryId,
    // Match Wrangler's browser package mappings without implicitly activating `node`: the `browser`
    // field, as a package's entry and as a map of its own files, and the conditions below, to which
    // Rolldown adds `import` or `require` by how a module is imported.
    platform: 'browser',
    resolve: {
      conditionNames: ['workerd', 'worker', 'browser', 'default'],
      extensions: RESOLVE_EXTENSIONS,
    },
    // A stylesheet resolves as any import does and brings nothing into the class module, which has
    // no document for it to style.
    moduleTypes: { '.css': 'empty' },
    external: [/^cloudflare:/u],
    plugins: [
      globalObjectPlugin(),
      entryPlugin(
        entryId,
        `export { ${declaration.className} as ${DURABLE_OBJECT_EXPORT} } from ${jsLiteral(module)};\nexport default {};`,
        read,
      ),
      // After the two above, so that what they answer for — the global object injected into every
      // module, the entry — is never watched as a file of the project's.
      ...(beforeRead === undefined ? [] : [watchBuildSources(beforeRead)]),
      nodeBuiltinRequires(),
      wasm.plugin,
    ],
    transform: {
      target: 'es2024',
      inject: GLOBAL_OBJECT,
      define: {
        ...THROWING_GLOBALS,
        'process.env.NODE_ENV': nodeEnv,
        'global.process.env.NODE_ENV': nodeEnv,
        'globalThis.process.env.NODE_ENV': nodeEnv,
      },
    },
    onLog(_level, log) {
      // A module the bundler cannot find is one the class would not have either: Rolldown leaves a
      // package it cannot find external, with this log. Anything else it says stays with the build.
      if (log.code === 'UNRESOLVED_IMPORT') unresolved.push(log.message);
    },
  });
  const outFile = path.join(
    options.outDir ?? path.join(projectDir, '.upwind'),
    'work',
    `${declaration.name}.mjs`,
  );
  const { output } = await bundle.generate({
    format: 'esm',
    // Where the map's sources are relative to; nothing is written.
    file: outFile,
    codeSplitting: false,
    // Whitespace and syntax, and no name changed.
    minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
    comments: { legal: false },
    ...sourcemapOutput(carriesMaps(options.sourceMaps)),
  });
  // Read once the bundle is generated: Rolldown reads the modules then, and not before.
  if (unresolved.length > 0)
    throw new Error(
      `@stayingupwind/adapter: ${declaration.name}: the Durable Object module ${declaration.module} imports what cannot be resolved\n${unresolved.join('\n')}`,
    );
  const chunk = output.find((item): item is OutputChunk => item.type === 'chunk');
  if (chunk === undefined)
    throw new Error(
      `@stayingupwind/adapter: ${declaration.name}: no Durable Object module was emitted`,
    );
  const wasmModules = wasm.collector.modules.map((entry) => {
    return {
      name: wasmModuleName(entry.sha256),
      bytes: entry.bytes,
    };
  });
  const internalImports = new Set(wasmModules.map((entry) => `./${entry.name}`));
  return {
    declaration,
    source: chunk.code,
    // In a stable order: Rolldown reads modules in parallel, and lists them as they were read.
    inputs: [...read, ...wasm.inputs.keys()]
      .map((file) => named(file))
      .toSorted((a, b) => compareCodeUnits(a, b)),
    wasmModules,
    trace: {
      inputs: [
        ...Object.entries(chunk.modules)
          .filter(([file]) => isSourceFile(file))
          .map(([file, rendered]) => bundled(named(file), rendered)),
        ...[...wasm.inputs].map(([file, input]) => ({ file: named(file), bytes: input.bytes })),
      ],
      externals: [...chunk.imports, ...chunk.dynamicImports].filter(
        (specifier) => !internalImports.has(specifier),
      ),
      patches: [],
      stubs: [],
      wasmModules: [],
      compiledWasmModules: [...wasm.inputs].map(([file, input]) => {
        return {
          file: named(file),
          module: input.module,
        };
      }),
      dynamicLoads: dynamicLoadsInChunk(chunk).map((load) =>
        isSourceFile(load.file) ? { ...load, file: named(load.file) } : load,
      ),
    },
    ...(chunk.map !== null && { map: { path: `${outFile}.map`, source: chunk.map.toString() } }),
  };
}

/** Build class code alone; no Next.js runtime or host cache code is included. */
export async function bundleDurableObjects(
  projectDir: string,
  declarations: readonly DurableObjectDeclaration[],
  options: BundleOptions = {},
): Promise<BundledDurableObject[]> {
  const checked = durableObjectDeclarationsSchema.parse(declarations);
  return Promise.all(
    checked.map(async (declaration) => bundleDurableObject(projectDir, declaration, options)),
  );
}

export async function buildDurableObjectFunctions(input: {
  readonly projectDir: string;
  readonly outDir: string;
  readonly blobs: BlobStore;
  readonly declarations: readonly DurableObjectDeclaration[];
  readonly sourceMaps?: SourceMapsOption;
  readonly distDir?: string;
}): Promise<{
  functions: Readonly<Record<string, FunctionSpec>>;
  sourceMaps: SourceMapRef[];
  dependencies: Readonly<Record<string, FunctionDependencies>>;
}> {
  const built = await bundleDurableObjects(input.projectDir, input.declarations, input);
  const sourceMaps: SourceMapRef[] = [];
  const dependencies: Record<string, FunctionDependencies> = {};
  const functions: Record<string, FunctionSpec> = Object.create(null) as Record<
    string,
    FunctionSpec
  >;
  for (const object of built) {
    const modules: FunctionModule[] = [
      {
        name: OBJECT_MODULE,
        type: 'esm' as const,
        blob: await input.blobs.putText(object.source, 'text/javascript'),
      },
    ];
    for (const module of object.wasmModules)
      modules.push({
        name: module.name,
        type: 'wasm',
        blob: await input.blobs.put(module.bytes, 'application/wasm'),
      });
    const upload = {
      modules,
      size: await functionSize(input.outDir, modules),
    };
    const kind = `durable-object/${object.declaration.name}`;
    const record = functionDependencies(
      input.projectDir,
      input.distDir ?? path.join(input.projectDir, '.next'),
      object.trace,
      upload,
    );
    auditFunctionSize(kind, upload);
    auditFunction(kind, { app: object.source }, record);
    dependencies[kind] = record;
    if (object.map !== undefined) {
      const source =
        input.sourceMaps === 'project'
          ? projectOnly(object.map.source, object.map.path, {
              projectDir: input.projectDir,
              outDir: input.outDir,
              distDir: input.distDir ?? path.join(input.projectDir, '.next'),
            })
          : object.map.source;
      sourceMaps.push({
        kind: 'function',
        name: `${kind}/${OBJECT_MODULE}`,
        blob: await input.blobs.putText(source, 'application/json'),
      });
    }
    functions[object.declaration.name] = {
      mainModule: OBJECT_MODULE,
      modules,
      compatibilityDate: FUNCTION_COMPATIBILITY_DATE,
      compatibilityFlags: [...FUNCTION_COMPATIBILITY_FLAGS],
    };
  }
  return { functions, sourceMaps, dependencies };
}

export async function durableObjectParts(input: {
  readonly projectDir: string;
  readonly outDir: string;
  readonly blobs: BlobStore;
  readonly declarations: readonly DurableObjectDeclaration[] | undefined;
  readonly split: boolean;
  readonly sourceMaps?: SourceMapsOption;
  readonly distDir?: string;
}): Promise<{
  bundle: {
    v?: typeof DURABLE_OBJECT_BUNDLE_VERSION | typeof DURABLE_OBJECT_SPLIT_BUNDLE_VERSION;
    durableObjects?: DurableObjectDeclaration[];
  };
  functions: { durableObjects?: Readonly<Record<string, FunctionSpec>> };
  sourceMaps: SourceMapRef[];
  dependencies: Readonly<Record<string, FunctionDependencies>>;
}> {
  const raw = process.env[UPWIND_DURABLE_OBJECTS_ENV];
  let declarations: DurableObjectDeclaration[];
  try {
    declarations = durableObjectDeclarationsSchema.parse(
      input.declarations ?? (raw === undefined || raw === '' ? [] : (JSON.parse(raw) as unknown)),
    );
  } catch (error) {
    const origin = input.declarations === undefined ? ` in ${UPWIND_DURABLE_OBJECTS_ENV}` : '';
    throw new Error(`@stayingupwind/adapter: invalid Durable Object declarations${origin}`, {
      cause: error,
    });
  }
  if (declarations.length === 0)
    return { bundle: {}, functions: {}, sourceMaps: [], dependencies: {} };
  const built = await buildDurableObjectFunctions({ ...input, declarations });
  return {
    bundle: {
      v: input.split ? DURABLE_OBJECT_SPLIT_BUNDLE_VERSION : DURABLE_OBJECT_BUNDLE_VERSION,
      durableObjects: declarations,
    },
    functions: { durableObjects: built.functions },
    sourceMaps: built.sourceMaps,
    dependencies: built.dependencies,
  };
}
