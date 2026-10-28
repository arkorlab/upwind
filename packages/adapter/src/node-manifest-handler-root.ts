import {
  assertCurrentNodeManifestCompilerRoot,
  certifyNodeManifestCompilerRoot,
  nodeManifestCompilerRoot,
  type NodeManifestCompilerRootBinding,
  type NodeManifestCompilerRootInput,
} from './node-manifest-compiler-root.ts';
import { manifestConstructorImport } from './node-manifest-framework.ts';
import { NODE_MANIFEST_HANDLER_PROFILES } from './node-manifest-handler-catalog.ts';

/** Native Pages only, and only when the private static registry actually needs an origin slot. */
export async function prepareNodeManifestHandlerCompilerRoot(
  input: NodeManifestCompilerRootInput,
  sources: Iterable<{ readonly file: string; readonly sha256: string }>,
): Promise<NodeManifestCompilerRootBinding | undefined> {
  if (NODE_MANIFEST_HANDLER_PROFILES.every((profile) => profile.literalSlots.length === 0)) return;
  let pages = false;
  for (const source of sources)
    if (manifestConstructorImport(source.file, source.sha256)?.kind === 'pages') pages = true;
  if (!pages) return;
  // Filtered or invalid metadata keeps the root proof's explicit refusal. No root is guessed.
  const proof = await certifyNodeManifestCompilerRoot(input);
  return proof === undefined ? undefined : Object.freeze({ proof, input });
}
export async function assertCurrentUsedNodeManifestHandlerCompilerRoot(
  binding: NodeManifestCompilerRootBinding | undefined,
  files: readonly { readonly file: string; readonly sha256: string }[],
): Promise<void> {
  if (binding === undefined) return;
  const metadata = nodeManifestCompilerRoot(binding.proof, binding.input).metadata;
  if (files.some((source) => source.file === metadata.file && source.sha256 === metadata.sha256))
    await assertCurrentNodeManifestCompilerRoot(binding.proof, binding.input);
}
