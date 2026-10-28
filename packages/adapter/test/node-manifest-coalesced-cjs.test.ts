import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import {
  assertCoalescedCjsPartition,
  originalSloppyPagesArrow,
} from '../src/node-manifest-coalesced-cjs.ts';
import {
  assertCoalescedPagesClosure,
  type CoalescedPagesClosureInput,
} from '../src/node-manifest-coalesced-closure.ts';
import { propertyName, visitTree } from '../src/node-manifest-consumer-ast.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackProjection,
} from '../src/node-manifest-turbopack.ts';

function source(code: string) {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
function partition(body: string): CoalescedPagesClosureInput {
  const code = `module.exports=[1,(ctx)=>{${body}}];`;
  const program: unknown = parseAst(code);
  if (!isNode(program)) throw new Error('missing authored program');
  const visits = visitTree(program);
  const factory = visits.find(({ node }) => node.type === 'ArrowFunctionExpression')?.node;
  const write = visits.find(({ node }) => {
    return (
      node.type === 'CallExpression' &&
      isNode(node['callee']) &&
      propertyName(node['callee']) === 's'
    );
  })?.node;
  const table = write === undefined ? undefined : listOf(write, 'arguments')[0];
  if (factory === undefined || !isNode(table)) throw new Error('missing authored factory/table');
  const imports = visits
    .filter(({ node }) => {
      return (
        node.type === 'CallExpression' &&
        isNode(node['callee']) &&
        ['i', 'r', 'x'].includes(propertyName(node['callee']) ?? '')
      );
    })
    .map((visit) => {
      const declaration = visit.parent?.type === 'VariableDeclarator' ? visit.parent : undefined;
      return { call: visit.node, declaration, protected: false };
    });
  return {
    original: program,
    factory,
    table,
    tableValues: listOf(table, 'elements').filter(
      (node, index) => index % 3 === 2 && isNode(node),
    ) as Node[],
    imports,
    forbidden: new Set(),
  };
}
function checked(body: string): void {
  const input = partition(body);
  const owned = assertCoalescedPagesClosure(input);
  assertCoalescedCjsPartition(input, owned);
}
function inspect(body: string): void {
  const input = partition(body);
  const block = input.factory['body'];
  const owned = isNode(block)
    ? listOf(block, 'body').flatMap((statement) => {
        return isNode(statement) && statement.type === 'VariableDeclaration'
          ? listOf(statement, 'declarations').filter(isNode)
          : [];
      })
    : [];
  assertCoalescedCjsPartition(input, owned);
}
function projected(
  factory = '(ctx)=>{ctx.s(["default",0,function Page(){return 1;}],42);const u=ctx.i(42);ctx.v(u);}',
) {
  return projectNodeManifestTurbopackFactory(
    source(`module.exports=[1,${factory}];`),
    1,
    'dependencies',
  );
}
function candidate(code: string): NodeManifestTurbopackProjection {
  const template = projected();
  const parsed: unknown = parseAst(code);
  if (!isNode(parsed)) throw new Error('missing authored program');
  const fn = visitTree(parsed).find(({ node }) => node.type === 'ArrowFunctionExpression')?.node;
  if (fn === undefined) throw new Error('missing authored arrow');
  return {
    ...template,
    original: source(code),
    factory: { ...template.factory, start: fn.start, end: fn.end },
  };
}

describe('original CJS sloppy Pages inspection syntax and partition only', () => {
  it('accepts positive plain sloppy Arrow syntax without inventing a directive', () => {
    const own = projected();
    const before = own.original.code;

    expect(originalSloppyPagesArrow(own)).toBe(true);
    expect(own.original.code).toBe(before);
    expect(own.original.code).not.toContain('use strict');
  });

  it.each(['"use strict";', '"other";"use strict";'])(
    'refuses genuine full Program strict prologues %s',
    (prefix) => {
      expect(originalSloppyPagesArrow(candidate(`${prefix}const factory=(ctx)=>{};`))).toBe(false);
    },
  );

  it.each(['"use\\x20strict";', '("use strict");', ';"use strict";'])(
    'does not turn a non-directive %s into strict authority',
    (prefix) => {
      expect(originalSloppyPagesArrow(candidate(`${prefix}const factory=(ctx)=>{};`))).toBe(true);
    },
  );

  it.each([
    'function outer(){"other";"use strict";return (ctx)=>{};}',
    'class Owner{method(){return (ctx)=>{};}}',
    'export const value=(ctx)=>{};',
  ])('refuses inherited strict/class/module source %s', (code) => {
    expect(originalSloppyPagesArrow(candidate(code))).toBe(false);
  });

  it('does not admit ordinary legacy-function or async factory frames', () => {
    expect(originalSloppyPagesArrow(projected('function(ctx){ctx.v(1);}'))).toBe(false);
    expect(originalSloppyPagesArrow(candidate('const factory=async(ctx)=>{};'))).toBe(false);
  });

  it.each([
    'function Page(){return 1;}ctx.s(["default",0,Page],42);',
    'var addon=ctx.x("authored-addon",()=>require("authored-addon"));function Page(){return addon.value();}ctx.s(["default",0,Page],42);',
    'var addon=ctx.x("authored-addon",()=>require("authored-addon"),true);ctx.s(["default",0,function Page(){return addon.value();}],42);',
    'function Page(arguments){return arguments.value;}ctx.s(["default",0,Page],42);',
  ])('keeps the original closed deferred userland %s', (body) => {
    expect(() => {
      checked(body);
    }).not.toThrow();
  });

  it.each([
    ['implicit arguments', 'ctx.s(["default",0,()=>arguments],42);'],
    [
      'implicit arguments',
      'ctx.s(["default",0,function Page(){var arguments;return arguments;}],42);',
    ],
    ['reflective', 'ctx.s(["default",0,function Page(){return Page.caller;}],42);'],
    ['reflective', 'ctx.s(["default",0,function Page(){const {caller}=Page;return caller;}],42);'],
    ['dynamic scope', 'ctx.s(["default",0,function Page(){with({}){return 1;}}],42);'],
    ['thenable', 'ctx.s(["then",0,function then(){return 1;}],42);'],
    ['eager property', 'ctx.s(["default",0,addon.value],42);'],
    ['eager call', 'ctx.s(["default",0,makePage()],42);'],
    [
      'eager call',
      'var addon=ctx.x("a",()=>require("a"),ctx);ctx.s(["default",0,function Page(){return addon.value;}],42);',
    ],
    [
      'eager call',
      'var addon=ctx.x("a",function(){return require("a");});ctx.s(["default",0,function Page(){return addon.value;}],42);',
    ],
  ])('refuses %s in an erased partition', (message, body) => {
    expect(() => {
      inspect(body);
    }).toThrow(message);
  });

  it('keeps the original closure gate on wrapper captures', () => {
    expect(() => {
      checked('function Page(){return ctx;}ctx.s(["default",0,Page],42);');
    }).toThrow('outer factory parameter capture');
  });
});
