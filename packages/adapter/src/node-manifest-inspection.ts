import { normalizedGlobalInspection } from './node-closure-globals.ts';
import { dynamicNodeClosureRefusal } from './node-closure-proof.ts';

/** Original Node globals keep their ordinary audit; rewritten ctx.g retains its stricter proof. */
export function nodeManifestInspectionRefusal(
  code: string,
  options: { readonly normalizedGlobal: boolean; readonly clearScaffold: boolean },
): string | undefined {
  if (!options.normalizedGlobal && !options.clearScaffold) return undefined;
  const inspection = options.normalizedGlobal
    ? normalizedGlobalInspection(code, { nextPatchFlag: options.clearScaffold })
    : `(()=>{\n${code}\n});`;
  return dynamicNodeClosureRefusal('upwind-turbopack-global-inspection.js', inspection);
}
