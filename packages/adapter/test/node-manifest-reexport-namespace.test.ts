import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';

function project(body: string, mode: 'dependencies' | 'strict' = 'dependencies') {
  const code = `module.exports=[1,ctx=>{${body}}];`;
  const source = { code, sha256: createHash('sha256').update(code).digest('hex') };
  return projectNodeManifestTurbopackFactory(source, 1, mode);
}

describe('already imported compact-reexport namespaces', () => {
  it.each(['const', 'let', 'var'])(
    'keeps a stable %s namespace as an opaque dependency',
    (kind) => {
      const body = `${kind} namespace=ctx.i(2);ctx.S([namespace,"name,value"]);`;
      const inspected = project(body);

      expect(inspected.imports.map((entry) => entry.targetId)).toStrictEqual([2, 2]);
      expect(inspected.exports).toStrictEqual({ kind: 'opaque' });
      expect(inspected.original.code).toContain(body);
      expect(inspected.source.code).toContain('ctx.S([namespace,"name,value"])');
      expect(() => project(body, 'strict')).toThrow('Unproved Next.js');
    },
  );

  it('retains mixed typed module heads, empty groups and an existing namespace dependency', () => {
    const inspected = project('const namespace=ctx.i("2");ctx.S([0,"a,b",0,namespace,0,2,"c,d"]);');

    expect(inspected.imports.map((entry) => entry.targetId)).toStrictEqual([0, '2', 2, '2']);
  });

  it.each([
    'const namespace={};ctx.S([namespace,"name,value"]);',
    'const namespace=ctx.r(2);ctx.S([namespace,"name,value"]);',
    'const namespace=ctx.i(dynamic);ctx.S([namespace,"name,value"]);',
    'const namespace=ctx.i(2,extra);ctx.S([namespace,"name,value"]);',
    'const namespace=ctx.i?.(2);ctx.S([namespace,"name,value"]);',
    'const namespace=other.i(2);ctx.S([namespace,"name,value"]);',
    'const namespace=ctx.i(2);const alias=namespace;ctx.S([alias,"name,value"]);',
    'ctx.S([namespace,"name,value"]);var namespace=ctx.i(2);',
    'let namespace=ctx.i(2);namespace=other;ctx.S([namespace,"name,value"]);',
    'let namespace=ctx.i(2);ctx.S([namespace,"name,value"]);namespace=other;',
    'let namespace=ctx.i(2);ctx.S([namespace,"name,value"]);function later(){namespace=other;}',
    'let namespace=ctx.i(2);[namespace]=other;ctx.S([namespace,"name,value"]);',
    'var namespace=ctx.i(2);var namespace=other;ctx.S([namespace,"name,value"]);',
    'const namespace=ctx.i(2);namespace.value=other;ctx.S([namespace,"name,value"]);',
    'if(flag){const namespace=ctx.i(2);ctx.S([namespace,"name,value"]);}',
    'function deferred(){const namespace=ctx.i(2);ctx.S([namespace,"name,value"]);}',
    'const namespace=ctx.i(2);function shadow(namespace){ctx.S([namespace,"name,value"]);}',
    'const namespace=ctx.i(2);ctx.S([namespace,"a,b,a,c"]);',
    'const namespace=ctx.i(2);ctx.S([namespace,"a,b"],other);',
  ])('refuses an unproved or unstable namespace head: %s', (body) => {
    expect(() => project(body)).toThrow('Unproved Next.js');
  });
});
