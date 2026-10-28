import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nativeBindings, walk } from '../src/native-ast.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';
import {
  hasRetainedWorkerCapability,
  retainedWorkerCapabilityNodes,
} from '../src/native-worker.ts';

const SCALAR_THUNK =
  "module.exports=[1,ctx=>{const ns=ctx.x('node:worker_threads',()=>require('node:worker_threads'));ctx.v(ns.isMainThread);}];";
const RETURNS = [
  {
    name: 'application namespace',
    source: "exports.getNamespace=()=>require('node:worker_threads');",
    esm: false,
  },
  {
    name: 'stable namespace alias',
    source: "const threads=require('node:worker_threads');exports.getNamespace=()=>threads;",
    esm: false,
  },
  {
    name: 'application module',
    source: "import * as threads from 'node:worker_threads';export const getNamespace=()=>threads;",
    esm: true,
  },
  {
    name: 'resolved module',
    source:
      "const threads=await import('node:worker_threads');export const getNamespace=()=>threads;",
    esm: true,
  },
] as const;
const INDIRECT = [
  "const get=()=>require('node:worker_threads');exports.child=new (get().Worker)('source',{eval:true});",
  "module.exports=[1,ctx=>{const ns=ctx.x('node:worker_threads',()=>require('node:worker_threads'));ctx.v(new ns.Worker('source',{eval:true}));}];",
];
interface Options {
  readonly nodeTarget?: boolean;
  readonly placementProbe?: boolean;
  readonly esm?: boolean;
  readonly compress?: boolean;
}

describe('worker-only ordinary namespace returns', () => {
  let directory: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-worker-namespace-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    binary = path.join(directory, 'addon.node');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function build(source: string, options: Options = {}) {
    const entry = path.join(directory, options.esm === true ? 'entry.mjs' : 'entry.cjs');
    await writeFile(entry, source);
    const proof = nativeLoadsPlugin([{ id: '/native', assets: { entry, binary } }], {
      nodeTarget: options.nodeTarget === true,
      placementProbe: options.placementProbe === true,
    });
    await using bundle = await rolldown({
      input: entry,
      platform: 'node',
      plugins: [proof.plugin],
      external: ['node:worker_threads', 'worker_threads'],
    });
    const output = await bundle.generate({
      format: options.esm === true ? 'esm' : 'cjs',
      minify: { compress: options.compress === true, mangle: false },
    });
    const chunk = output.output.find((part): part is OutputChunk => part.type === 'chunk');
    if (chunk === undefined) throw new Error('Expected the authored namespace chunk');
    return { chunk, proof, entry };
  }

  it.each([false, true])(
    'keeps a scalar compiler import with trace-only native assets (compress %s)',
    async (compress) => {
      const { chunk, proof, entry } = await build(SCALAR_THUNK, { compress });

      await expect(proof.retained(chunk)).resolves.toStrictEqual([]);
      expect(chunk.code).not.toContain('__UPWIND_NATIVE_');
      await expect(readFile(entry, 'utf8')).resolves.toBe(SCALAR_THUNK);
    },
  );

  it.each(RETURNS)(
    'permits only the ordinary $name return on the Worker target',
    async ({ source, esm }) => {
      const { chunk, proof } = await build(source, { esm });
      const program = parseAst(chunk.code);
      const tree = walk(program);
      const bindings = nativeBindings(program);

      await expect(proof.retained(chunk)).resolves.toStrictEqual([]);
      expect(chunk.code).not.toContain('__UPWIND_NATIVE_');
      expect(hasRetainedWorkerCapability(tree, bindings)).toBe(true);
      expect(
        retainedWorkerCapabilityNodes(tree, bindings, undefined, { nodeTarget: false }),
      ).toStrictEqual([]);
    },
  );

  it.each(RETURNS)('keeps $name strict on the Node target', async ({ source, esm }) => {
    const { chunk, proof } = await build(source, { esm, nodeTarget: true });

    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });

  it('keeps the exact scalar import thunk strict on the Node target', async () => {
    const { chunk, proof } = await build(SCALAR_THUNK, { nodeTarget: true });

    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });

  it.each([
    "const threads=require('node:worker_threads');exports.get=()=>threads.Worker;",
    "const threads=require('node:worker_threads');exports.get=()=>threads.Worker.prototype;",
    "exports.get=()=>import('node:worker_threads');",
    "const threads=require('node:worker_threads');exports.get=(key)=>threads[key];",
    "const threads=require('node:worker_threads');exports.value=new threads.Worker('source',{eval:true});",
    "const threads=require('node:worker_threads');exports.value=consume(threads);",
    "module.exports=require('node:worker_threads');",
    "const threads=require('node:worker_threads');exports.Child=threads.Worker;",
    "const threads=require('node:worker_threads');threads.Worker=globalThis.other;exports.get=()=>threads;",
    "const a=require('node:worker_threads');const b=require('node:worker_threads');b.Worker=globalThis.other;exports.get=()=>a;",
  ])(
    'retains known constructor, promise, ambiguous, handoff, export and mutation refusal: %s',
    async (source) => {
      const { chunk, proof } = await build(source);

      await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
    },
  );

  // Worker stubs cannot run these children. This profile deliberately does not infer indirect
  // constructor results; accepting this Worker code is not worker_threads execution support.
  it.each(INDIRECT)('documents the Worker-only indirect-flow limitation: %s', async (source) => {
    const { chunk, proof } = await build(source);

    await expect(proof.retained(chunk)).resolves.toStrictEqual([]);
    expect(chunk.code).not.toContain('__UPWIND_NATIVE_');
  });

  it.each(INDIRECT)('keeps the same indirect-flow source refused on Node: %s', async (source) => {
    const { chunk, proof } = await build(source, { nodeTarget: true });

    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });

  it.each([false, true])(
    'keeps a fresh require return strict after shared namespace mutation (Node %s)',
    async (nodeTarget) => {
      const source =
        "const threads=require('node:worker_threads');threads.Worker=globalThis.other;exports.get=()=>require('node:worker_threads');";
      const { chunk, proof } = await build(source, { nodeTarget });

      await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
    },
  );

  it('still selects a genuine native load before a strict Node recheck of the same namespace return', async () => {
    const source =
      "const addon=require('./addon.node');exports.value=addon;exports.getNamespace=()=>require('node:worker_threads');";
    const worker = await build(source, { placementProbe: true });

    await expect(worker.proof.retained(worker.chunk)).resolves.toMatchObject([
      { kind: 'direct', importer: worker.entry, binary, owners: ['/native'] },
    ]);

    const node = await build(source, { placementProbe: true, nodeTarget: true });

    await expect(node.proof.retained(node.chunk)).rejects.toThrow(
      'unclassified owned native child',
    );
  });
});
