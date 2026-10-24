import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  arkorWasmGlobal,
  WasmCollector,
  wasmChunks,
  wasmEntrySource,
  wasmModuleName,
} from '../src/wasm.ts';

/**
 * What the Worker publishes as WebAssembly, and under which names. The module is
 * content-addressed, so the same bytes reached from two places are one module; and a file a trace
 * merely mentioned ships only once something is found to read it.
 */

const ADD = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00, 0x07, 0x0b, 0x01, 0x07, 0x61, 0x64, 0x64, 0x5f, 0x6f, 0x6e, 0x65, 0x00,
  0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x41, 0x01, 0x6a, 0x0b,
]);
const OTHER = Uint8Array.from([...ADD.slice(0, -1), 0x0b, 0x0b]);
/** sha256 of `ADD`; the module's name and the tail of the global it is published under. */
const ADD_SHA = '8f581f8899890a7479c20494f53cc5d60156a4d42e39d6a587a9f3089f198fe0';

describe('wasmCollector', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adapter-wasm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function file(name: string, bytes: Uint8Array): Promise<string> {
    const full = path.join(dir, name);
    await writeFile(full, bytes);
    return full;
  }

  it('ships a module only once something reads it, and never one nothing does', async () => {
    const collector = new WasmCollector();
    const read = await file('read.wasm', ADD);
    const traced = await file('traced.wasm', OTHER);

    const sha = await collector.offer(read);
    await collector.offer(traced);

    // Both were offered — the build reached WebAssembly, so the Worker needs a `wasm.mjs` —
    // but only the one with a name to publish it under travels.
    expect(collector.hasCandidates).toBe(true);
    expect(collector.modules).toStrictEqual([]);

    collector.publish(sha, arkorWasmGlobal(sha));

    expect(collector.modules.map((module) => module.sha256)).toStrictEqual([ADD_SHA]);
  });

  it('makes one module of the same bytes reached twice, under every name that reads it', async () => {
    const collector = new WasmCollector();
    // What Turbopack does with one `.wasm` imported two ways: a copy per loader.
    const first = await file('a.wasm', ADD);
    const second = await file('b.wasm', ADD);

    const one = await collector.offer(first);
    const two = await collector.offer(second);
    collector.publish(one, 'wasm_57e7');
    collector.publish(two, arkorWasmGlobal(two));
    // Asking twice for the same name does not add it twice.
    collector.publish(one, 'wasm_57e7');

    expect(one).toBe(two);
    expect(collector.modules).toHaveLength(1);
    expect(collector.modules[0]?.globals).toStrictEqual(['wasm_57e7', arkorWasmGlobal(ADD_SHA)]);
  });

  it('knows a file it was offered, and says nothing of one it was not', async () => {
    const collector = new WasmCollector();
    const offered = await file('a.wasm', ADD);

    await collector.offer(offered);

    // The bundler asks by the path it resolved; a `.wasm` no trace named has no module.
    expect(collector.shaFor(offered)).toBe(ADD_SHA);
    expect(collector.shaFor(path.join(dir, 'b.wasm'))).toBeUndefined();
    expect(() => {
      collector.publish('nothing', 'x');
    }).toThrow(/no WebAssembly module was offered/u);
  });

  it('has no candidates when a build reached no WebAssembly', () => {
    expect(new WasmCollector().hasCandidates).toBe(false);
  });
});

describe('wasmEntrySource', () => {
  it('imports each module once and publishes it under every name that reads it', () => {
    const source = wasmEntrySource([
      { sha256: 'aa', bytes: ADD, globals: ['wasm_57e7', '__arkorWasm_aa'] },
      { sha256: 'bb', bytes: OTHER, globals: ['__arkorWasm_bb'] },
    ]);

    expect(source).toContain("import wasm0 from './wasm/aa.wasm';");
    expect(source).toContain('globalThis.wasm_57e7 ??= wasm0;');
    expect(source).toContain('globalThis.__arkorWasm_aa ??= wasm0;');
    expect(source).toContain("import wasm1 from './wasm/bb.wasm';");
    expect(source).toContain('globalThis.__arkorWasm_bb ??= wasm1;');
    // Nothing is exported: importing it is the whole of what it does.
    expect(source).not.toContain('export');
  });

  it('is a module with nothing in it when nothing was published', () => {
    // The runtime bundle may still import it: whether there is a `wasm.mjs` is decided before
    // the app bundle has resolved a `?module` import, so an empty one has to be a valid module.
    const source = wasmEntrySource([]);

    expect(source).not.toMatch(/^import /mu);
    expect(source).not.toContain('globalThis.');
  });
});

describe('wasmChunks', () => {
  it('names each path once, however many traces reached the file', () => {
    // A route's traced assets and the instrumentation hook's trace may be the same `.wasm`, and
    // the table is a `switch` on the path: a second case for it would never be reached, and the
    // count the build reports would be wrong.
    expect(
      wasmChunks('/project/.next', [
        { filePath: '/project/.next/server/chunks/add.wasm', sha256: ADD_SHA },
        { filePath: '/project/.next/server/chunks/add.wasm', sha256: ADD_SHA },
      ]),
    ).toStrictEqual([{ chunkPath: 'server/chunks/add.wasm', global: arkorWasmGlobal(ADD_SHA) }]);
  });

  it('keys the table by the path Turbopack asks for, relative to the build directory', () => {
    // The loader's argument is the `.wasm` relative to the runtime root, which is `distDir`.
    expect(
      wasmChunks('/project/.next', [
        { filePath: '/project/.next/server/chunks/add.wasm', sha256: ADD_SHA },
      ]),
    ).toStrictEqual([{ chunkPath: 'server/chunks/add.wasm', global: arkorWasmGlobal(ADD_SHA) }]);
  });
});

describe('wasmModuleName', () => {
  it('names a module by its content, so two deployments of the same bytes agree', () => {
    expect(wasmModuleName(ADD_SHA)).toBe(`wasm/${ADD_SHA}.wasm`);
    expect(arkorWasmGlobal(ADD_SHA)).toBe('__arkorWasm_8f581f8899890a7479c20494f53cc5d6');
  });
});
