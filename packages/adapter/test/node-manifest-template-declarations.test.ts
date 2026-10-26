import { parseAst } from 'rolldown/parseAst';
import { assert, describe, expect, it } from 'vitest';

import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import { NodeManifestAlpha } from '../src/node-manifest-alpha.ts';
import { nodeManifestTemplateDeclarationView } from '../src/node-manifest-template-declarations.ts';
import { swcTemplateExports } from '../src/node-manifest-template-exports.ts';

function program(code: string): Node {
  const value: unknown = parseAst(code);
  assert(isNode(value));
  return value;
}
function shape(code: string, normalized = true) {
  const original = program(code);
  const body = listOf(original, 'body');
  return new NodeManifestAlpha({
    original,
    body: normalized ? nodeManifestTemplateDeclarationView({ original, body }) : body,
  }).body();
}

describe('template-only initialized declaration DATA', () => {
  it('keeps generic alpha exact while normalizing stable top-level kinds and grouping only in the view', () => {
    const expected = 'const first=read("first");const second=read(first);consume(first,second);';
    const actual = 'var renamed=read("first"),other=read(renamed);consume(renamed,other);';

    expect(shape(actual)).toStrictEqual(shape(expected));
    expect(shape(actual, false)).not.toStrictEqual(shape(expected, false));
    expect(shape(actual.replace('var ', 'let '))).toStrictEqual(shape(expected));
  });

  it('retains initializer object identity, source nodes and evaluation order', () => {
    const original = program('var first=one(),second=two(first);consume(second);');
    const before = JSON.stringify(original);
    const body = listOf(original, 'body');
    const first = body[0];
    assert(isNode(first));
    const variables = listOf(first, 'declarations');
    const view = nodeManifestTemplateDeclarationView({ original, body });

    expect(listOf(view[0] as Node, 'declarations')[0]).toBe(variables[0]);
    expect(listOf(view[1] as Node, 'declarations')[0]).toBe(variables[1]);
    expect(JSON.stringify(original)).toBe(before);
    expect(shape('var a=one(),b=two();consume(a,b);')).not.toStrictEqual(
      shape('const a=two();const b=one();consume(a,b);'),
    );
  });

  it.each([
    'consume(value);var value=42;',
    'var value=value;',
    'var first=second,second=42;',
    'var value=42;value=43;',
    'var value=42;value++;',
    'var value=42;({value}=other);',
    'var value=42;for(value of items){}',
    'var value=42;for(value in items){}',
    'var value=42;var value;',
    'var value=42;var value=43;',
    'var value;',
    'var {value}=other;',
    'var value=42;const closure=()=>value;',
    'var value=42;function closure(){return value;}',
    'var value=42;eval("value");',
  ])('refuses the unproved original binding behavior %s', (code) => {
    expect(() => shape(code)).toThrow('refusing native publication');
  });

  it('does not conflate a nested shadow with the outer binding', () => {
    const code = 'var value=42;consume(value);(()=>{let value=1;value++;})();';

    expect(() => shape(code)).not.toThrow();
  });

  it('recognizes only independently checked non-executing export selectors as deferred reads', () => {
    const original = program(
      'function emit(target,all){for(var key in all)Object.defineProperty(target,key,{enumerable:true,get:all[key]});}emit(exports,{current:function(){return value;}});var value=42;consume(value);',
    );
    const exported = swcTemplateExports(original);

    expect(() =>
      nodeManifestTemplateDeclarationView({ original, body: exported.body }),
    ).not.toThrow();
    expect(() => shape('const object={get current(){return value;}};var value=42;')).toThrow(
      'read before initializer completion',
    );
  });

  it('does not allow a caller to omit original effects from the body', () => {
    const original = program('var value=42;effect();consume(value);');

    expect(() => nodeManifestTemplateDeclarationView({ original, body: [] })).toThrow(
      'body outside fresh export extraction',
    );
  });
});
