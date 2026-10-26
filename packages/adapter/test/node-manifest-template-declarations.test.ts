import { parseAst } from 'rolldown/parseAst';
import { assert, describe, expect, it } from 'vitest';

import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import { NodeManifestAlpha } from '../src/node-manifest-alpha.ts';
import { nodeManifestTemplateDeclarationView } from '../src/node-manifest-template-declarations.ts';
import { swcTemplateExports } from '../src/node-manifest-template-exports.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import { mutatePagesEsmFixture, pagesEsmFixture } from './fixtures/node-manifest-pages-esm.ts';

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

  it('disregards only top-level empty statements while generic Alpha remains exact', () => {
    const original = ';var value=read();;consume(value);;';
    const expected = 'const value=read();consume(value);';

    expect(shape(original)).toStrictEqual(shape(expected));
    expect(shape(original, false)).not.toStrictEqual(shape(expected, false));
  });

  it('retains original AST identity and raw directive position before the view filter', () => {
    const original = program(';"use strict";var value=42;;consume(value);');
    const body = listOf(original, 'body');
    const before = JSON.stringify(original);
    const directive = body[1];
    const view = nodeManifestTemplateDeclarationView({ original, body });

    expect(view[0]).toBe(directive);
    expect((directive as Node).start).toBeGreaterThan(0);
    expect(body[0]).toMatchObject({ type: 'EmptyStatement' });
    expect(JSON.stringify(original)).toBe(before);
  });

  it.each([
    ['{;}', '{}'],
    ['if(test);', 'if(test){}'],
    ['for(;;);', 'for(;;){}'],
    ['label:;', ';'],
    ['function task(){;return 1;}task();', 'function task(){return 1;}task();'],
    [
      'function task(){;"use strict";return 1;}task();',
      'function task(){"use strict";return 1;}task();',
    ],
    [
      'var value=42;;{let value=1;consume(value);}consume(value);',
      'const value=42;{const value=1;consume(value);}consume(value);',
    ],
  ])('keeps nested statements and shadow declarations exact: %s', (actual, expected) => {
    expect(shape(actual)).not.toStrictEqual(shape(expected));
  });

  it('rejects a caller-supplied body that already removed or cloned original empty statements', () => {
    const original = program(';var value=42;;consume(value);');
    const body = listOf(original, 'body');
    const filtered = body.filter((node) => !isNode(node) || node.type !== 'EmptyStatement');
    const cloned = body.map((node) => (isNode(node) ? { ...node } : node));

    expect(() => nodeManifestTemplateDeclarationView({ original, body: filtered })).toThrow(
      'body outside fresh export extraction',
    );
    expect(() => nodeManifestTemplateDeclarationView({ original, body: cloned })).toThrow(
      'body outside fresh export extraction',
    );
  });

  it.each([
    'consume(value);;var value=42;',
    'var value=42;;value=43;',
    'var value=42;;{var value=1;}',
    'var value=42;;const closure=()=>value;',
  ])('preserves original TDZ, write, redeclaration and capture checks: %s', (code) => {
    expect(() => shape(code)).toThrow('refusing native publication');
  });
});

describe('complete Pages ESM template with original top-level empty statements', () => {
  it('retains the same helper ports, raw source and normalization obligation', async () => {
    const input = await pagesEsmFixture();
    const original = input.projection.original.code;
    const semicolons = mutatePagesEsmFixture(input, '"use strict";', '"use strict";;;;');
    const changed = mutatePagesEsmFixture(semicolons, 'var moduleNs=', ';;var moduleNs=');
    const code = changed.projection.original.code;
    const proof = await assertNodeManifestTurbopackTemplateConsumer(changed);

    expect(proof).toMatchObject({ kind: 'pages', requiresRuntimeNormalization: true });
    expect(proof.exports).toContain('routeModule');
    expect(proof.exports).toContain('handler');
    expect(changed.imports).toBe(input.imports);
    expect(changed.projection.original.code).toBe(code);
    expect(input.projection.original.code).toBe(original);
  });

  it.each(['effect();', '0;'])(
    'does not discard an extra original expression %s',
    async (expression) => {
      const input = await pagesEsmFixture();
      const changed = mutatePagesEsmFixture(input, '"use strict";', `"use strict";;${expression};`);

      await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
        'refusing native publication',
      );
    },
  );

  it.each([';"use strict";', ';"use\\x20strict";', ';("use strict");'])(
    'does not promote a non-prologue or false original directive %s',
    async (directive) => {
      const input = mutatePagesEsmFixture(await pagesEsmFixture(), '"use strict";', directive);

      await expect(assertNodeManifestTurbopackTemplateConsumer(input)).rejects.toThrow(
        'factory strictness',
      );
    },
  );
});
