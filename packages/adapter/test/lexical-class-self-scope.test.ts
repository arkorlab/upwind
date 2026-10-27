import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { childrenOf, isNode, scopeOpenedBy, type Node, type Scope } from '../src/lexical-scope.ts';
import { declaration, visitTree } from '../src/node-manifest-consumer-ast.ts';

interface ScopedNode {
  readonly node: Node;
  readonly scopes: readonly Scope[];
}

function genericVisits(root: Node): ScopedNode[] {
  const visits: ScopedNode[] = [];
  const pending: { readonly value: unknown; readonly scopes: readonly Scope[] }[] = [
    { value: root, scopes: [] },
  ];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    if (Array.isArray(next.value)) {
      pending.push(...next.value.map((value: unknown) => ({ value, scopes: next.scopes })));
    } else if (isNode(next.value)) {
      const scope = scopeOpenedBy(next.value);
      const scopes = scope === undefined ? next.scopes : [...next.scopes, scope];
      visits.push({ node: next.value, scopes });
      pending.push(...childrenOf(next.value).map((value) => ({ value, scopes })));
    }
  }
  return visits;
}

function authored(source: string) {
  const parsed: unknown = parseAst(source);
  if (!isNode(parsed)) throw new Error('Missing authored program');
  return { program: parsed, source, visits: genericVisits(parsed) };
}

function expressionsOf(input: ReturnType<typeof authored>): Node[] {
  return input.visits
    .filter(({ node }) => node.type === 'ClassExpression')
    .map(({ node }) => node)
    .toSorted((left, right) => left.start - right.start);
}

function requiredNode(node: Node | undefined): Node {
  if (node === undefined) throw new Error('Missing authored class');
  return node;
}

function bindingAt(input: ReturnType<typeof authored>, snippet: string, name: string) {
  const statementStart = input.source.indexOf(snippet);
  const nameOffset = snippet.lastIndexOf(name);
  if (statementStart === -1 || nameOffset === -1) throw new Error('Missing authored reference');
  const visit = input.visits.find(({ node }) => node.start === statementStart + nameOffset);
  if (visit?.node.type !== 'Identifier') throw new Error('Missing authored identifier');
  return declaration(name, visit.scopes);
}

describe('named class expression scopes from authored AST only', () => {
  it('binds the original class node throughout heritage, computed keys and the body', () => {
    const input = authored(
      'const Self=outer;const Value=class Self extends Self{[Self](){return Self;}field=Self;static{consume(Self);}};const outside=Self;',
    );
    const self = requiredNode(expressionsOf(input)[0]);
    const scope = scopeOpenedBy(self);

    expect(scope?.declared).toStrictEqual(new Set(['Self']));
    expect(scope?.constants.size).toBe(0);
    expect(scope?.bindings.get('Self')).toBe(self);

    for (const snippet of [
      'extends Self',
      '[Self]',
      'return Self',
      'field=Self',
      'consume(Self)',
    ]) {
      expect(bindingAt(input, snippet, 'Self')?.node).toBe(self);
    }
    const outside = bindingAt(input, 'outside=Self', 'Self')?.node;

    expect(outside?.type).toBe('VariableDeclarator');
    expect(outside).not.toBe(self);
  });

  it.each(['globalThis', 'Function'])(
    'keeps class-local %s separate from the surrounding global',
    (name) => {
      const input = authored(
        `const Value=class ${name} extends ${name}{[${name}](){return ${name};}};consume(${name});`,
      );
      const [self] = expressionsOf(input);

      expect(self).toBeDefined();

      for (const snippet of [`extends ${name}`, `[${name}]`, `return ${name}`]) {
        expect(bindingAt(input, snippet, name)?.node).toBe(self);
      }

      expect(bindingAt(input, `consume(${name})`, name)).toBeUndefined();
    },
  );

  it('restores the outer class self-name after a nested same-name class', () => {
    const input = authored(
      'const Value=class Self{method(){const Inner=class Self extends Self{[Self](){return Self;}};return Self;}};',
    );
    const [outer, inner] = expressionsOf(input);

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(bindingAt(input, 'extends Self', 'Self')?.node).toBe(inner);
    expect(bindingAt(input, '[Self]', 'Self')?.node).toBe(inner);
    expect(bindingAt(input, 'return Self;}};return Self', 'Self')?.node).toBe(outer);
  });

  it('allows a method parameter to shadow the class self-name locally', () => {
    const input = authored(
      'const Value=class Self{method(Self){return Self;}other(){return Self;}};',
    );
    const [self] = expressionsOf(input);

    expect(bindingAt(input, 'method(Self){return Self', 'Self')).toStrictEqual({ node: undefined });
    expect(bindingAt(input, 'other(){return Self', 'Self')?.node).toBe(self);
  });

  it('does not invent a self binding for anonymous classes or class declarations', () => {
    const input = authored(
      'const Outer=value;const Value=class extends Outer{method(){return Outer;}};class Named{}',
    );
    const anonymous = requiredNode(expressionsOf(input)[0]);
    const named = requiredNode(
      input.visits.find(({ node }) => node.type === 'ClassDeclaration')?.node,
    );

    expect(scopeOpenedBy(anonymous)).toBeUndefined();
    expect(scopeOpenedBy(named)).toBeUndefined();
    expect(bindingAt(input, 'extends Outer', 'Outer')?.node?.type).toBe('VariableDeclarator');
  });

  it.each([
    'const Self=outer;const Value=class Self extends Self{[Self](){return Self;}};consume(Self);',
    'const Value=class globalThis{method(globalThis){return globalThis;}other(){return globalThis;}};',
    'const Value=class Function{method(){return class Function extends Function{};}};',
    'const Value=class{method(){return Function;}};',
  ])('keeps the existing manifest visitor scope inventory for %s', (source) => {
    const input = authored(source);
    const manifest = new Map(visitTree(input.program).map((visit) => [visit.node, visit.scopes]));
    for (const visit of input.visits) {
      expect(manifest.get(visit.node)).toStrictEqual(visit.scopes);
    }

    expect(manifest.size).toBe(input.visits.length);
  });
});
