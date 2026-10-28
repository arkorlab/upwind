import { AuditError } from './dependencies.ts';
import { listOf, type Node } from './lexical-scope.ts';
import { declaration, identifier, stringOf, type Visit } from './node-manifest-consumer-ast.ts';
import type { NodeManifestTurbopackImport } from './node-manifest-turbopack.ts';

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest ${reason}; refusing native publication`,
  );
}

function rawSpecifier(visit: Visit): string | undefined {
  const node = visit.node;
  if (node.type === 'ImportExpression')
    return stringOf(node['source']) ?? refuse('dynamic original module import');
  if (
    node.type !== 'CallExpression' ||
    !identifier(node['callee']) ||
    node['callee'].name !== 'require' ||
    declaration('require', visit.scopes) !== undefined
  )
    return undefined;
  const args = listOf(node, 'arguments');
  if (node['optional'] === true || args.length !== 1) refuse('original require arguments');
  return stringOf(args[0]) ?? refuse('dynamic original module require');
}

function insideExternalThunk(
  node: Node,
  parents: ReadonlyMap<Node, Visit>,
  tracked: ReadonlyMap<Node, NodeManifestTurbopackImport>,
): boolean {
  let parent = parents.get(node)?.parent;
  while (parent !== undefined) {
    if (tracked.get(parent)?.kind === 'external') return true;
    parent = parents.get(parent)?.parent;
  }
  return false;
}

/** Preserve original physical import edges alongside the generated context-method edges. */
export function originalTurbopackImports(
  visits: readonly Visit[],
  parents: ReadonlyMap<Node, Visit>,
  tracked: ReadonlyMap<Node, NodeManifestTurbopackImport>,
): readonly NodeManifestTurbopackImport[] {
  const result: NodeManifestTurbopackImport[] = [];
  const ordered = visits.toSorted((left, right) => left.node.start - right.node.start);
  for (const visit of ordered) {
    const specifier = rawSpecifier(visit);
    if (specifier === undefined) continue;
    if (specifier.startsWith('turbopack:')) refuse('reserved synthetic module specifier');
    if (insideExternalThunk(visit.node, parents, tracked)) continue;
    result.push({ kind: 'external', specifier });
  }
  return result;
}
