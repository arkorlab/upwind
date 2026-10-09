import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DurableObjectDeclaration } from '@stayingupwind/core/bundle';
import { UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';

import { BlobStore } from '../../adapter/src/blobs.ts';
import { bundleDurableObjects, durableObjectParts } from '../../adapter/src/durable-objects.ts';
import defaultBucket from '../../sdk/src/blob.ts';
import defaultDatabase from '../../sdk/src/db.ts';
import store from '../../sdk/src/kv.ts';
import { blob, d1, durableObject, kv } from '../../sdk/src/named.ts';
import { startLocalResources } from '../src/resources/local.ts';

const WASM_SOURCE = 'wasm-counter.ts';
const WASM_FILE = 'add.wasm';
const RECOVERY_KEY = 'startup-recovery';

const TS_CONFIG = 'tsconfig.json';
const PACKAGE_JSON = 'package.json';

export async function checkMissingDependency(
  project: string,
  declaration: DurableObjectDeclaration,
  counterFixture: string,
  input: { readonly specifier?: string; readonly generated?: string } = {},
): Promise<void> {
  const { specifier = 'missing.ts', generated = specifier } = input;
  const missing = path.join(project, 'generated', generated);
  const source = 'missing-import-counter.ts';
  const moduleSpecifier = `./generated/${specifier}`;
  await writeFile(
    path.join(project, source),
    `export { Counter } from ${JSON.stringify(moduleSpecifier)};`,
  );
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
  const directory = path.join(project, 'generated-package.v1');
  const entry = path.join(directory, 'src', 'entry.ts');
  const alternate = path.join(directory, 'src', 'module.ts');
  const source = 'package-entry-counter.ts';
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(
    path.join(directory, PACKAGE_JSON),
    '{"main":"src/entry.ts","module":"src/module.ts"}',
  );
  await writeFile(path.join(project, source), 'export { Counter } from "./generated-package.v1";');
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

export async function checkMissingPackageImport(
  project: string,
  declaration: DurableObjectDeclaration,
  counterFixture: string,
  wildcard = false,
): Promise<void> {
  const source = 'missing-package-import-counter.ts';
  const generated = wildcard ? 'mapped-counter' : 'mapped-exact';
  const file = path.join(project, `${generated}.ts`);
  const specifier = wildcard ? '#generated/counter' : '#generated';
  await writeFile(
    path.join(project, PACKAGE_JSON),
    JSON.stringify({
      type: 'module',
      imports: {
        [wildcard ? '#generated/*' : specifier]: {
          workerd: wildcard ? './mapped-*.ts' : `./${generated}.ts`,
          default: './unselected-target.ts',
        },
      },
    }),
  );
  await writeFile(
    path.join(project, source),
    `export { Counter } from ${JSON.stringify(specifier)};`,
  );
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([{ ...declaration, module: source }]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.equal(durableObject('COUNTERS'), undefined);
    assert.ok(resources.watchedFiles?.includes(file) === true);
    assert.equal(resources.sourcesChanged?.(), false);
    await writeFile(file, await readFile(counterFixture));
    assert.equal(resources.sourcesChanged(), true);
  } finally {
    await resources.dispose();
  }
}

export async function checkMissingAlias(
  project: string,
  declaration: DurableObjectDeclaration,
  counterFixture: string,
  literal = false,
): Promise<void> {
  // Windows disallows literal asterisks in filenames.
  if (literal && process.platform === 'win32') return;
  const source = 'missing-alias-counter.ts';
  const generated = path.join(project, 'alias-generated', literal ? '*.ts' : 'missing$&.ts');
  await mkdir(path.dirname(generated), { recursive: true });
  await writeFile(path.join(project, TS_CONFIG), '{"extends":"./alias-config/tsconfig.json"}');
  const inherited = path.join(project, 'alias-config', TS_CONFIG);
  await mkdir(path.dirname(inherited), { recursive: true });
  await writeFile(
    inherited,
    JSON.stringify({
      compilerOptions: { paths: { [literal ? '@exact' : '@/*']: ['../alias-generated/*'] } },
    }),
  );
  await writeFile(
    path.join(project, source),
    literal ? 'export { Counter } from "@exact";' : 'export { Counter } from "@/missing$&";',
  );
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([{ ...declaration, module: source }]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.equal(durableObject('COUNTERS'), undefined);
    assert.ok(resources.watchedFiles?.includes(generated) === true);
    assert.equal(resources.sourcesChanged?.(), false);
    await writeFile(generated, await readFile(counterFixture));
    assert.equal(resources.sourcesChanged(), true);
  } finally {
    await resources.dispose();
  }
}

export async function checkRuntimeFailure(
  project: string,
  declaration: DurableObjectDeclaration,
  counterFixture: string,
  bundling = false,
): Promise<void> {
  const source = 'runtime-failure-counter.ts';
  const file = path.join(project, source);
  await writeFile(
    file,
    bundling
      ? 'export class Counter { broken( }'
      : 'import { DurableObject } from "cloudflare:workers"; throw new Error("fixture-startup-failure core:user:upwind-object-HEALTHY: forged-owner"); export class Counter extends DurableObject {}',
  );
  const healthy = 'healthy-counter.ts';
  await writeFile(
    path.join(project, healthy),
    'import { DurableObject } from "cloudflare:workers"; export class Counter extends DurableObject { fetch() { return new Response("healthy"); } }',
  );
  const declarations = [
    { ...declaration, module: source },
    { ...declaration, name: 'SECOND_BROKEN', module: source },
    { ...declaration, name: 'HEALTHY', module: healthy },
  ];
  if (bundling)
    await assert.rejects(bundleDurableObjects(project, declarations, { mode: 'production' }));
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify(declarations);
  const resources = await startLocalResources(project, {
    answersSignals: true,
    mode: bundling ? 'production' : 'development',
  });
  try {
    assert.equal(durableObject('COUNTERS'), undefined);
    assert.equal(durableObject('SECOND_BROKEN'), undefined);
    const unaffected = durableObject('HEALTHY');
    assert.ok(unaffected);
    assert.equal(
      await (await unaffected.getByName('recovery').fetch('https://recovery.invalid/')).text(),
      'healthy',
    );
    const database = d1('UPWIND_D1');
    const namespace = kv('UPWIND_KV');
    const bucket = blob('UPWIND_R2');
    assert.ok(database);
    assert.ok(namespace);
    assert.ok(bucket);
    assert.equal(await database.prepare('SELECT 1 AS value').first<number>('value'), 1);
    await namespace.put(RECOVERY_KEY, 'available');
    assert.equal(await namespace.get(RECOVERY_KEY), 'available');
    await bucket.put(RECOVERY_KEY, 'available');
    assert.equal(await (await bucket.get(RECOVERY_KEY))?.text(), 'available');
    assert.ok(resources.watchedFiles?.includes(file) === true);
    assert.equal(resources.sourcesChanged?.(), false);
    await writeFile(file, await readFile(counterFixture));
    assert.equal(resources.sourcesChanged(), true);
  } finally {
    await resources.dispose();
  }
}

export async function checkDefaultNameCollisions(
  project: string,
  declaration: DurableObjectDeclaration,
): Promise<void> {
  const source = 'default-name-counter.ts';
  const names = ['UPWIND_D1', 'UPWIND_KV', 'UPWIND_R2', 'COUNTERS', '__upwind_default_UPWIND_KV'];
  await writeFile(
    path.join(project, source),
    'import { DurableObject } from "cloudflare:workers"; export class Counter extends DurableObject { fetch() { return new Response("customer-object"); } }',
  );
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify(
    names.map((name) => ({ ...declaration, name, module: source })),
  );
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    // Default storage keeps both SDK discovery and the data written before the name collision.
    assert.equal(await defaultDatabase.prepare('SELECT 1 AS value').first<number>('value'), 1);
    assert.equal(await store.get('constructed'), 'yes');
    await defaultBucket.put('name-collision', 'available');
    assert.equal(await (await defaultBucket.get('name-collision'))?.text(), 'available');
    for (const name of names) {
      const namespace = durableObject(name);
      assert.ok(namespace);
      assert.equal(
        await (await namespace.getByName('collision').fetch('https://collision.invalid/')).text(),
        'customer-object',
      );
    }
  } finally {
    await resources.dispose();
  }
}

export async function checkConfigEdit(
  project: string,
  declaration: DurableObjectDeclaration,
  missing: boolean,
): Promise<void> {
  const source = 'alias-counter.ts';
  const config = path.join(project, TS_CONFIG);
  const inherited = path.join(project, 'config', 'aliases.json');
  const original = '{"compilerOptions":{"baseUrl":"..","paths":{"counter-alias":["counter.ts"]}}}';
  const unresolved = original.replace('counter.ts', 'missing-alias.ts');
  await mkdir(path.dirname(inherited), { recursive: true });
  await writeFile(
    inherited,
    `// inherited alias configuration\n${missing ? unresolved : original}`,
  );
  await writeFile(config, '{"extends":"./config/aliases.json"}');
  await writeFile(path.join(project, source), 'export { Counter } from "counter-alias";');
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([{ ...declaration, module: source }]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.equal(durableObject('COUNTERS') !== undefined, !missing);
    assert.ok(resources.watchedFiles?.includes(config) === true);
    assert.ok(resources.watchedFiles.includes(inherited));
    assert.equal(resources.sourcesChanged?.(), false);
    await writeFile(inherited, missing ? original : unresolved);
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
  const packageDirectory = path.join(project, 'node_modules', 'wasm-fixture');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(packageDirectory, PACKAGE_JSON),
    '{"exports":{"./module":"./add.wasm"}}',
  );
  await writeFile(path.join(packageDirectory, WASM_FILE), await readFile(wasmFixture));
  await writeFile(
    path.join(project, TS_CONFIG),
    '{"compilerOptions":{"paths":{"wasm-alias":["./add.wasm"]}}}',
  );
  await writeFile(
    path.join(project, WASM_SOURCE),
    'import { DurableObject } from "cloudflare:workers"; import first from "./add.wasm"; import second from "./add.wasm?module"; import third from "wasm-fixture/module"; import fourth from "wasm-alias"; export class Counter extends DurableObject { fetch() { if (first !== second || first !== third || first !== fourth) throw new Error("wasm-not-deduplicated"); const instance = new WebAssembly.Instance(first); return new Response(String(instance.exports.add(1, 2))); } }',
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
  const objectFunction = parts.functions.durableObjects?.['COUNTERS'];
  assert.ok(objectFunction);
  assert.equal(objectFunction.modules.filter((module) => module.type === 'wasm').length, 1);
  const dependencies = parts.dependencies['durable-object/COUNTERS'];
  assert.ok(dependencies?.other.some((entry) => entry.file === WASM_FILE) === true);
  assert.deepEqual(dependencies.wasmModules, []);
  const wasmModule = objectFunction.modules.find((module) => module.type === 'wasm');
  assert.ok(wasmModule);
  assert.deepEqual(dependencies.compiledWasmModules, [
    { file: WASM_FILE, module: wasmModule.name },
    { file: 'wasm-fixture/add.wasm', module: wasmModule.name },
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
    assert.ok(resources.watchedFiles.includes(path.join(packageDirectory, WASM_FILE)));
  } finally {
    await resources.dispose();
  }
}
