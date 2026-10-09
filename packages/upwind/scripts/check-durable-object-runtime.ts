import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DurableObjectDeclaration } from '@stayingupwind/core/bundle';
import { UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';

import { BlobStore } from '../../adapter/src/blobs.ts';
import { durableObjectParts } from '../../adapter/src/durable-objects.ts';
import { durableObject } from '../../sdk/src/named.ts';
import { startLocalResources } from '../src/resources/local.ts';

const WASM_SOURCE = 'wasm-counter.ts';
const WASM_FILE = 'add.wasm';

export async function checkMissingDependency(
  project: string,
  declaration: DurableObjectDeclaration,
  counterFixture: string,
): Promise<void> {
  const missing = path.join(project, 'generated', 'missing.ts');
  const source = 'missing-import-counter.ts';
  await writeFile(path.join(project, source), 'export { Counter } from "./generated/missing.ts";');
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([{ ...declaration, module: source }]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.equal(durableObject('COUNTERS'), undefined);
    assert.ok(resources.watchedFiles?.includes(missing) === true);
    assert.equal(resources.sourcesChanged?.(), false);
    await mkdir(path.dirname(missing), { recursive: true });
    await writeFile(missing, await readFile(counterFixture));
    assert.equal(resources.sourcesChanged(), true);
  } finally {
    await resources.dispose();
  }
}

export async function checkWasmBinding(
  project: string,
  declaration: DurableObjectDeclaration,
  wasmFixture: string,
): Promise<void> {
  await writeFile(path.join(project, WASM_FILE), await readFile(wasmFixture));
  await writeFile(
    path.join(project, WASM_SOURCE),
    'import { DurableObject } from "cloudflare:workers"; import first from "./add.wasm"; import second from "./add.wasm?module"; export class Counter extends DurableObject { fetch() { if (first !== second) throw new Error("wasm-not-deduplicated"); const instance = new WebAssembly.Instance(first); return new Response(String(instance.exports.add(1, 2))); } }',
  );
  const outDir = path.join(project, '.wasm-build');
  const blobs = new BlobStore(outDir);
  await blobs.init();
  const declarations = [{ ...declaration, module: WASM_SOURCE }];
  const parts = await durableObjectParts({
    projectDir: project,
    outDir,
    blobs,
    declarations,
    split: false,
  });
  assert.equal(
    parts.functions.durableObjects?.['COUNTERS']?.modules.filter((module) => module.type === 'wasm')
      .length,
    1,
  );
  const dependencies = parts.dependencies['durable-object/COUNTERS'];
  assert.ok(dependencies?.other.some((entry) => entry.file === WASM_FILE) === true);
  assert.equal(dependencies.wasmModules.length, 1);
  assert.ok(!dependencies.externals.some((specifier) => specifier.startsWith('./wasm/')));
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify(declarations);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    const counters = durableObject('COUNTERS');
    assert.ok(counters);
    assert.equal(
      await (await counters.getByName('wasm').fetch('https://wasm.invalid/')).text(),
      '3',
    );
    assert.ok(resources.watchedFiles?.includes(path.join(project, WASM_FILE)) === true);
  } finally {
    await resources.dispose();
  }
}
