import { AuditError } from './dependencies.ts';
import type { NodeBundledImport } from './node-bundle-closure.ts';
import type { ManifestGraphFile } from './node-manifest-graph.ts';
import type { NodeNextSharedRuntimeEdge } from './node-next-require-hook-proof.ts';

/** DATA projection only; the caller first validates its completed private hook proof. */
export function nodeNextHookRawClosureData(input: {
  readonly file: string;
  readonly files: ReadonlyMap<string, ManifestGraphFile>;
  readonly edges: readonly NodeNextSharedRuntimeEdge[];
}): { readonly root: ManifestGraphFile; readonly imports: readonly NodeBundledImport[] } {
  const pin = (file: string): ManifestGraphFile => {
    const own = input.files.get(file);
    if (own === undefined) throw new AuditError('Fixed Next raw load source is missing');
    return Object.freeze({ file, sha256: own.sha256 });
  };
  return Object.freeze({
    root: pin(input.file),
    imports: Object.freeze(
      input.edges.map((edge) => Object.freeze({ from: pin(edge.caller), to: pin(edge.target) })),
    ),
  });
}
