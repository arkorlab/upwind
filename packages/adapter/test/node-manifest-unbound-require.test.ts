import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, listOf } from '../src/lexical-scope.ts';
import { identifier, propertyName, visitTree } from '../src/node-manifest-consumer-ast.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import { unboundTurbopackRequire } from '../src/node-manifest-unbound-require.ts';

function source(body: string) {
  const code = `module.exports=[1,((ctx)=>{${body}})];`;
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

function dependencies(body: string, mode: 'dependencies' | 'strict' = 'dependencies') {
  const program: unknown = parseAst(`module.exports=[1,((ctx)=>{${body}})];`);
  if (!isNode(program)) throw new Error('Expected the authored AST');
  const visits = visitTree(program);
  const factory = visits.find(
    (visit) =>
      visit.node.type === 'ArrowFunctionExpression' && visit.parent?.type === 'ArrayExpression',
  );
  const scope = factory?.scopes.at(-1);
  const param = factory === undefined ? undefined : listOf(factory.node, 'params')[0];
  if (scope === undefined || !identifier(param)) throw new Error('Expected the authored context');
  const input = {
    mode,
    context: { name: param.name, scope },
    parents: new Map(visits.map((visit) => [visit.node, visit])),
  };
  return visits
    .filter((visit) => visit.node.type === 'MemberExpression' && propertyName(visit.node) === 'r')
    .map((visit) => unboundTurbopackRequire(visit, input))
    .filter((proof) => proof !== undefined);
}

describe('static receiver-losing require dependency shape', () => {
  it.each([
    ['(0,ctx.r)(2);', 2, 'turbopack:2'],
    ['(0,ctx.r)("2");', '2', 'turbopack:string:"2"'],
    ['const value=(0,ctx.r)(0);', 0, 'turbopack:0'],
    ['function later(){return (0,ctx.r)(2);}ctx.v(later);', 2, 'turbopack:2'],
  ] as const)('records %s only as a conservative dependency', (body, id, specifier) => {
    const proof = dependencies(body);

    expect(proof.map((item) => item.dependency)).toStrictEqual([
      { kind: 'require', specifier, targetId: id },
    ]);
    expect(Object.isFrozen(proof[0])).toBe(true);
    expect(Object.isFrozen(proof[0]?.dependency)).toBe(true);
  });

  it.each([
    '(0,ctx.r)(dynamic);',
    '(0,ctx.r)(`2`);',
    '(0,ctx.r)(2,3);',
    '(0,ctx.r)(...ids);',
    '(0,ctx.r)?.(2);',
    '(1,ctx.r)(2);',
    '(-0,ctx.r)(2);',
    '(0n,ctx.r)(2);',
    '(/0/,ctx.r)(2);',
    '(effect(),ctx.r)(2);',
    '(0,effect(),ctx.r)(2);',
    'const load=(0,ctx.r);',
    'use((0,ctx.r));',
    '(0,ctx.r).call(ctx,2);',
    '(0,ctx.r).apply(ctx,[2]);',
    '(0,ctx.r).bind(ctx)(2);',
    'ctx=other;(0,ctx.r)(2);',
    'function shadow(ctx){return (0,ctx.r)(2);}ctx.v(shadow);',
    'const C=class ctx{method(){return (0,ctx.r)(2);}};ctx.v(C);',
  ])('does not certify an alias, unknown ID, effectful sequence or context shadow: %s', (body) => {
    expect(dependencies(body)).toStrictEqual([]);
  });

  it('never certifies the shape in strict protected mode', () => {
    expect(dependencies('(0,ctx.r)(2);', 'strict')).toStrictEqual([]);
  });

  it('composes the ordinary dependency with full projection while preserving all original call bytes', () => {
    const body = 'const value=(0,ctx.r)(2);ctx.v(value);';
    const original = source(body);
    const projected = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(projected.imports).toStrictEqual([
      { kind: 'require', specifier: 'turbopack:2', targetId: 2 },
    ]);
    expect(projected.original).toStrictEqual(original);
    expect(projected.source.code).toContain('const value=(0,ctx.r)(2);');
    expect(() => projectNodeManifestTurbopackFactory(original, 1)).toThrow('Unproved Next.js');
  });

  it.each([
    '(0,ctx.r)(dynamic);',
    '(effect(),ctx.r)(2);',
    '(0,ctx.r)(...ids);',
    '(0,ctx.r).call(ctx,2);',
    '(0,ctx.r).apply(ctx,[2]);',
    '(0,ctx.r).bind(ctx)(2);',
    'const load=(0,ctx.r);ctx.v(load);',
    'ctx=other;(0,ctx.r)(2);',
  ])('retains full-projection refusal for unsupported capabilities: %s', (body) => {
    expect(() => projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js',
    );
  });

  it('keeps a shadowed ordinary receiver separate from the real runtime context', () => {
    const body = 'function shadow(ctx){return (0,ctx.r)(2);}ctx.v(shadow);';
    const projected = projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies');

    expect(projected.imports).toStrictEqual([]);
    expect(projected.source.code.trim()).toBe(body);
  });
});
