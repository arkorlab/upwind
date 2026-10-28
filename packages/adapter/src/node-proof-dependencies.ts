import type { OutputChunk } from 'rolldown';

import { bundled, functionDependencies, type FunctionDependencies } from './dependencies.ts';
import { dynamicLoadsOf } from './dynamic-loads.ts';
import type { BuildFunctionInput } from './function.ts';
import type { AppliedPatch } from './patches/rolldown.ts';

/** The proved original graph's record: what it retains, leaves to Node and loads at run time. */
export function nodeProofDependencies(
  input: Pick<BuildFunctionInput, 'projectDir' | 'patch'>,
  chunk: OutputChunk,
  graph: { readonly externals: ReadonlySet<string>; readonly patches: readonly AppliedPatch[] },
  compilerModules: ReadonlySet<string>,
): FunctionDependencies {
  return functionDependencies(
    input.projectDir,
    input.patch.distDir,
    {
      inputs: Object.entries(chunk.modules).map(([file, module]) => bundled(file, module)),
      externals: [...graph.externals],
      patches: graph.patches,
      stubs: [],
      wasmModules: [],
      // Exact, byte-sealed production runtimes have separately proven compiler operations.
      // Their actual target chunks still pass the ordinary retained-code audit.
      dynamicLoads: Object.entries(chunk.modules).flatMap(([file, module]) =>
        module.code === null || compilerModules.has(file) ? [] : dynamicLoadsOf(file, module.code),
      ),
    },
    { modules: [], size: { bytes: Buffer.byteLength(chunk.code), gzipBytes: 0 } },
  );
}
