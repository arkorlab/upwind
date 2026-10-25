import { describe, expect, it } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

const CHUNK = '/project/.next/server/chunks/native.js';
const MODULE = '/project/node_modules/example/index.js';

describe('original Node executable closure proof', () => {
  it.each(['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'])(
    'refuses the retained child_process executor %s',
    (member) => {
      const source = `const child=require('node:child_process');exports.run=value=>child.${member}(value);`;

      expect(dynamicNodeClosureRefusal(MODULE, source)).toBeTypeOf('string');
    },
  );

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
    ['global process native loader', 'exports.load=p=>globalThis.process.dlopen(module,p);'],
    [
      'global process builtin lookup',
      "exports.load=()=>globalThis.process.getBuiltinModule('module');",
    ],
    [
      'computed global process loader',
      "exports.load=p=>globalThis['process']['dlopen'](module,p);",
    ],
    ['global host alias', 'const host=globalThis;exports.load=p=>host.process.dlopen(module,p);'],
    [
      'global process alias',
      'const proc=globalThis.process;exports.load=p=>proc.dlopen(module,p);',
    ],
    ['nested global host', 'exports.load=p=>globalThis[`globalThis`].process.dlopen(module,p);'],
    ['Node global alias', 'exports.load=p=>global.process.dlopen(module,p);'],
    ['CommonJS constructor loader', 'exports.load=p=>module.constructor._load(p);'],
    ['computed CommonJS constructor', "exports.load=p=>module['constructor']['_load'](p);"],
    ['CommonJS module alias', 'const current=module;exports.load=p=>current.constructor._load(p);'],
    ['CommonJS parent constructor', 'exports.load=p=>module.parent.constructor._load(p);'],
    ['CommonJS unknown member', 'exports.load=(name,p)=>module[name](p);'],
    [
      'rebound global process',
      'let proc={};proc=globalThis.process;exports.load=p=>proc.dlopen(module,p);',
    ],
    ['rebound host', 'let host={};host=globalThis;exports.load=p=>host.process.dlopen(module,p);'],
    ['rebound module namespace', "let Mod={};Mod=require('module');exports.load=p=>Mod._load(p);"],
    [
      'mutated process origin',
      'let proc=globalThis.process;proc=unknown;exports.load=p=>proc.dlopen(module,p);',
    ],
    ['VM compiler', "const vm=require('vm');exports.load=p=>vm.runInThisContext(p);"],
    ['VM constructor alias', "const {Script}=require('node:vm');exports.compile=p=>new Script(p);"],
    ['dynamic Module namespace', "exports.load=()=>import('node:module');"],
    ['global eval', 'exports.load=p=>eval(p);'],
    ['eval alias', 'const compile=eval;exports.load=p=>compile(p);'],
    ['global Function alias', 'const compile=Function;exports.load=p=>compile(p)();'],
    ['computed global compiler', "exports.load=p=>globalThis['Function'](p)();"],
    [
      'child subprocess code',
      "const {spawn}=require('node:child_process');exports.run=()=>spawn(process.execPath,['-e',\"require('./untraced.node')\"]);",
    ],
    [
      'child namespace alias',
      "const child=require('child_process');const alias=child;exports.run=p=>alias.exec(p);",
    ],
    [
      'child ES module alias',
      "import {execFile as launch} from 'node:child_process';export const run=p=>launch(p);",
    ],
    [
      'child ES module default',
      "import child from 'node:child_process';export const run=p=>child.execSync(p);",
    ],
    ['child namespace export', "exports.runner=require('node:child_process');"],
    [
      'child namespace reassignment escape',
      "const child=require('node:child_process');let alias;alias=child;exports.run=p=>alias.fork(p);",
    ],
    [
      'child namespace passed to another function',
      "exports.run=use(require('node:child_process'));",
    ],
    [
      'child namespace rest copy',
      "const {...child}=require('node:child_process');exports.run=p=>child.spawnSync(p);",
    ],
    [
      'child constructor',
      "const {ChildProcess}=require('node:child_process');exports.run=p=>new ChildProcess().spawn(p);",
    ],
    [
      'unknown child member',
      "const child=require('node:child_process');exports.run=p=>child[globalThis.operation](p);",
    ],
    ['dynamic child namespace', "exports.run=()=>import('node:child_process');"],
    ['child namespace re-export', "export * as child from 'node:child_process';"],
    ['child executor re-export', "export {spawn as launch} from 'node:child_process';"],
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
    ['global process metadata', 'exports.version=globalThis.process.versions.node;'],
    [
      'global process metadata alias',
      'const proc=globalThis.process;exports.version=proc.versions.node;',
    ],
    ['CommonJS exports', 'module.exports={version:42};'],
    ['CommonJS metadata', 'exports.filename=module.filename;'],
    [
      'local global object',
      'const globalThis={process:{dlopen:()=>42}};exports.load=()=>globalThis.process.dlopen();',
    ],
    ['global parameter shadow', 'exports.load=globalThis=>globalThis.process.dlopen();'],
    ['process parameter shadow', 'exports.load=process=>process.dlopen();'],
    [
      'local module object',
      'const module={constructor:{_load:()=>42}};exports.load=()=>module.constructor._load();',
    ],
    ['module parameter shadow', 'exports.load=module=>module.constructor._load();'],
    ['host alias shadow', 'const host=globalThis;exports.load=host=>host.process.dlopen();'],
    ['property names', 'exports.eval={Function:42,eval:42};'],
    ['ordinary spawn method', 'const child={spawn:()=>42};exports.run=()=>child.spawn();'],
    [
      'child parameter shadow',
      "const child=require('node:child_process');exports.run=child=>child.spawn();exports.metadata=child.available;",
    ],
    ['local fork function', 'function fork(value){return value}exports.run=()=>fork(42);'],
    [
      'ordinary child object properties',
      'exports.metadata={ChildProcess:42,exec:42,spawn:42,fork:42};',
    ],
    ['discarded child namespace import', "require('node:child_process');exports.metadata=42;"],
    [
      'child namespace typeof metadata',
      "const child=require('node:child_process');exports.metadata=typeof child;",
    ],
  ])('accepts %s without a loader-name heuristic', (_title, source) => {
    expect(dynamicNodeClosureRefusal(MODULE, source)).toBeUndefined();
  });
});
