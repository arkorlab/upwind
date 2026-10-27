import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import {
  nodeJwtCompilerMetadata,
  nodeJwtCompilerSite,
  nodeJwtGuardRecord,
  qualifyNodeJwtCompiler,
  type NodeJwtCompilerInput,
  type NodeJwtCompilerProof,
} from '../src/node-jwt-compiler-proof.ts';
import { nodeJwtGlobalRecoverySite, nodeJwtRequireOnly } from '../src/node-jwt-compiler-sites.ts';
import type { ManifestModuleGraph } from '../src/node-manifest-graph.ts';
import { prepareOriginalNodeModes, originalNodeModeHash } from '../src/node-original-load-mode.ts';

describe('fixed JWT compiler site DATA', () => {
  it.each([undefined, null, 0, 'source text', {}])(
    'declines a non-AST parser boundary value %s',
    (value) => {
      expect(nodeJwtGlobalRecoverySite(value)).toBeUndefined();
    },
  );

  it.each([
    "const Mod=require('node:module');Mod.wrapper[0]='unknown prefix';",
    "const {wrapper}=require('module');wrapper[0]='unknown prefix';",
    "const Mod=require('module');exports.wrapper=Mod.wrapper;",
  ])('refuses customization of the real CJS wrapper: %s', (code) => {
    expect(dynamicNodeClosureRefusal('/vendor.js', code)).toContain('loader');
  });

  it('keeps unrelated wrapper metadata ordinary', () => {
    expect(
      dynamicNodeClosureRefusal('/vendor.js', 'const Mod={wrapper:[1]};exports.x=Mod.wrapper;'),
    ).toBeUndefined();
  });

  it.each([
    "globalThis.Function('return this')()",
    "globalThis['Function']('return this')()",
    "globalThis[`Function`]('return this')()",
    'const host=globalThis;host.eval(source)',
  ])('keeps the extracted ordinary global compiler refusal for %s', (code) => {
    expect(dynamicNodeClosureRefusal('/vendor.js', code)).toContain('compiler');
  });

  it.each([
    'exports.run=Function=>Function()',
    'const globalThis={Function:()=>true};exports.run=()=>globalThis.Function()',
    'const host={eval:()=>true};exports.run=()=>host.eval()',
  ])('keeps ordinary lexical shadows for %s', (code) => {
    expect(dynamicNodeClosureRefusal('/vendor.js', code)).toBeUndefined();
  });

  it.each([
    "const root=Function('return this')();",
    "const root=global||self||Function('return this')();",
    "(()=>{const root=Function('return this')();return root})();",
  ])('finds only the immediate fixed global recovery in %s', (code) => {
    const site = nodeJwtGlobalRecoverySite(parseAst(code));

    expect(site?.type).toBe('Identifier');
    expect(site?.['name']).toBe('Function');
    expect(code.slice(site?.start ?? 0, site?.end ?? 0)).toBe('Function');
    // The DATA recognizer alone never changes the existing native closure gate.
    expect(dynamicNodeClosureRefusal('/app/vendor.js', code)).toContain('compiler');
  });

  it.each([
    "Function('return this')",
    "Function('return this')(1)",
    "Function('x','return this')()",
    'Function(`return this`)()',
    "new Function('return this')()",
    "Function('return globalThis')()",
    'Function(\'return import("unknown")\')()',
    'Function(source)()',
    "Function(...['return this'])()",
    "Function?.('return this')()",
    "Function('return this')?.()",
    "const Compiler=Function;Compiler('return this')()",
    "globalThis.Function('return this')()",
    "function local(Function){return Function('return this')()}",
    "const Function=local;Function('return this')()",
    "Function('return this')();Function('return this')()",
    "Function('return this')();eval(source)",
  ])('declines unsupported compiler shape %s', (code) => {
    expect(nodeJwtGlobalRecoverySite(parseAst(code))).toBeUndefined();
  });
});

