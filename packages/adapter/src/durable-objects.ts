import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type DurableObjectDeclaration,
  DURABLE_OBJECT_BUNDLE_VERSION,
  DURABLE_OBJECT_SPLIT_BUNDLE_VERSION,
  durableObjectDeclarationsSchema,
  DURABLE_OBJECT_EXPORT,
  type FunctionSpec,
} from '@stayingupwind/core/bundle';
import { UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';
import { build } from 'esbuild';

import { type BlobStore } from './blobs.ts';
import { jsLiteral } from './codegen.ts';
import { auditFunctionSize } from './dependencies.ts';
import { functionSize } from './function-size.ts';
import { FUNCTION_COMPATIBILITY_DATE, FUNCTION_COMPATIBILITY_FLAGS } from './function.ts';

export interface BundledDurableObject {
  readonly declaration: DurableObjectDeclaration;
  readonly source: string;
  /** Absolute dependency paths, for the local server's restart watch. */
  readonly inputs: readonly string[];
}

async function sourcePath(
  projectDir: string,
  declaration: DurableObjectDeclaration,
): Promise<string> {
  const root = await realpath(projectDir);
  const module = await realpath(path.join(root, declaration.module));
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
      });
      const output = result.outputFiles[0];
      if (output === undefined)
        throw new Error(
          `@stayingupwind/adapter: ${declaration.name}: no Durable Object module was emitted`,
        );
      return {
        declaration,
        source: output.text,
        inputs: Object.keys(result.metafile.inputs)
          .filter(
            (input) => input !== '<stdin>' && input !== `${declaration.name}-durable-object.mjs`,
          )
          .map((input) => path.resolve(projectDir, input)),
      };
    }),
  );
}

export async function buildDurableObjectFunctions(input: {
  readonly projectDir: string;
  readonly outDir: string;
  readonly blobs: BlobStore;
  readonly declarations: readonly DurableObjectDeclaration[];
}): Promise<Readonly<Record<string, FunctionSpec>>> {
  const built = await bundleDurableObjects(input.projectDir, input.declarations);
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
    auditFunctionSize(`Durable Object ${object.declaration.name}`, {
      modules,
      size: await functionSize(input.outDir, modules),
    });
    functions[object.declaration.name] = {
      mainModule: 'durable-object.mjs',
      modules,
      compatibilityDate: FUNCTION_COMPATIBILITY_DATE,
      compatibilityFlags: [...FUNCTION_COMPATIBILITY_FLAGS],
    };
  }
  return functions;
}

export async function durableObjectParts(input: {
  readonly projectDir: string;
  readonly outDir: string;
  readonly blobs: BlobStore;
  readonly declarations: readonly DurableObjectDeclaration[] | undefined;
  readonly split: boolean;
}): Promise<{
  bundle: {
    v?: typeof DURABLE_OBJECT_BUNDLE_VERSION | typeof DURABLE_OBJECT_SPLIT_BUNDLE_VERSION;
    durableObjects?: DurableObjectDeclaration[];
  };
  functions: { durableObjects?: Readonly<Record<string, FunctionSpec>> };
}> {
  const raw = process.env[UPWIND_DURABLE_OBJECTS_ENV];
  const declarations = durableObjectDeclarationsSchema.parse(
    input.declarations ?? (raw === undefined || raw === '' ? [] : (JSON.parse(raw) as unknown)),
  );
  if (declarations.length === 0) return { bundle: {}, functions: {} };
  const functions = await buildDurableObjectFunctions({ ...input, declarations });
  return {
    bundle: {
      v: input.split ? DURABLE_OBJECT_SPLIT_BUNDLE_VERSION : DURABLE_OBJECT_BUNDLE_VERSION,
      durableObjects: declarations,
    },
    functions: { durableObjects: functions },
  };
}
