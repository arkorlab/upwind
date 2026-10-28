import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nativeLoadsPlugin } from '../src/native-loads.ts';

describe('native process loader origins', () => {
  let directory: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-process-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    binary = path.join(directory, 'addon.node');
    // Bundling only: these authored bytes are never imported or executed as an addon.
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function classify(source: string, commonjs = false, nodeTarget = false) {
    const entry = path.join(directory, commonjs ? 'entry.cjs' : 'entry.mjs');
    await writeFile(entry, source);
    const proof = nativeLoadsPlugin([{ id: '/native', assets: { entry, binary } }], {
      nodeTarget,
    });
    await using build = await rolldown({
      input: entry,
      platform: 'neutral',
      plugins: [proof.plugin],
      external: ['node:path', 'path', 'node:process', 'process'],
    });
    const output = await build.generate({ format: 'esm' });
    const chunk = output.output.find((part): part is OutputChunk => part.type === 'chunk');
    if (chunk === undefined) throw new Error('The process source fixture produced no chunk');
    return { entry, loads: await proof.retained(chunk) };
  }

  it.each([
    "const proc=require('node:process'); const path=require('node:path'); proc.dlopen(module,path.join(__dirname,'addon.node'));\n",
    "const proc=require('process'); const path=require('node:path'); const open=proc.dlopen; open(module,path.join(__dirname,'addon.node'));\n",
    "const {dlopen:open}=require('node:process'); const path=require('node:path'); open(module,path.join(__dirname,'addon.node'));\n",
    "const path=require('node:path'); require('node:process')['dlopen'](module,path.join(__dirname,'addon.node'));\n",
  ])('proves a CommonJS builtin namespace or dlopen alias: %s', async (source) => {
    const result = await classify(source, true);

    expect(result.loads).toStrictEqual([
      { kind: 'dlopen', importer: result.entry, binary, owners: ['/native'] },
    ]);
  });

  it.each([
    "import proc from 'node:process'; const path=require('node:path'); proc.dlopen(module,path.join(__dirname,'addon.node'));\n",
    "import * as proc from 'node:process'; const path=require('node:path'); proc['dlopen'](module,path.join(__dirname,'addon.node'));\n",
    "import {dlopen as open} from 'node:process'; const path=require('node:path'); open(module,path.join(__dirname,'addon.node'));\n",
    "import {dlopen} from 'process'; const path=require('node:path'); const alias=dlopen; alias(module,path.join(__dirname,'addon.node'));\n",
  ])(
    'recognizes ES module builtin loaders but refuses unproved CommonJS operands: %s',
    async (source) => {
      await expect(classify(source)).rejects.toThrow(
        'ES module native loaders require explicitly proved',
      );
    },
  );

  it.each([
    "export function run(process){process.dlopen({},'./addon.node');}\n",
    "const process={dlopen:()=>42}; export const result=process.dlopen({},'./addon.node');\n",
    "import * as proc from 'node:process'; export function run(proc){proc.dlopen({},'./addon.node');}\n",
    "import {dlopen as open} from 'node:process'; export function run(open){open({},'./addon.node');}\n",
  ])('does not claim an application object or a nearer local shadow: %s', async (source) => {
    const result = await classify(source);

    expect(result.loads).toStrictEqual([]);
  });

  it.each([
    "let proc=require('node:process'); proc=globalThis.custom; proc.dlopen(module,'./addon.node');\n",
    "const proc=require('node:process'); let open=proc.dlopen; open=globalThis.custom; open(module,'./addon.node');\n",
    "const proc=require('node:process'); module.exports=(name)=>proc[name](module,'./addon.node');\n",
    "const proc=require('node:process'); module.exports=proc.dlopen.bind(proc);\n",
    "const proc=require('node:process'); delete proc.dlopen; proc.dlopen(module,'./addon.node');\n",
  ])('refuses a modified or unresolved builtin loader path after retention: %s', async (source) => {
    await expect(classify(source, true)).rejects.toThrow('process loader cannot be classified');
  });

  it('leaves known non-loader process methods alone despite an unrelated env mutation', async () => {
    const result = await classify(
      "import proc from 'node:process'; proc.env.UPWIND_AUTHORED_TEST='value'; export const run=()=>proc.nextTick(()=>{});\n",
    );

    expect(result.loads).toStrictEqual([]);
  });

  it('keeps dead builtin loads and the existing plain guarded Worker fallback out of placement', async () => {
    const dead = await classify(
      "const proc=require('node:process'); if(false)proc.dlopen(module,'./addon.node'); module.exports=42;\n",
      true,
    );
    const guarded = await classify(
      "const {dlopen:open}=require('node:process'); try{open(module,'./addon.node');}catch{} module.exports={wasm:true};\n",
      true,
    );

    expect({ dead: dead.loads, guarded: guarded.loads }).toStrictEqual({ dead: [], guarded: [] });
  });

  it('refuses the same guarded builtin alias during the final strict Node proof', async () => {
    const source =
      "const {dlopen:open}=require('node:process'); try{open(module,'./addon.node');}catch{} module.exports={wasm:true};\n";

    await expect(classify(source, true, true)).rejects.toThrow('unclassified on the Node target');
  });
});
