import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nativeBindings, walk } from '../src/native-ast.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';
import { hasRetainedWorkerCapability } from '../src/native-worker.ts';

interface FixtureOptions {
  readonly placementProbe?: boolean;
  readonly nodeTarget?: boolean;
  readonly nativeCode?: string;
  readonly onlyNative?: boolean;
  readonly shared?: boolean;
}

describe('retained Worker capability source ownership', () => {
  let directory: string;
  let native: string;
  let worker: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-worker-origin-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    native = path.join(directory, 'native.mjs');
    worker = path.join(directory, 'worker.mjs');
    binary = path.join(directory, 'addon.node');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function bundle(compress: boolean, options: FixtureOptions = {}) {
    const entry = path.join(directory, 'entry.mjs');
    const nativeCode = options.nativeCode ?? "export const nativeValue=require('./addon.node');";
    await writeFile(native, nativeCode);
    await writeFile(
      worker,
      "import {Worker} from 'node:worker_threads';export const start=()=>new Worker('source',{eval:true});",
    );
    await writeFile(
      entry,
      options.onlyNative === true
        ? "export * from './native.mjs';"
        : "export * from './native.mjs';export {start} from './worker.mjs';",
    );
    const assets = options.shared === true ? { native, binary, worker } : { native, binary };
    const proof = nativeLoadsPlugin([{ id: '/native', assets }], {
      placementProbe: options.placementProbe === true,
      nodeTarget: options.nodeTarget === true,
    });
    await using build = await rolldown({
      input: entry,
      platform: 'neutral',
      plugins: [proof.plugin],
      external: ['node:worker_threads'],
    });
    const output = await build.generate({
      format: 'esm',
      minify: { compress, mangle: false, codegen: { removeWhitespace: compress } },
    });
    const chunk = output.output.find((item): item is OutputChunk => item.type === 'chunk');
    if (chunk === undefined) throw new Error('Expected the authored route chunk');
    return { chunk, proof };
  }

  it.each([false, true])(
    'returns only the genuine native placement signal before unrelated route separation (compress %s)',
    async (compress) => {
      const { chunk, proof } = await bundle(compress, { placementProbe: true });
      const program = parseAst(chunk.code);

      expect(hasRetainedWorkerCapability(walk(program), nativeBindings(program))).toBe(true);
      await expect(proof.retained(chunk)).resolves.toMatchObject([
        { kind: 'direct', importer: native, binary, owners: ['/native'] },
      ]);
    },
  );

  it.each([{}, { nodeTarget: true }, { placementProbe: true, nodeTarget: true }])(
    'retains the immediate actual-closure refusal outside an app placement signal: %j',
    async (options) => {
      const { chunk, proof } = await bundle(true, options);

      await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
    },
  );

  it('does not defer an owning source-level child marker even during placement', async () => {
    const { chunk, proof } = await bundle(true, { placementProbe: true, shared: true });

    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });

  it('never treats a traced binary with no retained operation as a native placement signal', async () => {
    const { chunk, proof } = await bundle(true, {
      placementProbe: true,
      nativeCode: 'export const nativeValue=41;',
    });

    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });

  it('checks the actual native-only entry closure after unrelated route removal', async () => {
    const { chunk, proof } = await bundle(true, { onlyNative: true, nodeTarget: true });

    expect(Object.keys(chunk.modules)).not.toContain(worker);
    await expect(proof.retained(chunk)).resolves.toMatchObject([
      { kind: 'direct', owners: ['/native'] },
    ]);
  });

  const handled = [
    "import {Worker} from 'node:worker_threads';export function start(){try{return new Worker('source',{eval:true});}catch{return {fallback:true};}}",
    "import {Worker} from 'node:worker_threads';export function start(){try{return new Worker.prototype.constructor('source',{eval:true});}catch{return {fallback:true};}}",
    "import threads from 'node:worker_threads';function attempt(){try{return new threads.Worker('source',{eval:true});}catch{return {fallback:true};}}export {attempt};",
  ];

  it.each(handled)(
    'preserves a handled Worker-only fallback with build-only binary assets: %s',
    async (nativeCode) => {
      const { chunk, proof } = await bundle(true, { onlyNative: true, nativeCode });

      await expect(proof.retained(chunk)).resolves.toStrictEqual([]);
      expect(chunk.code).not.toContain('__UPWIND_NATIVE_');
    },
  );

  it.each(handled)('keeps the same fallback strict on the Node target: %s', async (nativeCode) => {
    const { chunk, proof } = await bundle(true, { onlyNative: true, nativeCode, nodeTarget: true });

    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });

  it.each([
    "import {Worker} from 'node:worker_threads';let start;try{start=()=>new Worker('source',{eval:true});}catch{start=()=>42;}export {start};",
    "import {Worker} from 'node:worker_threads';export function get(){try{return Worker;}catch{return ()=>42;}}",
    "import {Worker} from 'node:worker_threads';export function get(){try{return Worker.bind(null);}catch{return ()=>42;}}",
    "import {Worker} from 'node:worker_threads';export function start(){try{return new Worker('source',{eval:true});}catch(error){throw error;}}",
    "import {Worker} from 'node:worker_threads';import threads from 'node:worker_threads';Worker.prototype.constructor=globalThis.other;export function start(){try{return new threads.Worker.prototype.constructor('source');}catch{return 42;}}",
  ])('refuses a deferred, escaping, mutated or unhandled constructor: %s', async (nativeCode) => {
    const { chunk, proof } = await bundle(true, { onlyNative: true, nativeCode });

    await expect(proof.retained(chunk)).rejects.toThrow('unclassified owned native child');
  });
});
