import { realpath } from 'node:fs/promises';

import type { BuildFunctionInput } from './function.ts';
import { projectNodeInstrumentation, type NodeBundledImport } from './node-bundle-closure.ts';
import {
  nodeNextRequireHookRawClosure,
  type NodeNextRequireHookProof,
} from './node-next-require-hook-proof.ts';

/** Original routes/project hook plus the completed hook's actual startup/load roles. */
export async function nodeRawFunctionInputs(
  input: Pick<BuildFunctionInput, 'entries' | 'patch'>,
  hook: NodeNextRequireHookProof | undefined,
): Promise<{
  readonly roots: readonly string[];
  readonly runtimeImports: readonly NodeBundledImport[] | undefined;
}> {
  const projectHook = await projectNodeInstrumentation(input);
  const closure = hook === undefined ? undefined : await nodeNextRequireHookRawClosure(hook);
  return {
    roots: [
      ...(await Promise.all(input.entries.map((entry) => realpath(entry.filePath)))),
      ...(projectHook === undefined ? [] : [projectHook]),
      ...(closure === undefined ? [] : [closure.root.file]),
    ],
    runtimeImports: closure?.imports,
  };
}
