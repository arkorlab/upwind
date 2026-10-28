import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import { NodeManifestAlpha } from '../src/node-manifest-alpha.ts';
import { visitTree } from '../src/node-manifest-consumer-ast.ts';

function parsed(code: string): Node {
  const value: unknown = parseAst(code);
  if (!isNode(value)) throw new Error('Expected an inert source program');
  return value;
}
function view(code: string): unknown {
  const program = parsed(code);
  return new NodeManifestAlpha({
    original: program,
    body: listOf(program, 'body'),
  }).body();
}

describe('inert template alpha view', () => {
  it('preserves binding identity through private names and expanded shorthand properties', () => {
    const first = view(
      'const shared=1;function handler(value){let inner=shared;return {inner,stable:value};}',
    );
    const renamed = view(
      'const root=1;function render(arg){let local=root;return {inner:local,stable:arg};}',
    );

    expect(renamed).toStrictEqual(first);
  });

  it('does not merge an outer binding with a shadowed parameter or change a property key', () => {
    const first = view('const shared=1;function handler(value){return {result:shared+value};}');
    const shadowed = view('const root=1;function render(root){return {result:root+root};}');
    const property = view('const root=1;function render(arg){return {other:root+arg};}');

    expect(shadowed).not.toStrictEqual(first);
    expect(property).not.toStrictEqual(first);
  });

  it('refuses an export selector whose own function binding was removed from the view', () => {
    const program = parsed(
      'const routeModule=1;const getter=function routeModule(){return routeModule;};',
    );
    const statements = listOf(program, 'body');
    const alpha = new NodeManifestAlpha({
      original: program,
      body: statements.slice(0, 1),
    });
    const returned = visitTree(program).find((visit) => visit.node.type === 'ReturnStatement')
      ?.node['argument'];

    expect(() => alpha.shape(returned)).toThrow('selector leaves its lexical scope');
  });
});
