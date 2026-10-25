import { describe, expect, it } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

const CHUNK = '/project/.next/server/chunks/native.js';
const MODULE = '/project/node_modules/example/index.js';

describe('original Node executable closure proof', () => {
  it.each([
    ['direct context', "module.exports=[1,c=>c.y('external')];"],
    ['computed context', "module.exports=[1,c=>c['y']('external')];"],
    ['context alias', "module.exports=[1,c=>{const alias=c;alias.y('external')}];"],
    ['destructured context', "module.exports=[1,c=>{const {y:load}=c;load('external')}];"],
    ['computed context escape', "module.exports=[1,c=>c[globalThis.key]('external')];"],
    ['returned context escape', 'module.exports=[1,c=>c];'],
    ['nested generated table', "module.exports=[[1,c=>c.y('external')]];"],
    [
      'renamed CommonJS wrapper',
      "wrap((exports,module2)=>{module2.exports=[1,c=>c.y('external')]});",
    ],
  ])('refuses %s without confusing it with a coordinate', (_title, source) => {
    expect(dynamicNodeClosureRefusal(CHUNK, source)).toBe('an unproved Turbopack external import');
  });

  it('refuses an unsupported generated factory parameter shape', () => {
    expect(dynamicNodeClosureRefusal(CHUNK, "module.exports=[1,({y})=>y('external')];")).toBe(
      'an unproved Turbopack factory context',
    );
  });

  it.each([
    ['coordinate read', 'module.exports=[1,c=>{const point={y:2};return point.y}];'],
    ['coordinate method', 'module.exports=[1,c=>{const point={y:()=>2};return point.y()}];'],
    ['parameter shadow', 'module.exports=[1,c=>{return (c)=>c.y}];'],
    ['block shadow', 'module.exports=[1,c=>{let point;{const c={y:2};point=c.y}return point}];'],
    ['ordinary member', 'module.exports=point=>point.y;'],
    ['ordinary context property', 'module.exports=[1,c=>c.id];'],
    ['followable external require', "module.exports=[1,c=>c.x('example',()=>require('example'))];"],
  ])('retains %s on the normal Node path', (_title, source) => {
    expect(dynamicNodeClosureRefusal(CHUNK, source)).toBeUndefined();
  });

  it.each([
    [
      'CommonJS createRequire',
      "const {createRequire}=require('node:module');exports.load=p=>createRequire(__filename)(p);",
    ],
    [
      'namespace alias',
      "const Mod=require('module');const alias=Mod;exports.load=p=>alias.createRequire(__filename)(p);",
    ],
    [
      'ES module named alias',
      "import {createRequire as load} from 'node:module';export const run=p=>load(import.meta.url)(p);",
    ],
    ['ES module default', "import Mod from 'node:module';export const run=p=>Mod._load(p);"],
    [
      'module resolver mutation',
      "const Mod=require('module');Mod._resolveFilename=globalThis.resolve;",
    ],
    ['module namespace escape', "exports.loader=require('node:module');"],
    ['module instance', "const Mod=require('module');exports.loader=new Mod('unknown');"],
    ['unknown module member', "const Mod=require('module');exports.load=p=>Mod[p]('unknown');"],
    ['dlopen alias', 'const {dlopen:open}=process;exports.load=p=>open(module,p);'],
    ['main-module alias', 'const main=process.mainModule;exports.load=p=>main.require(p);'],
    ['builtin lookup', "exports.load=()=>process.getBuiltinModule('module');"],
    ['VM compiler', "const vm=require('vm');exports.load=p=>vm.runInThisContext(p);"],
    ['VM constructor alias', "const {Script}=require('node:vm');exports.compile=p=>new Script(p);"],
    ['dynamic Module namespace', "exports.load=()=>import('node:module');"],
    ['global eval', 'exports.load=p=>eval(p);'],
    ['eval alias', 'const compile=eval;exports.load=p=>compile(p);'],
    ['global Function alias', 'const compile=Function;exports.load=p=>compile(p)();'],
    ['computed global compiler', "exports.load=p=>globalThis['Function'](p)();"],
  ])('refuses the unproved %s', (_title, source) => {
    expect(dynamicNodeClosureRefusal(MODULE, source)).toBeTypeOf('string');
  });

  it.each([
    [
      'ordinary createRequire method',
      'const Mod={createRequire:()=>42};exports.load=()=>Mod.createRequire();',
    ],
    [
      'parameter shadow',
      "const Mod=require('module');exports.load=Mod=>Mod.createRequire();exports.names=Mod.builtinModules;",
    ],
    ['custom loader name', 'function createRequire(){return 42}exports.load=()=>createRequire();'],
    ['local Function', 'function Function(value){return value}exports.load=()=>Function(42);'],
    [
      'ordinary VM method',
      'const vm={runInThisContext:()=>42};exports.load=()=>vm.runInThisContext();',
    ],
    ['safe Module metadata', "const Mod=require('module');exports.names=Mod.builtinModules;"],
    ['safe VM metadata', "const vm=require('node:vm');exports.check=value=>vm.isContext(value);"],
    ['Node process metadata', 'exports.version=process.versions.node;'],
    ['property names', 'exports.eval={Function:42,eval:42};'],
  ])('accepts %s without a loader-name heuristic', (_title, source) => {
    expect(dynamicNodeClosureRefusal(MODULE, source)).toBeUndefined();
  });
});
