import { nodeCachePolicyPatch } from './node-cache-policy.ts';
import { nativeTurbopackSelectorPatch } from './node-turbopack-selector.ts';
import { instrumentationPatch } from './patches/instrumentation.ts';
import type { AppliedPatch } from './patches/rolldown.ts';
import { turbopackRuntimePatch } from './patches/turbopack-runtime.ts';
import type { PatchContext } from './patches/types.ts';

// These expose the original Node graph. No Worker-specific code or dependency is substituted.
const GRAPH_LINKS = [
  turbopackRuntimePatch,
  instrumentationPatch,
  nodeCachePolicyPatch,
  nativeTurbopackSelectorPatch,
];

interface OriginalGraphSource {
  readonly sources: ReadonlyMap<string, { readonly file: string }>;
  readonly patches: AppliedPatch[];
}

/** Apply only the fixed original-graph policies after the caller has captured each raw SHA. */
export function linkedOriginalNodeSource(
  code: string,
  id: string,
  patchContext: PatchContext,
  graph: OriginalGraphSource,
): string {
  let contents = code;
  for (const patch of GRAPH_LINKS) {
    const file = patch === nativeTurbopackSelectorPatch ? (graph.sources.get(id)?.file ?? id) : id;
    if (!patch.target.test(file) || (patch.marker !== undefined && !patch.marker(contents)))
      continue;
    // Raw Node loads each original chunk with its own CommonJS coordinates. Worker-only
    // copy substitution must not change the physical sources this analysis inspects.
    const context =
      patch === turbopackRuntimePatch ? { ...patchContext, copies: undefined } : patchContext;
    const result = patch.apply(contents, file, context);
    graph.patches.push({ patch: patch.name, file: id, result });
    contents = result.contents;
  }
  return contents;
}