describe('fixed JWT incoming load role DATA', () => {
  it.each([
    "module.exports=require('jwt')",
    "const jwt=require('jwt');exports.sign=(...args)=>jwt.sign(...args)",
    "const jwt=require('jwt');require('buffer');",
    "function local(require){require('other')}module.exports=require('jwt')",
  ])('keeps literal default CommonJS use %s', (code) => {
    expect(nodeJwtRequireOnly(code, 'jwt')).toBe(true);
  });

  it.each([
    "module.exports=require('other')",
    "function local(require){return require('jwt')}",
    "const require=custom;module.exports=require('jwt')",
    "module.exports=require('jwt');import('jwt')",
    "module.exports=require('jwt');import(other)",
    "module.exports=require('jwt');require(other)",
    "module.exports=require?.('jwt')",
    "module.exports=require('jwt',options)",
    'module.exports=require(`jwt`)',
  ])('declines unknown or non-CJS load roles %s', (code) => {
    expect(nodeJwtRequireOnly(code, 'jwt')).toBe(false);
  });
});

describe('fixed JWT proof is private and conditional', () => {
  it('keeps parsed but unretained JWT and caller rows outside retained compiler classification', async () => {
    const jwt = '/project/node_modules/next/dist/compiled/jsonwebtoken/index.js';
    const removed = '/project/removed.cjs';
    const live = '/project/live.cjs';
    const graph: ManifestModuleGraph = {
      sources: new Map([
        [jwt, { file: jwt, sha256: 'unqualified removed source' }],
        [live, { file: live, sha256: 'live ordinary source' }],
        [removed, { file: removed, sha256: 'removed caller' }],
      ]),
      importers: new Map([[jwt, [removed]]]),
      imports: new Map([[removed, [{ specifier: 'jwt', target: jwt }]]]),
      retained: new Set([live]),
      rendered: new Map([[live, 'exports.ok=true;']]),
    };

    // No mode/SDK token is invented for removed source, and no guard authority is returned.
    await expect(
      qualifyNodeJwtCompiler({ graph } as NodeJwtCompilerInput),
    ).resolves.toBeUndefined();
    expect(dynamicNodeClosureRefusal(live, 'exports.ok=true;')).toBeUndefined();
  });

  it('does not turn shape DATA into an opaque proof', async () => {
    const code = "Function('return this')()";
    const program = parseAst(code);
    const forged = {} as NodeJwtCompilerProof;

    expect(nodeJwtCompilerSite(undefined, '/vendor.js', code, program)).toBeUndefined();
    expect(() => nodeJwtCompilerSite(forged, '/vendor.js', code, program)).toThrow('copied');
    await expect(nodeJwtCompilerMetadata(forged)).rejects.toThrow('copied');
    await expect(nodeJwtGuardRecord(forged, () => 'vendor.js')).rejects.toThrow('copied');
  });

  it('leaves a native graph without JWT on the existing ordinary audit path', async () => {
    const graph: ManifestModuleGraph = {
      sources: new Map(),
      importers: new Map(),
      retained: new Set(),
      rendered: new Map(),
    };
    const input = { graph } as NodeJwtCompilerInput;

    await expect(qualifyNodeJwtCompiler(input)).resolves.toBeUndefined();
    expect(dynamicNodeClosureRefusal('/vendor.js', 'exports.ok=()=>true')).toBeUndefined();
    expect(dynamicNodeClosureRefusal('/vendor.js', 'const C=Function;exports.fn=C')).toContain(
      'compiler',
    );
    expect(
      dynamicNodeClosureRefusal('/vendor.js', "require('module').registerHooks(hooks)"),
    ).toContain('loader');
  });

  it('does not accept a canonical filename, package declaration or source hash as route approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jwt-site-proof-'));
    try {
      const packageRoot = path.join(root, 'node_modules/next');
      const file = path.join(packageRoot, 'dist/compiled/jsonwebtoken/index.js');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(path.join(packageRoot, 'package.json'), '{"name":"next","version":"16.4.3"}');
      const code = "module.exports={sign:()=>Function('return this')()};";
      await writeFile(file, code);
      const graph: ManifestModuleGraph = {
        sources: new Map([[file, { file, sha256: originalNodeModeHash(code) }]]),
        importers: new Map([[file, []]]),
        retained: new Set([file]),
        rendered: new Map([[file, code]]),
      };
      const originalModes = await prepareOriginalNodeModes(
        { rootDir: root, projectDir: root, distDir: root },
        graph,
        [file],
      );

      await expect(
        qualifyNodeJwtCompiler({
          graph,
          originalModes,
          patches: [],
          context: { distDir: root },
          manifests: {},
        }),
      ).rejects.toThrow('completed original SDK route closure');
      expect(dynamicNodeClosureRefusal(file, code)).toContain('compiler');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
