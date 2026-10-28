import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { nativeBindings, walk } from '../src/native-ast.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';
import { hasRetainedWorkerCapability, nativeWorkerEdit } from '../src/native-worker.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

const IMPORT = "import {Worker} from 'node:worker_threads';";
const SOURCE = "require('unproved-child')";
const SELECTIONS = [
  'process.env.USE_WORKER?Worker:class{}',
  'process.env.USE_WORKER?class{}:Worker',
  'process.env.USE_WORKER&&Worker',
  'process.env.USE_WORKER||Worker',
  'process.env.USE_WORKER??Worker',
  'process.env.USE_WORKER?Worker:Worker',
  '(0,Worker)',
  '(effect(),Worker)',
  '(selected=Worker)',
] as const;
function programSource(selection: string): string {
  return `${IMPORT}let selected;function effect(){return 0;}const Thread=${selection};export const start=()=>new Thread(${jsLiteral(SOURCE)},{eval:true});`;
}
function capability(source: string): boolean {
  const program = parseAst(source);
  return hasRetainedWorkerCapability(walk(program), nativeBindings(program));
}
function constructorOf(program: ReturnType<typeof parseAst>) {
  const node = walk(program).find((item) => item.type === 'NewExpression');
  if (node === undefined) throw new Error('Expected the authored dead child');
  return node;
}

const SCALAR_CHOICE =
  "const chosen=process.env.USE?require('node:worker_threads'):{isMainThread:true,threadId:0};";

describe('finite scalar fields of selected Worker namespaces', () => {
  it.each([
    'exports.check=()=>chosen.isMainThread;',
    'exports.check=()=>chosen.threadId;',
    'exports.check=()=>chosen["isMainThread"];',
    'const alias=chosen;exports.check=()=>alias.isMainThread;',
    'const {isMainThread:flag}=chosen;exports.check=()=>flag;',
    'const {threadId:id,isMainThread:flag}=chosen;exports.check=()=>id;',
    'exports.check=()=>chosen.isMainThread();',
    'for(rows[chosen.threadId] of [1]){}exports.check=()=>chosen.isMainThread;',
    'for(rows[chosen.threadId] in values){}exports.check=()=>chosen.isMainThread;',
    'for({[chosen.threadId]:rows.value} of values){}exports.check=()=>chosen.isMainThread;',
    'for({value:rows.value=chosen.isMainThread} of values){}exports.check=()=>chosen.threadId;',
    '({value:rows.value=chosen.isMainThread}=value);exports.check=()=>chosen.threadId;',
    'function check(flag=chosen.isMainThread){return flag;}exports.check=check;',
  ])('keeps only proved primitive fields ordinary: %s', (use) => {
    const source = SCALAR_CHOICE + use;

    expect(capability(source)).toBe(false);
    expect(dynamicNodeClosureRefusal('/project/scalar.cjs', source)).toBeUndefined();
  });

  it.each([
    'exports.check=()=>chosen.Worker;',
    'exports.check=()=>new chosen.Worker("source",{eval:true});',
    'exports.check=()=>chosen[globalThis.key];',
    'const {isMainThread:flag=true}=chosen;exports.check=()=>flag;',
    'const {...rest}=chosen;exports.check=()=>rest.isMainThread;',
    'const {isMainThread:{value}}=chosen;exports.check=()=>value;',
    'let {isMainThread:flag}=chosen;flag=globalThis.other;exports.check=()=>flag;',
    'chosen.isMainThread=globalThis.other;exports.check=()=>chosen.isMainThread;',
    'const alias=chosen;alias.isMainThread=globalThis.other;exports.check=()=>chosen.isMainThread;',
    'const left=chosen.isMainThread;const right=chosen.threadId;chosen.isMainThread=right;chosen.threadId=left;exports.check=()=>chosen.isMainThread;',
    'chosen.isMainThread.value=0;exports.check=()=>chosen.threadId;',
    'for(chosen.isMainThread of globalThis.values){}exports.check=()=>chosen.isMainThread;',
    'for(chosen.threadId in globalThis.values){}exports.check=()=>chosen.threadId;',
    'let {isMainThread:flag}=chosen;for(flag of globalThis.values){}exports.check=()=>flag;',
    'let {threadId:id}=chosen;for(id in globalThis.values){}exports.check=()=>id;',
    'const {value:Thread=chosen.Worker}=input;exports.start=()=>new Thread("source",{eval:true});',
    'function start(Thread=chosen.Worker){return new Thread("source",{eval:true});}exports.start=start;',
    'for({value:rows.value=chosen.Worker} of values){}exports.check=()=>chosen.threadId;',
    'for({value:rows.value={Worker:chosen.Worker}} of values){}exports.check=()=>chosen.threadId;',
  ])('keeps unknown selections, patterns and mutations strict and terminating: %s', (use) => {
    const source = SCALAR_CHOICE + use;

    expect(capability(source)).toBe(true);
    expect(dynamicNodeClosureRefusal('/project/scalar.cjs', source)).toBeTypeOf('string');
  });

  it.each([
    'globalThis.other',
    '{}',
    '{isMainThread:globalThis.other}',
    "{isMainThread:require('node:worker_threads').Worker}",
    '{get isMainThread(){return true;}}',
    '{isMainThread(){return true;}}',
    '{isMainThread:true,...globalThis.other}',
    '{isMainThread:true,[globalThis.key]:false}',
  ])('does not assume an unknown ordinary object property is scalar: %s', (other) => {
    const source = `const chosen=process.env.USE?require('node:worker_threads'):${other};exports.check=()=>chosen.isMainThread;`;

    expect(capability(source)).toBe(true);
    expect(dynamicNodeClosureRefusal('/project/scalar.cjs', source)).toBeTypeOf('string');
  });
});

