import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';

describe('native child constructor classification', () => {
  let directory: string;
  let entry: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-worker-child-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    entry = path.join(directory, 'entry.mjs');
    binary = path.join(directory, 'addon.node');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function classify(
    source: string,
    commonjs = false,
    nodeTarget = false,
    nativeOwned = true,
  ) {
    const importer = commonjs ? path.join(directory, 'entry.cjs') : entry;
    await writeFile(importer, source);
    const assets = nativeOwned ? { entry: importer, binary } : { entry: importer };
    const proof = nativeLoadsPlugin([{ id: '/native', assets }], { nodeTarget });
    await using build = await rolldown({
      input: importer,
      platform: 'neutral',
      plugins: [proof.plugin],
      external: ['node:worker_threads', 'worker_threads', 'node:path'],
    });
    const output = await build.generate({ format: 'esm' });
    const chunk = output.output.find((part): part is OutputChunk => part.type === 'chunk');
    if (chunk === undefined) throw new Error('The authored child fixture produced no chunk');
    return await proof.retained(chunk);
  }

  it.each([
    "import threads from 'node:worker_threads'; export const worker = new threads.Worker('./child.js');\n",
    "import threads from 'worker_threads'; export const worker = new threads['Worker']('./child.js');\n",
    "import * as threads from 'node:worker_threads'; export const worker = new threads['Worker']('./child.js');\n",
    "import { Worker as Thread } from 'node:worker_threads'; export const worker = new Thread('./child.js');\n",
    "import { 'Worker' as Thread } from 'node:worker_threads'; export const worker = new Thread('./child.js');\n",
    "import { default as threads } from 'node:worker_threads'; export const worker = new threads.Worker('./child.js');\n",
    "import { 'default' as threads } from 'worker_threads'; export const worker = new threads['Worker']('./child.js');\n",
    "import threads from 'node:worker_threads'; const {'Worker':Thread}=threads; export const worker=new Thread('./child.js');\n",
    "import threads from 'node:worker_threads'; const {['Worker']:Thread}=threads; export const worker=new Thread('./child.js');\n",
  ])(
    'refuses a retained actual Node Worker constructor with owned native dependencies: %s',
    async (source) => {
      await expect(classify(source)).rejects.toThrow('unclassified owned native child');
    },
  );

  it('refuses an unknown computed constructor on the actual Node namespace', async () => {
    const source =
      "import threads from 'node:worker_threads'; export function start(kind) { return new threads[kind]('./child.js'); }\n";

    await expect(classify(source)).rejects.toBeInstanceOf(AuditError);
  });

  it.each([
    "const {Worker}=await import('node:worker_threads');export const worker=new Worker('source',{eval:true});",
    "const {['Worker']:Thread}=await import(`worker_threads`);export const worker=new Thread('source',{eval:true});",
    "const threads=await import('node:worker_threads');export const worker=new threads.Worker('./child.js');",
    "const Thread=(await import('node:worker_threads')).Worker;export const worker=new Thread('./child.js');",
    "export const worker=new (await import('node:worker_threads')).Worker('./child.js');",
    "const pending=import('node:worker_threads');const alias=pending;const threads=await alias;export const worker=new threads.Worker('./child.js');",
    "const threads=(await import('node:worker_threads')).default;export const worker=new threads.Worker('./child.js');",
    "const {default:{Worker:Thread}}=await import('node:worker_threads');export const worker=new Thread('./child.js');",
    "const threads=await import('node:worker_threads');const alias=await threads;export const worker=new alias.Worker('./child.js');",
    "export async function start(key){const threads=await import('node:worker_threads');return new threads[key]('./child.js');}",
    "let pending=import('node:worker_threads');pending=globalThis.other;const threads=await pending;export const worker=new threads.Worker('./child.js');",
    "import * as threads from 'node:worker_threads';export const worker=new threads.default.Worker('./child.js');",
  ])(
    'refuses native child work through a dynamic import or module namespace: %s',
    async (source) => {
      await expect(classify(source)).rejects.toThrow('unclassified owned native child');
    },
  );

  it.each([
    "const threads=await import('node:worker_threads');export function start(threads){return new threads.Worker('./child.js');}",
    "const {Worker:Thread}=await import('node:worker_threads');export function start(){const Thread=class {};return new Thread('./child.js');}",
    "const loader={import:async()=>({Worker:class {}})};const threads=await loader.import('node:worker_threads');export const worker=new threads.Worker('./child.js');",
    "const threads=import('node:worker_threads');export function start(){return new threads.Worker('./child.js');}",
    "const {Worker:Thread}=import('node:worker_threads');export function start(){return new Thread('./child.js');}",
    "const threads=await import('node:worker_threads');export const channel=new threads.BroadcastChannel('messages');",
    "const {Worker:Thread}=await Promise.resolve({Worker:class {}});export const worker=new Thread('./child.js');",
  ])(
    'keeps promise values, non-Worker members and genuine local shadows separate: %s',
    async (source) => {
      await expect(classify(source)).resolves.toStrictEqual([]);
    },
  );

  it.each([
    "export const pending=import('node:worker_threads').then(({Worker})=>new Worker('source',{eval:true}));",
    "const pending=import('node:worker_threads');const alias=pending;export const value=alias.then(({Worker:Thread})=>new Thread('source',{eval:true}));",
    "const pending=import('node:worker_threads');export const value=pending['then'](globalThis.consume);",
    "const pending=import('node:worker_threads');export const value=pending.catch(globalThis.consume);",
    "const pending=import('node:worker_threads');export const value=pending.finally(globalThis.consume);",
    "const pending=import('node:worker_threads');export function start(key){return pending[key](globalThis.consume);}",
    "const pending=import('node:worker_threads');const then=pending.then;export const value=then.call(pending,globalThis.consume);",
    "const pending=import('node:worker_threads');const {then}=pending;export const value=then.call(pending,globalThis.consume);",
    "const threads=await import('node:worker_threads');const Thread=Reflect.get(threads,'Worker');export const worker=new Thread('source',{eval:true});",
    "import threads from 'node:worker_threads';export const worker=Reflect.construct(threads.Worker,['source',{eval:true}]);",
    "import {Worker} from 'node:worker_threads';const Thread=Worker.bind(null);export const worker=new Thread('source',{eval:true});",
    "import threads from 'node:worker_threads';export const worker=threads.Worker.call(null,'source',{eval:true});",
    "import {Worker} from 'node:worker_threads';export const worker=Worker.apply(null,['source',{eval:true}]);",
    "import threads from 'node:worker_threads';export const value=globalThis.consume(threads);",
    "import {Worker} from 'node:worker_threads';export const value=globalThis.consume(Worker);",
    "export const value=globalThis.consume(import('node:worker_threads'));",
    "import threads from 'node:worker_threads';export const value=new globalThis.Consumer(threads);",
    "import threads from 'node:worker_threads';export const value=globalThis.consume(...threads);",
    "const threads=await import('node:worker_threads');export function start(Reflect){return Reflect.get(threads,'Worker');}",
  ])(
    'refuses retained capability handoff without claiming callback or call semantics: %s',
    async (source) => {
      await expect(classify(source)).rejects.toThrow('unclassified owned native child');
    },
  );

  it('keeps the authored physical Node source unchanged after an analysis refusal', async () => {
    const source =
      "const threads=await import('node:worker_threads');export const value=Reflect.get(threads,'Worker');";

    await expect(classify(source)).rejects.toThrow('unclassified owned native child');
    await expect(readFile(entry, 'utf8')).resolves.toBe(source);
  });

  it.each([
    "import threads from 'node:worker_threads';export function start(threads){return Reflect.get(threads,'Worker');}",
    "const pending=import('node:worker_threads');export function start(pending){return pending.then(globalThis.consume);}",
    "import {Worker} from 'node:worker_threads';export function start(Worker){return Worker.bind(null);}",
    "import threads from 'node:worker_threads';export const value=globalThis.consume(threads.isMainThread);",
    "import {Worker} from 'node:worker_threads';export const value=globalThis.consume(Worker.name);",
    "import threads from 'node:worker_threads';export const value=threads.getEnvironmentData('key');",
    "const threads={Worker:class {}};export const value=Reflect.get(threads,'Worker');",
    "const loader={import:()=>Promise.resolve({Worker:class {}})};export const value=loader.import('node:worker_threads').then(globalThis.consume);",
  ])(
    'keeps lexical shadows and selected non-Worker values on their ordinary path: %s',
    async (source) => {
      await expect(classify(source)).resolves.toStrictEqual([]);
    },
  );

  it.each([
    "import threads from 'node:worker_threads';if(false)globalThis.consume(threads);export const safe=1;",
    "import threads from 'node:worker_threads';function unused(){return Reflect.get(threads,'Worker');}export const safe=1;",
    "function unused(){return import('node:worker_threads').then(globalThis.consume);}export const safe=1;",
  ])(
    'prunes unsupported handoff sites that do not survive the source bundle: %s',
    async (source) => {
      await expect(classify(source)).resolves.toStrictEqual([]);
    },
  );

  it.each([
    "export const value=import('node:worker_threads').then(({Worker})=>new Worker('source',{eval:true}));",
    "const threads=await import('node:worker_threads');export const value=Reflect.get(threads,'Worker');",
    "import {Worker} from 'node:worker_threads';export const value=Worker.bind(null);",
  ])('does not add a native-child refusal when no native binary is owned: %s', async (source) => {
    await expect(classify(source, false, false, false)).resolves.toStrictEqual([]);
  });

  it.each([
    "const threads=require('node:worker_threads'); exports.helper=function(require,threads){return [require,threads];}; exports.start=()=>new threads.Worker('./child.js');\n",
    "const {Worker:Thread}=require('node:worker_threads'); exports.helper=function(Thread){return Thread;}; exports.start=()=>new Thread('./child.js');\n",
    "const {'Worker':Thread}=require('node:worker_threads'); exports.start=()=>new Thread('./child.js');\n",
    "const {['Worker']:Thread}=require('node:worker_threads'); exports.start=()=>new Thread('./child.js');\n",
    "const {[`Worker`]:Thread}=require('node:worker_threads'); exports.start=()=>new Thread('./child.js');\n",
    "const {['Worker']:Thread=class {}}=require('node:worker_threads'); exports.start=()=>new Thread('./child.js');\n",
    "exports.start=function(key){const {[key]:Thread}=require('node:worker_threads'); return new Thread('./child.js');};\n",
    "const {Worker:{prototype:{constructor:Thread}}}=require('node:worker_threads'); exports.start=()=>new Thread('./child.js');\n",
    "const {...threads}=require('node:worker_threads'); exports.start=()=>new threads.Worker('./child.js');\n",
    "const threads=require('node:worker_threads');threads.BroadcastChannel=threads.Worker;const {['BroadcastChannel']:Thread}=threads;exports.start=()=>new Thread('./child.js');\n",
    "const threads=require('node:worker_threads');let alias=threads;alias=globalThis.unknown;const {[key]:Thread}=alias;exports.start=()=>new Thread('./child.js');\n",
  ])('does not let another scope hide a retained CJS native child: %s', async (source) => {
    await expect(classify(source, true)).rejects.toThrow('unclassified owned native child');
  });

  it.each([
    "import threads from 'node:worker_threads'; const Thread=threads.Worker; export const worker=new Thread('./child.js');\n",
    "import {Worker as Thread} from 'node:worker_threads'; const Alias=Thread; export function helper(Thread){return Thread;} export const worker=new Alias('./child.js');\n",
    "import * as threads from 'node:worker_threads'; const alias=threads; export const worker=new alias['Worker']('./child.js');\n",
    "import { default as threads } from 'node:worker_threads'; const alias=threads; export const worker=new alias.Worker('./child.js');\n",
    "import { 'default' as threads } from 'node:worker_threads'; const {Worker:Thread}=threads; export const worker=new Thread('./child.js');\n",
  ])('retains native child refusal through a lexically proved ESM alias: %s', async (source) => {
    await expect(classify(source)).rejects.toThrow('unclassified owned native child');
  });

  it.each([
    "import threads from 'node:worker_threads'; export function start(){const threads={Worker:class {}}; return new threads.Worker('./child.js');}\n",
    "const threads=require('node:worker_threads'); exports.start=function(){const threads={Worker:class {}}; return new threads.Worker('./child.js');};\n",
    "const {'Worker':Thread}=require('node:worker_threads'); exports.start=function(Thread){return new Thread('./child.js');};\n",
    "const {['Worker']:Thread}=require('node:worker_threads'); exports.start=function(){const Thread=class {};return new Thread('./child.js');};\n",
    "const threads={Worker:class {}};const {'Worker':Thread}=threads;exports.start=()=>new Thread('./child.js');\n",
  ])(
    'does not classify an application constructor in a nearer lexical scope: %s',
    async (source) => {
      const loads = await classify(source, source.startsWith('const'));

      expect(loads).toStrictEqual([]);
    },
  );

  it('refuses a mutated known Worker origin instead of treating its child closure as proved', async () => {
    const source =
      "let {Worker:Thread}=require('node:worker_threads'); Thread=globalThis.customConstructor; exports.start=()=>new Thread('./child.js');\n";

    await expect(classify(source, true)).rejects.toThrow('unclassified owned native child');
  });

  it.each([
    "import threads from 'node:worker_threads'; export function start(threads) { return new threads['Worker']('./child.js'); }\n",
    "import { Worker as Thread } from 'node:worker_threads'; export function start(Thread) { return new Thread('./child.js'); }\n",
    "import { default as threads } from 'node:worker_threads'; export function start(threads) { return new threads.Worker('./child.js'); }\n",
    "import { 'default' as threads } from 'node:worker_threads'; export function start() { const threads={Worker:class {}}; return new threads.Worker('./child.js'); }\n",
    "class Worker { constructor(file) { this.file = file; } } export const worker = new Worker('./child.js');\n",
  ])(
    'does not manufacture Node ownership from an application constructor or shadow: %s',
    async (source) => {
      const loads = await classify(source);

      expect(loads).toStrictEqual([]);
    },
  );

  it('does not confuse a known non-Worker namespace constructor with native child work', async () => {
    const loads = await classify(
      "import threads from 'node:worker_threads'; export const channel = new threads['BroadcastChannel']('messages');\n",
    );

    expect(loads).toStrictEqual([]);
  });

  it('keeps a statically selected non-Worker destructured constructor on its ordinary path', async () => {
    const source =
      "const {['BroadcastChannel']:Channel}=require('node:worker_threads');exports.channel=new Channel('messages');\n";
    const loads = await classify(source, true);

    expect(loads).toStrictEqual([]);
  });

  it.each(['join', 'resolve'])(
    'rejects an absolute tail in dirname-based path.%s native proof',
    async (method) => {
      const source = `const path = require('node:path'); process.dlopen(module, path.${method}(__dirname, '/addon.node')); module.exports = {};\n`;

      await expect(classify(source, true)).rejects.toBeInstanceOf(AuditError);
    },
  );

  it('keeps the old plain guarded Worker fallback but refuses it during strict Node recheck', async () => {
    const source =
      "try { process.dlopen(module, './optional.node'); } catch { module.exports = { fallback: true }; }\n";
    const worker = await classify(source, true);

    expect(worker).toStrictEqual([]);
    await expect(classify(source, true, true)).rejects.toThrow('unclassified on the Node target');
  });
});
