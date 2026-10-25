import assert from 'node:assert/strict';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import {
  assertCoalescedPagesClosure,
  type CoalescedPagesClosureInput,
} from '../src/node-manifest-coalesced-closure.ts';
import { identifier, visitTree, type Visit } from '../src/node-manifest-consumer-ast.ts';

function contextMethod(node: Node): string | undefined {
  const callee = node['callee'];
  if (!isNode(callee) || callee.type !== 'MemberExpression' || callee['computed'] === true)
    return undefined;
  return identifier(callee['object']) &&
    callee['object'].name === 'ctx' &&
    identifier(callee['property'])
    ? callee['property'].name
    : undefined;
}

function sourceImports(
  visits: readonly Visit[],
  factory: Node,
): CoalescedPagesClosureInput['imports'] {
  const parents = new Map(visits.map((visit) => [visit.node, visit.parent]));
  const body = factory['body'];
  const imports: CoalescedPagesClosureInput['imports'][number][] = [];
  for (const { node } of visits) {
    const method = contextMethod(node);
    if (method === undefined || node.type !== 'CallExpression' || !['i', 'r', 'x'].includes(method))
      continue;
    const parent = parents.get(node);
    const statement = parent === undefined ? undefined : parents.get(parent);
    const top = statement === undefined ? undefined : parents.get(statement);
    const declaration = top === body && parent?.type === 'VariableDeclarator' ? parent : undefined;
    const target = listOf(node, 'arguments')[0];
    imports.push({
      call: node,
      ...(declaration !== undefined && { declaration }),
      protected: isNode(target) && target['value'] === 999,
    });
  }
  return imports;
}

function authoredInput(
  before: string,
  value = 'Page',
  after = '',
  forbiddenNames: readonly string[] = [],
): CoalescedPagesClosureInput {
  const parsed: unknown = parseAst(
    `module.exports=[1,function(ctx,module,exports){${before};ctx.s(['default',0,${value}],42);${after}}];`,
  );
  if (!isNode(parsed)) throw new Error('Expected an authored program');
  const visits = visitTree(parsed);
  const factory = visits.find(
    (visit) => visit.node.type === 'FunctionExpression' && visit.parent?.type === 'ArrayExpression',
  )?.node;
  const call = visits.find((visit) => contextMethod(visit.node) === 's')?.node;
  const table = call === undefined ? undefined : listOf(call, 'arguments')[0];
  if (factory === undefined || !isNode(table))
    throw new Error('Expected an authored factory/table');
  const forbidden = new Set<Node>();
  for (const { node } of visits)
    if (identifier(node['id']) && forbiddenNames.includes(node['id'].name)) forbidden.add(node);
  const tableValues = listOf(table, 'elements').filter(
    (item, index): item is Node => index % 3 === 2 && isNode(item),
  );
  return {
    original: parsed,
    factory,
    table,
    tableValues,
    imports: sourceImports(visits, factory),
    forbidden,
  };
}

function owned(before: string, value = 'Page', after = '', forbidden: readonly string[] = []) {
  return assertCoalescedPagesClosure(authoredInput(before, value, after, forbidden)).map((node) => {
    const id = node['id'];
    return identifier(id) ? id.name : undefined;
  });
}