describe('closed Worker value selections', () => {
  it.each(SELECTIONS)('retains known capability through selected value %s', (selection) => {
    const source = programSource(selection);

    expect(capability(source)).toBe(true);
    expect(dynamicNodeClosureRefusal('/project/selection.mjs', source)).toBe(
      'an unproved Node Worker native-child closure',
    );
  });

  it.each([
    `${IMPORT}const ns=process.env.USE?require('node:worker_threads'):{};export const start=()=>new ns.Worker('source',{eval:true});`,
    `${IMPORT}const {Worker:Thread}=process.env.USE?require('node:worker_threads'):{};export const start=()=>new Thread('source',{eval:true});`,
    `${IMPORT}const first=process.env.USE?Worker:class{};const second=first;export const start=()=>new second('source',{eval:true});`,
    `${IMPORT}let Thread=process.env.USE?Worker:class{};Thread=class{};export const start=()=>new Thread('source',{eval:true});`,
    `${IMPORT}export const choose=()=>process.env.USE?Worker:class{};`,
    `${IMPORT}export const value=consume(process.env.USE?Worker:class{});`,
    `${IMPORT}let selected;export const value=(selected=process.env.USE?Worker:class{});`,
    `${IMPORT}let selected;selected ||= Worker;export const start=()=>new selected('source',{eval:true});`,
    `${IMPORT}export const value=(new Worker('source',{eval:true}),42);`,
    `${IMPORT}export const value=process.env.USE&&new Worker('source',{eval:true});`,
    `${IMPORT}export const value=process.env.USE||new Worker('source',{eval:true});`,
    `${IMPORT}export const value=process.env.USE??new Worker('source',{eval:true});`,
    `${IMPORT}if(process.env.USE){new Worker('source',{eval:true});}export const value=42;`,
    `${IMPORT}export const value=true&&new Worker('source',{eval:true});`,
    `${IMPORT}export const value=false||new Worker('source',{eval:true});`,
    `${IMPORT}export const value=null??new Worker('source',{eval:true});`,
    `${IMPORT}if(1){new Worker('source',{eval:true});}export const value=42;`,
    `${IMPORT}export const value=/value/&&new Worker('source',{eval:true});`,
    `${IMPORT}export const value={}&&new Worker('source',{eval:true});`,
  ])(
    'keeps namespace/destructure/alias/return/handoff and executed operands strict: %s',
    (source) => {
      expect(capability(source)).toBe(true);
      expect(dynamicNodeClosureRefusal('/project/selection.mjs', source)).toBeTypeOf('string');
    },
  );

  it.each([
    'false?Worker:class{}',
    'true?class{}:Worker',
    '0?Worker:class{}',
    '0n?Worker:class{}',
    "''?Worker:class{}",
    'false&&Worker',
    '0n&&Worker',
    'true||Worker',
    '0??Worker',
    '(Worker,class{})',
  ])('keeps the statically unselected Worker value ordinary: %s', (selection) => {
    const source = `${IMPORT}const chosen=${selection};export const value=chosen;`;

    expect(capability(source)).toBe(false);
    expect(dynamicNodeClosureRefusal('/project/selection.mjs', source)).toBeUndefined();
  });

  it.each([
    'true&&Worker',
    'false||Worker',
    'null??Worker',
    "''||Worker",
    '1n&&Worker',
    '0n||Worker',
  ])('keeps a literal-selected Worker constructor strict: %s', (selection) => {
    expect(capability(programSource(selection))).toBe(true);
  });

  it.each([
    `${IMPORT}export const value=false&&new Worker('source',{eval:true});`,
    `${IMPORT}export const value=true||new Worker('source',{eval:true});`,
    `${IMPORT}export const value=true?42:new Worker('source',{eval:true});`,
    `${IMPORT}export const value=false?new Worker('source',{eval:true}):42;`,
    `${IMPORT}if(0){new Worker('source',{eval:true});}export const value=42;`,
    `${IMPORT}export const value=42??new Worker('source',{eval:true});`,
    `${IMPORT}export function local(Worker){const Thread=process.env.USE?Worker:class{};return new Thread('source');}`,
    'class Worker{};const Thread=process.env.USE?Worker:class{};export const start=()=>new Thread();',
    "import threads from 'node:worker_threads';export const value=process.env.USE?threads.isMainThread:false;",
  ])('keeps impossible sites and genuine lexical/scalar shadows ordinary: %s', (source) => {
    expect(capability(source)).toBe(false);
    expect(dynamicNodeClosureRefusal('/project/selection.mjs', source)).toBeUndefined();
  });
});

