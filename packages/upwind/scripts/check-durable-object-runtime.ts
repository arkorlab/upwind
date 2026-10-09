import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DurableObjectDeclaration } from '@stayingupwind/core/bundle';
import { UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';

import { BlobStore } from '../../adapter/src/blobs.ts';
import { durableObjectParts } from '../../adapter/src/durable-objects.ts';
import { blob, d1, durableObject, kv } from '../../sdk/src/named.ts';
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

export async function checkMissingPackageEntry(
  project: string,
  declaration: DurableObjectDeclaration,
  counterFixture: string,
): Promise<void> {
  const directory = path.join(project, 'generated-package');
  const entry = path.join(directory, 'src', 'entry.js');
  const alternate = path.join(directory, 'src', 'module.js');
  const source = 'package-entry-counter.ts';
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(
    path.join(directory, 'package.json'),
    '{"main":"src/entry.js","module":"src/module.js"}',
  );
  await writeFile(path.join(project, source), 'export { Counter } from "./generated-package";');
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([{ ...declaration, module: source }]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.equal(durableObject('COUNTERS'), undefined);
    assert.ok(resources.watchedFiles?.includes(entry) === true);
    assert.ok(resources.watchedFiles.includes(alternate));
    assert.equal(resources.sourcesChanged?.(), false);
    await writeFile(entry, await readFile(counterFixture));
    assert.equal(resources.sourcesChanged(), true);
  } finally {
    await resources.dispose();
  }
}

export async function checkRuntimeFailure(
  project: string,
  declaration: DurableObjectDeclaration,
  counterFixture: string,
): Promise<void> {
  const source = 'runtime-failure-counter.ts';
  const file = path.join(project, source);
  await writeFile(
    file,
    'import { DurableObject } from "cloudflare:workers"; throw new Error("fixture-startup-failure"); export class Counter extends DurableObject {}',
  );
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([{ ...declaration, module: source }]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.equal(durableObject('COUNTERS'), undefined);
    const database = d1('UPWIND_D1');
    const namespace = kv('UPWIND_KV');
    const bucket = blob('UPWIND_R2');
    assert.ok(database);
    assert.ok(namespace);
    assert.ok(bucket);
    assert.equal(await database.prepare('SELECT 1 AS value').first<number>('value'), 1);
    await namespace.put('startup-recovery', 'available');
    assert.equal(await namespace.get('startup-recovery'), 'available');
    await bucket.put('startup-recovery', 'available');
    assert.equal(await (await bucket.get('startup-recovery'))?.text(), 'available');
    assert.ok(resources.watchedFiles?.includes(file) === true);
    assert.equal(resources.sourcesChanged?.(), false);
    await writeFile(file, await readFile(counterFixture));
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
  assert.deepEqual(dependencies.wasmModules, []);
  const wasmModule = parts.functions.durableObjects?.['COUNTERS']?.modules.find(
    (module) => module.type === 'wasm',
  );
  assert.ok(wasmModule);
  assert.deepEqual(dependencies.compiledWasmModules, [
    { file: WASM_FILE, module: wasmModule.name },
  ]);
  assert.ok(dependencies.externals.every((specifier) => !specifier.startsWith('./wasm/')));
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
