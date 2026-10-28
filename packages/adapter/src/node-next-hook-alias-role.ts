import { isBuiltin } from 'node:module';

import type { ManifestGraphEdge, ManifestModuleGraph } from './node-manifest-graph.ts';

// This is the sole graph-only compiler identity accepted by node-proof.ts.
const ROLLDOWN_RUNTIME = '\0rolldown/runtime.js';

interface AliasRoleData {
  readonly qualification: 'UNQUALIFIED DATA';
  readonly requiresOwned: boolean;
  readonly sha256: string | undefined;
}
interface AliasTarget {
  readonly request: string;
  readonly target: string;
}

function role(requiresOwned: boolean, sha256: string | undefined): AliasRoleData {
  return Object.freeze({ qualification: 'UNQUALIFIED DATA', requiresOwned, sha256 });
}

function edgeRole(
  graph: ManifestModuleGraph,
  alias: AliasTarget,
  edge: ManifestGraphEdge,
): boolean | undefined {
  const target = graph.sources.get(edge.target);
  if (
    edge.specifier === alias.request ||
    edge.target === alias.target ||
    target?.file === alias.target
  )
    return true;
  if (target === undefined && !isBuiltin(edge.target) && edge.target !== ROLLDOWN_RUNTIME)
    return undefined;
  return false;
}

function callerRole(
  graph: ManifestModuleGraph,
  alias: AliasTarget,
  id: string,
): boolean | undefined {
  if (id !== ROLLDOWN_RUNTIME && !graph.sources.has(id)) return undefined;
  const edges = graph.imports?.get(id);
  if (edges === undefined)
    return id === ROLLDOWN_RUNTIME && !graph.sources.has(id) ? false : undefined;
  for (const edge of edges) {
    const found = edgeRole(graph, alias, edge);
    if (found !== false) return found;
  }
  return false;
}

/** Resolution inventory only; the private hook proof still owns source and execution authority. */
export function nodeNextHookAliasRoleData(
  graph: ManifestModuleGraph,
  alias: AliasTarget,
): AliasRoleData | undefined {
  const rows = [...graph.sources].filter(([, own]) => own.file === alias.target);
  const sha256 = rows[0]?.[1].sha256;
  if (rows.some(([, own]) => own.sha256 !== sha256)) return undefined;
  if (rows.some(([id]) => graph.retained.has(id))) return role(true, sha256);
  if (graph.imports === undefined) return undefined;
  for (const id of graph.retained) {
    const found = callerRole(graph, alias, id);
    if (found === undefined) return undefined;
    if (found) return role(true, sha256);
  }
  return role(false, sha256);
}