describe('retained native selection markers', () => {
  let directory: string;
  let entry: string;
  let binary: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-worker-selections-'));
    directory = await realpath(temporary);
    entry = path.join(directory, 'entry.mjs');
    binary = path.join(directory, 'addon.node');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function bundle(source: string, markers: boolean, compress = false) {
    await writeFile(entry, source);
    const proof = nativeLoadsPlugin([{ id: '/native', assets: { entry, binary } }], {
      nodeTarget: true,
    });
    await using build = await rolldown({
      input: entry,
      platform: 'node',
      plugins: markers ? [proof.plugin] : [],
      external: ['node:worker_threads'],
    });
    const output = await build.generate({ format: 'esm', minify: { compress, mangle: false } });
    const chunk = output.output.find((part): part is OutputChunk => part.type === 'chunk');
    if (chunk === undefined) throw new Error('Expected the authored selection chunk');
    return { proof, chunk };
  }

  it.each(SELECTIONS)('keeps eager source child markers for native-owned %s', async (selection) => {
    const { proof, chunk } = await bundle(programSource(selection), true);

    expect(chunk.code).toContain('__UPWIND_NATIVE_WORKER_CHILD__');
    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });

  it.each([false, true])(
    'keeps a final rendered actual native closure strict without eager marker metadata (compress %s)',
    async (compress) => {
      const source = programSource('process.env.USE_WORKER?Worker:class{}');
      const { proof, chunk } = await bundle(source, false, compress);

      expect(chunk.code).not.toContain('__UPWIND_NATIVE_WORKER_CHILD__');
      await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
      expect(dynamicNodeClosureRefusal(entry, chunk.code)).toBeTypeOf('string');
    },
  );

  it('preserves a genuine native load but refuses its selected unknown child closure', async () => {
    const source = `${programSource('process.env.USE_WORKER?Worker:class{}')}export const addon=require('./addon.node');`;
    const { proof, chunk } = await bundle(source, true, true);

    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });

  it('drops only literal-dead analysis markers and keeps a trace-only Worker artifact marker-free', async () => {
    const source = `${IMPORT}export const value=false&&new Worker('source',{eval:true});`;
    const { proof, chunk } = await bundle(source, true, true);

    await expect(proof.retained(chunk)).resolves.toStrictEqual([]);
    expect(chunk.code).not.toContain('__UPWIND_NATIVE_');
  });

  it.each(['chosen.isMainThread', 'flag'])(
    'keeps trace-only scalar source marker-free after real source/final analysis: %s',
    async (value) => {
      const source = `${SCALAR_CHOICE}const {isMainThread:flag}=chosen;exports.check=()=>${value};`;
      const { proof, chunk } = await bundle(source, true, true);

      await expect(proof.retained(chunk)).resolves.toStrictEqual([]);
      expect(chunk.code).not.toContain('__UPWIND_NATIVE_');
    },
  );

  it('does not mint an eager child marker for a proved literal-dead original site', async () => {
    const source = `${IMPORT}if(false){new Worker('source',{eval:true});}`;
    const program = parseAst(source);
    const tree = walk(program);
    const node = constructorOf(program);
    let marks = 0;
    const edit = await nativeWorkerEdit(node, {
      source,
      importer: entry,
      traces: [{ id: '/native', assets: { entry, binary } }],
      tree,
      bindings: nativeBindings(program),
      nodeTarget: true,
      guards: new Map(),
      markChild() {
        marks += 1;
        return 'unexpected-marker';
      },
    });

    expect(edit).toBeUndefined();
    expect(marks).toBe(0);
  });
});
