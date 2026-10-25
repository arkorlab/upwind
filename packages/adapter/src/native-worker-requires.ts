import type { Node } from '@oxc-project/types';
import type { OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { type NativeBindings, stringOf, walk } from './native-ast.ts';
import { retainedWorkerCapabilityNodes } from './native-worker.ts';

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
function authenticatedWorkerRequires(
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

/** Unknown helpers are possible origins for refusal only, never authenticated capabilities. */
function compilerRequireTexts(chunk: OutputChunk): ReadonlySet<string> {
  const runtime = chunk.modules[COMPILER_RUNTIME];
  if (runtime?.code === null || runtime?.code === undefined) return new Set();
  const code = runtime.code;
  return new Set(
    walk(parseAst(code)).flatMap((node) => {
      return node.type === 'VariableDeclarator' &&
        node.id.type === 'Identifier' &&
        node.id.name === REQUIRE_EXPORT
        ? [code.slice(node.start, node.end)]
        : [];
    }),
  );
}

function unboundRequireInitializer(node: Node, bindings: NativeBindings): boolean {
  const tree = walk(node);
  const names = new Set<Node>();
  for (const child of tree) {
    if (child.type === 'MemberExpression' && !child.computed) names.add(child.property);
    if (
      (child.type === 'Property' ||
        child.type === 'MethodDefinition' ||
        child.type === 'PropertyDefinition') &&
      !child.computed &&
      !(child.type === 'Property' && child.shorthand && child.key === child.value)
    )
      names.add(child.key);
  }
  return tree.some((child) => {
    return (
      child.type === 'Identifier' &&
      child.name === 'require' &&
      !names.has(child) &&
      bindings.lookup(child, 'require') === undefined
    );
  });
}

function possibleWorkerRequires(
  chunk: OutputChunk,
  tree: readonly Node[],
  bindings: NativeBindings,
): ReadonlySet<Node> {
  const metadata = compilerRequireTexts(chunk);
  const declarations = new Set<Node>();
  for (const node of tree) {
    if (
      node.type !== 'CallExpression' ||
      node.callee.type !== 'Identifier' ||
      node.arguments.length !== 1
    )
      continue;
    const specifier = stringOf(node.arguments[0]);
    if (specifier !== 'node:worker_threads' && specifier !== 'worker_threads') continue;
    const declared = bindings.lookup(node.callee, node.callee.name);
    if (
      declared?.type === 'VariableDeclarator' &&
      (metadata.has(chunk.code.slice(declared.start, declared.end)) ||
        (declared.init !== null && unboundRequireInitializer(declared.init, bindings)))
    )
      declarations.add(declared);
  }
  return declarations;
}

export function renderedWorkerRequires(
  chunk: OutputChunk,
  tree: readonly Node[],
  bindings: NativeBindings,
): ReadonlySet<Node> {
  const authenticated = authenticatedWorkerRequires(chunk, tree, bindings);
  const possible = new Set(authenticated);
  for (const declaration of possibleWorkerRequires(chunk, tree, bindings))
    possible.add(declaration);
  const refusalBindings: NativeBindings = {
    ...bindings,
    // Overapproximate even a changed helper only to refuse its ambiguous capability, never to grant it.
    unmodified(node, name, members) {
      const declared = bindings.lookup(node, name);
      return (
        (declared !== undefined && declared !== null && possible.has(declared)) ||
        bindings.unmodified(node, name, members)
      );
    },
  };
  const knownSites = new Set(retainedWorkerCapabilityNodes(tree, bindings, authenticated));
  if (
    retainedWorkerCapabilityNodes(tree, refusalBindings, possible).some(
      (site) => !knownSites.has(site),
    )
  )
    throw new AuditError('A retained Node Worker has ambiguous compiler require provenance');
  return authenticated;
}
