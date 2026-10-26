import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { visitTree } from './node-manifest-consumer-ast.ts';
import type { NodeManifestTurbopackProjection } from './node-manifest-turbopack.ts';

function templateStrict(node: unknown): boolean {
  const expression = isNode(node) ? node['expression'] : undefined;
  return (
    isNode(node) &&
    node.type === 'ExpressionStatement' &&
    isNode(expression) &&
    expression.type === 'Literal' &&
    expression.start === node.start &&
    (expression['raw'] === '"use strict"' || expression['raw'] === "'use strict'")
  );
}

export function withoutStrict(body: readonly unknown[]): readonly unknown[] {
  return templateStrict(body[0]) ? body.slice(1) : body;
}

/** Preserve the existing physical-source strictness gate, independently from helper tokens. */
export function assertStrictFactory(projection: NodeManifestTurbopackProjection): void {
  const parsed: unknown = parseAst(projection.original.code);
  if (!isNode(parsed))
    throw new AuditError(
      'Unproved Next.js Turbopack route template program; refusing native publication',
    );
  const visits = new Map(visitTree(parsed).map((visit) => [visit.node, visit]));
  let factory: Node | undefined;
  const candidates = visits.keys();
  for (const candidate of candidates) {
    if (candidate.start === projection.factory.start && candidate.end === projection.factory.end) {
      factory = candidate;
      break;
    }
  }
  let node = factory;
  while (node !== undefined) {
    if (node.type === 'Program' && templateStrict(listOf(node, 'body')[0])) return;
    const body = node['body'];
    if (
      ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(
        node.type,
      ) &&
      isNode(body) &&
      body.type === 'BlockStatement' &&
      templateStrict(listOf(body, 'body')[0])
    )
      return;
    node = visits.get(node)?.parent;
  }
  throw new AuditError(
    'Unproved Next.js Turbopack route template unproved factory strictness; refusing native publication',
  );
}