describe('whole-original coalesced Pages lexical closure', () => {
  it.each([
    '()=>42',
    'function Page(n){return n?Page(n-1):42;}',
    'async function Page(){return 42;}',
    'async()=>42',
    'function(arguments){return arguments;}',
  ])('accepts an inert inline function without synthesizing declarations: %s', (value) => {
    expect(owned('', value)).toStrictEqual([]);
  });

  it.each(['var', 'let', 'const'])(
    'keeps stable %s declaration identity independent of the keyword',
    (kind) => {
      expect(owned(`${kind} Page=()=>42`)).toStrictEqual(['Page']);
    },
  );

  it('closes imported JSX and primitive captures while keeping an untouched grouped sibling', () => {
    const before =
      "var jsx=ctx.i(10),label='native',Page=()=>jsx.jsx('p',{children:label}),sibling=ctx.i(11)";

    expect(owned(before)).toStrictEqual(['jsx', 'label', 'Page']);
  });

  it('allows hoisted function declarations while requiring captured data before registration', () => {
    expect(owned("const label='native'", 'Page', 'function Page(){return label;}')).toStrictEqual([
      'label',
      'Page',
    ]);
  });

  it('allows immutable primitive aliases to flow as ordinary return values and call arguments', () => {
    const before =
      "const jsx=ctx.i(10),base='p',label=base,Page=()=>jsx.jsx(label,{children:base})";

    expect(owned(before)).toStrictEqual(['jsx', 'base', 'label', 'Page']);
  });

  it.each(['undefined', 'NaN', 'Infinity'])(
    'keeps unshadowed immutable %s captures primitive',
    (value) => {
      expect(owned(`const value=${value},Page=()=>value`)).toStrictEqual(['value', 'Page']);
    },
  );

  it('uses actual inner scope identity for shadowed wrapper and primitive names', () => {
    const before = "const handler=()=>0,label='outer',Page=(handler,label)=>handler(label)";

    expect(owned(before, 'Page', '', ['handler'])).toStrictEqual(['Page']);
  });

  it('allows exact audited static ordinary dependency calls inside an inert body', () => {
    expect(owned('const Page=()=>ctx.i(10).render()')).toStrictEqual(['Page']);
  });

  it.each([
    '()=>({driver:addon.default})',
    '()=>addon',
    '()=>addon.default',
    '()=>ctx.i(11).consume(addon.default)',
  ])('keeps a sealed ordinary import available inside deferred userland: %s', (value) => {
    expect(owned('const addon=ctx.i(10)', value)).toStrictEqual(['addon']);
  });

  it('closes an imported native driver passed by captured asynchronous userland', () => {
    expect(
      owned('const addon=ctx.i(10),api=ctx.i(11),Page=async()=>api.open({driver:addon.default})'),
    ).toStrictEqual(['addon', 'api', 'Page']);
  });

  it.each([
    'const addon=ctx.i(999),Page=()=>({driver:addon.default})',
    'const addon=ctx.i(10);consume(addon);const Page=()=>addon.default',
    'const addon=ctx.i(10),value={driver:addon.default},Page=()=>value',
    'const addon=ctx.i(10),Page=()=>{addon.default=effect;return addon}',
    'const addon=ctx.i(10),helper=()=>42,Page=()=>addon.consume(helper)',
  ])('keeps protected, eager, mutated and unaudited captured escapes refused: %s', (before) => {
    expect(() => owned(before)).toThrow('coalesced Pages closure');
  });

  it.each([
    '()=>JSON.stringify({page:42})',
    'function Page(){return JSON.stringify({page:42})}',
    '()=>{console.log("page");return 42}',
    '()=>process.cwd()',
  ])('keeps ordinary global calls deferred in an inline value: %s', (value) => {
    expect(owned('', value)).toStrictEqual([]);
  });

  it('closes a deferred captured function using the fixed native fixture globals', () => {
    expect(
      owned(
        'const path=ctx.i(10),Page=async()=>{const file=path.join(process.cwd(),"users.json");console.log(file);return JSON.stringify(file)}',
      ),
    ).toStrictEqual(['path', 'Page']);
  });

  it.each([
    'const Page=()=>JSON',
    'const Page=()=>JSON.stringify',
    'const Page=()=>JSON.parse("42")',
    'const Page=(key)=>JSON[key](42)',
    'const Page=(key)=>globalThis[key](42)',
    'const Page=()=>JSON?.stringify(42)',
    'const Page=()=>JSON.stringify?.(42)',
    'const Page=()=>console.error("page")',
    'const Page=()=>process.cwd("other")',
    'const Page=()=>process.dlopen({},"addon.node")',
    'const Page=()=>JSON.stringify(42);JSON.stringify=effect',
    'const Page=()=>console.log(42);console.log=effect',
    'const Page=()=>process.cwd();process.cwd=effect',
    'const JSON=effect();const Page=()=>JSON.stringify(42)',
    'const value=JSON.stringify(42);const Page=()=>value',
  ])('refuses broader global access, mutation and eager evaluation: %s', (before) => {
    expect(() => owned(before)).toThrow('coalesced Pages closure');
  });

  it.each([
    'const Page=effect()',
    'const Page=class {static value=effect()}',
    'const value=/pattern/;const Page=()=>value',
    'const {Page}=unknown',
  ])('refuses effectful, object-producing or ambiguous captured declarations: %s', (before) => {
    expect(() => owned(before)).toThrow('coalesced Pages closure');
  });

  it.each([
    'const Page=()=>module.exports',
    'const Page=()=>exports.routeModule',
    'const alias=ctx;const Page=()=>alias.r',
    'const Page=()=>globalThis.hidden',
    'const Page=()=>arguments',
    'const Page=function(){return this.hidden}',
    'const Page=function(){return new.target}',
    'const Page=()=>import.meta.url',
    'const Page=()=>{class Hidden{};return Hidden}',
    "const Page=()=>import('hidden')",
  ])('refuses outer authority, unknown globals and implicit constructs: %s', (before) => {
    expect(() => owned(before)).toThrow('coalesced Pages closure');
  });

  it('refuses protected framework dependencies even when their use is deferred', () => {
    expect(() => owned('const dep=ctx.i(999),Page=()=>dep.render()')).toThrow(
      'coalesced Pages closure',
    );
  });

  it('refuses actual wrapper-output bindings and transitive aliases by identity', () => {
    const before = 'const handler=()=>42,alias=handler,Page=()=>alias()';

    expect(() => owned(before, 'Page', '', ['handler'])).toThrow('protected or wrapper capture');
  });

  it.each([
    'Page=()=>1;',
    'function later(){Page=()=>1;}',
    'Page.extra=1;',
    'function later(){Page.extra=1;}',
    'delete Page.extra;',
    'consume(Page);',
    'const alias=Page;',
  ])('checks later and nested mutations or references across the entire original: %s', (after) => {
    expect(() => owned('let Page=()=>42', 'Page', after)).toThrow('coalesced Pages closure');
  });

  it.each(['var Page;var Page=()=>42', 'var Page=()=>42;var Page', 'var Page=()=>42;{var Page;}'])(
    'refuses same-binding redeclarations including uninitialized var: %s',
    (before) => {
      expect(() => owned(before)).toThrow('coalesced Pages closure');
    },
  );

  it('requires alias initializers to precede their actual eager use', () => {
    expect(() => owned('var Page=helper;var helper=()=>42')).toThrow('initializer after use');
  });

  it('refuses captured data initialized only after registration', () => {
    expect(() => owned('function Page(){return label;}', 'Page', "const label='late';")).toThrow(
      'captured initializer after table',
    );
  });

  it.each([
    'const lib=ctx.i(10),helper=()=>42,Page=()=>lib.consume(helper)',
    'const helper=()=>42,Page=()=>helper',
    'const helper=()=>42,Page=()=>({helper})',
    'const helper=()=>42,Page=()=>{const alias=helper;alias.extra=1;return 42}',
  ])(
    'refuses non-primitive captured value escape instead of assuming callback semantics: %s',
    (before) => {
      expect(() => owned(before)).toThrow('captured value escapes');
    },
  );

  it.each([
    'function Page(){Page.extra=1;return 42}',
    'function Page(){function later(){Page.extra=1;}return later()}',
  ])(
    'checks a named inline function self-binding rather than treating it as an unrelated local: %s',
    (value) => {
      expect(() => owned('', value)).toThrow('named function self mutation');
    },
  );

  it('rejects copied value nodes that do not belong to the actual original AST', () => {
    const input = authoredInput('const Page=()=>42');
    const value = input.tableValues[0];
    assert.ok(value, 'Expected an authored original value');
    const copied = { ...value };

    expect(() => assertCoalescedPagesClosure({ ...input, tableValues: [copied] })).toThrow(
      'original value identity',
    );
  });
});
