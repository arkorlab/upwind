import path from 'node:path';

import { beneath } from './build-paths.ts';
import {
  nodeManifestCompilerRoot,
  type NodeManifestCompilerRootBinding,
} from './node-manifest-compiler-root.ts';
import type { NodeManifestHandlerProfile } from './node-manifest-handler-catalog.ts';
import type { NodeManifestHandlerGraphInput } from './node-manifest-handler-graph.ts';
import { nodeManifestHandlerOrigin } from './node-manifest-handler-sources.ts';

/** Path comparison DATA only. The private context checks raw pins and asynchronous freshness. */
export function nodeManifestHandlerLiteralValues(input: {
  readonly binding: NodeManifestCompilerRootBinding | undefined;
  readonly distDir: string;
  readonly nextRoot: string;
  readonly profile: Pick<NodeManifestHandlerProfile, 'literalSlots' | 'sources'>;
}): NodeManifestHandlerGraphInput['literalSlots'] {
  if (input.binding === undefined || input.profile.literalSlots.length === 0) return;
  const basis = nodeManifestCompilerRoot(input.binding.proof, input.binding.input);
  if (
    basis.compilerRoot !== basis.canonicalCompilerRoot ||
    basis.projectDir !== basis.canonicalProjectDir ||
    basis.distDir !== basis.canonicalDistDir ||
    basis.canonicalDistDir !== input.distDir
  )
    return;
  const actual: { readonly key: string; readonly value: string }[] = [];
  for (const slot of input.profile.literalSlots) {
    if (
      !['compiler-relative-next-source-directory-with-trailing-slash'].includes(slot.origin.kind) ||
      input.profile.sources.every((pin) => pin.relative !== slot.origin.relative)
    )
      return;
    const source = nodeManifestHandlerOrigin(input.nextRoot, slot.origin.relative);
    const relative = beneath(basis.compilerRoot, path.dirname(source))?.split(path.sep).join('/');
    if (relative === undefined || relative.length === 0) return;
    actual.push({ key: slot.key, value: `/ROOT/${relative}/` });
  }
  return { expected: input.profile.literalSlots, actual };
}
