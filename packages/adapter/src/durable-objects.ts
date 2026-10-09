import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type DurableObjectDeclaration,
  DURABLE_OBJECT_BUNDLE_VERSION,
  DURABLE_OBJECT_SPLIT_BUNDLE_VERSION,
  durableObjectDeclarationsSchema,
  DURABLE_OBJECT_EXPORT,
  type FunctionSpec,
  type SourceMapRef,
} from '@stayingupwind/core/bundle';
import { UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';
import { build } from 'esbuild';

import { type BlobStore } from './blobs.ts';
import { jsLiteral } from './codegen.ts';
import {
  auditFunction,
  auditFunctionSize,
  type BundleTrace,
  type FunctionDependencies,
  functionDependencies,
} from './dependencies.ts';
import { dynamicLoadsOf } from './dynamic-loads.ts';
import { functionSize } from './function-size.ts';
import { FUNCTION_COMPATIBILITY_DATE, FUNCTION_COMPATIBILITY_FLAGS } from './function.ts';
import { projectOnly } from './project-maps.ts';
import { carriesMaps, type SourceMapsOption } from './source-maps.ts';

export interface BundledDurableObject {
  readonly declaration: DurableObjectDeclaration;
  readonly source: string;
  /** Absolute dependency paths, for the local server's restart watch. */
  readonly inputs: readonly string[];
  readonly trace: BundleTrace;
  readonly map?: { readonly path: string; readonly source: string };
}

async function sourcePath(
  projectDir: string,
  declaration: DurableObjectDeclaration,
): Promise<string> {
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
  return module;
}

/** Build class code alone; no Next.js runtime or host cache code is included. */
export async function bundleDurableObjects(
  projectDir: string,
  declarations: readonly DurableObjectDeclaration[],
  options: { readonly outDir?: string; readonly sourceMaps?: SourceMapsOption } = {},
): Promise<BundledDurableObject[]> {
  const checked = durableObjectDeclarationsSchema.parse(declarations);
  return Promise.all(
    checked.map(async (declaration) => {
      const module = await sourcePath(projectDir, declaration);
      const result = await build({
        absWorkingDir: projectDir,
        stdin: {
          contents: `export { ${declaration.className} as ${DURABLE_OBJECT_EXPORT} } from ${jsLiteral(module)};\nexport default {};`,
          resolveDir: projectDir,
          sourcefile: `${declaration.name}-durable-object.mjs`,
        },
        bundle: true,
        write: false,
        outfile: path.join(
          options.outDir ?? path.join(projectDir, '.upwind'),
          'work',
          `${declaration.name}.mjs`,
        ),
        format: 'esm',
        platform: 'node',
        target: 'es2022',
        conditions: ['workerd', 'worker'],
        external: ['cloudflare:*', 'node:*'],
        metafile: true,
        minifyWhitespace: true,
        minifySyntax: true,
        minifyIdentifiers: false,
        legalComments: 'none',
        logLevel: 'silent',
        sourcemap: carriesMaps(options.sourceMaps) && 'external',
        sourcesContent: false,
      });
      const output = result.outputFiles.find((file) => file.path.endsWith('.mjs'));
      if (output === undefined)
        throw new Error(
          `@stayingupwind/adapter: ${declaration.name}: no Durable Object module was emitted`,
        );
      const emitted = Object.values(result.metafile.outputs).find(
        (file) => file.entryPoint !== undefined,
      );
      if (emitted === undefined)
        throw new Error(
          `@stayingupwind/adapter: ${declaration.name}: no Durable Object output trace was emitted`,
        );
      const inputs = Object.keys(result.metafile.inputs)
        .filter(
          (input) => input !== '<stdin>' && input !== `${declaration.name}-durable-object.mjs`,
        )
        .map((input) => path.resolve(projectDir, input));
      const map = result.outputFiles.find((file) => file.path.endsWith('.map'));
      return {
        declaration,
        source: output.text,
        inputs,
        trace: {
          inputs: Object.entries(emitted.inputs).map(([file, input]) => {
            const absoluteFile = path.resolve(projectDir, file);
            return { file: absoluteFile, bytes: input.bytesInOutput };
          }),
          externals: emitted.imports
            .filter((entry) => entry.external === true)
            .map((entry) => entry.path),
          patches: [],
          stubs: [],
          wasmModules: [],
          dynamicLoads: dynamicLoadsOf(module, output.text),
        },
        ...(map !== undefined && { map: { path: map.path, source: map.text } }),
      };
    }),
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
    const modules = [
      {
        name: 'durable-object.mjs',
        type: 'esm' as const,
        blob: await input.blobs.putText(object.source, 'text/javascript'),
      },
    ];
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
        name: `${kind}/durable-object.mjs`,
        blob: await input.blobs.putText(source, 'application/json'),
      });
    }
    functions[object.declaration.name] = {
      mainModule: 'durable-object.mjs',
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
