import type { Node } from '@oxc-project/types';
import type { OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { type NativeBindings, walk } from './native-ast.ts';

const COMPILER_RUNTIME = '\0rolldown/runtime.js';
const REQUIRE_EXPORT = '__require';

function globalRequireReferences(node: Node, bindings: NativeBindings): boolean {
  const tree = walk(node);
  let found = false;
  for (const child of tree) {
    if (child.type !== 'Identifier' || child.name !== 'require') continue;
    found = true;
    if (
      bindings.lookup(child, 'require') !== undefined ||
      !bindings.unmodified(child, 'require', false)
    )
      return false;
  }
  return found;
}

/** Compiler metadata authenticates this refusal origin; an application helper name never does. */
export function renderedWorkerRequires(
  chunk: OutputChunk,
  tree: readonly Node[],
  bindings: NativeBindings,
): ReadonlySet<Node> {
  const runtime = chunk.modules[COMPILER_RUNTIME];
  if (runtime?.code === null || runtime?.code === undefined) return new Set();
  if (!runtime.renderedExports.includes(REQUIRE_EXPORT)) return new Set();
  const runtimeTree = walk(parseAst(runtime.code));
  const declarations = runtimeTree.filter((node) => {
    return (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.id.name === REQUIRE_EXPORT
    );
  });
  const declared = declarations[0];
  if (declared === undefined || declarations.length !== 1) return new Set();
  const rendered = runtime.code.slice(declared.start, declared.end);
  const matches = tree.filter(
    (node) =>
      node.type === 'VariableDeclarator' && chunk.code.slice(node.start, node.end) === rendered,
  );
  const actual = matches[0];
  if (actual === undefined || matches.length !== 1) return new Set();
  if (actual.type !== 'VariableDeclarator' || actual.id.type !== 'Identifier') return new Set();
  if (!bindings.unmodified(actual, actual.id.name, false)) return new Set();
  if (!globalRequireReferences(actual, bindings)) return new Set();
  return new Set([actual]);
}
