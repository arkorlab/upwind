import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  DURABLE_OBJECT_BUNDLE_VERSION,
  DURABLE_OBJECT_SPLIT_BUNDLE_VERSION,
  durableObjectDeclarationsSchema,
  DURABLE_OBJECT_EXPORT,
} from '@stayingupwind/core/bundle';
import { RESOURCES_SYMBOL_KEY, UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';

import { BlobStore } from '../../adapter/src/blobs.ts';
import { bundleDurableObjects, durableObjectParts } from '../../adapter/src/durable-objects.ts';
import namespace from '../../sdk/src/durable-object.ts';
import { durableObject, kv } from '../../sdk/src/named.ts';
import { startLocalResources } from '../src/resources/local.ts';
import { checkBuildResolution, checkPrefixOnlyImports } from './check-durable-object-builds.ts';

/** Small native-runtime fixture; no Next.js build, credentials, or remote object invocation. */
const restoring = process.argv[2] !== undefined;
const restoringData = restoring && process.argv[3] !== 'first';
const project =
  process.argv[2] ?? (await mkdtemp(path.join(os.tmpdir(), 'upwind-durable-objects-')));
const root = path.resolve(import.meta.dirname, '../../..');
const COUNTER_FIXTURE = path.join(root, 'fixtures/durable-objects/counter.ts');
const MODULE = 'counter.ts';
const BROKEN_DEPENDENCY = 'broken-dependency.ts';
const COMMONJS_MODULE = 'commonjs-counter.ts';
const RACE_DEPENDENCY = 'race-dependency.ts';
const PACKAGE_MANIFEST = 'package.json';
const FIXTURE_URL = 'https://fixture.invalid/';
const FIRST_RUN_COUNT = 3;
const FIRST_RESTORED_FETCH_COUNT = FIRST_RUN_COUNT + 1;
const SECOND_RESTORED_FETCH_COUNT = FIRST_RUN_COUNT + 2;
const RESTORED_RPC_COUNT = FIRST_RUN_COUNT * 2;
// eslint-disable-next-line unicorn/no-keyword-prefix -- Exercises the public registration field.
const declaration = { name: 'COUNTERS', module: MODULE, className: 'Counter' };

async function checkBuildMetadata(): Promise<void> {
  const outDir = path.join(project, '.arkor');
  const blobs = new BlobStore(outDir);
  await blobs.init();
  const input = { projectDir: project, outDir, blobs, declarations: [declaration], split: false };
  const parts = await durableObjectParts({ ...input, sourceMaps: 'project' });
  assert.equal(parts.bundle.v, DURABLE_OBJECT_BUNDLE_VERSION);
  assert.equal(parts.functions.durableObjects?.['COUNTERS']?.mainModule, 'durable-object.mjs');
  const dependencies = parts.dependencies['durable-object/COUNTERS'];
  assert.ok(dependencies);
  assert.ok(dependencies.other.some((entry) => entry.file === MODULE && entry.bytes > 0));
  assert.deepEqual(
    dependencies.other.map((entry) => entry.file),
    [MODULE],
  );
  assert.ok(dependencies.externals.includes('cloudflare:workers'));
  assert.equal(dependencies.modules[0]?.name, 'durable-object.mjs');
  const map = parts.sourceMaps[0];
  assert.ok(map);
  assert.equal(map.name, 'durable-object/COUNTERS/durable-object.mjs');
  const source = await readFile(path.join(outDir, 'blobs', map.blob.sha256), 'utf8');
  const parsed = JSON.parse(source) as { sources: string[]; sourcesContent?: unknown };
  assert.ok(parsed.sources.some((file) => file.endsWith(MODULE)));
  assert.equal(parsed.sourcesContent, undefined);
  const split = await durableObjectParts({ ...input, split: true });
  assert.equal(split.bundle.v, DURABLE_OBJECT_SPLIT_BUNDLE_VERSION);
  assert.deepEqual(split.sourceMaps, []);
  const commonjs = await durableObjectParts({
    ...input,
    declarations: [{ ...declaration, module: COMMONJS_MODULE }],
  });
  const commonjsDependencies = commonjs.dependencies['durable-object/COUNTERS'];
  assert.ok(commonjsDependencies);
  assert.ok(commonjsDependencies.externals.includes('node:path'));
  assert.ok(commonjsDependencies.packages['upwind-cjs-test']);
  assert.deepEqual(commonjsDependencies.dynamicRequires, []);
  await writeFile(
    path.join(project, 'unsupported.ts'),
    'import { runInNewContext } from "node:vm"; export class Counter { run() { return runInNewContext("1"); } }',
  );
  await assert.rejects(
    durableObjectParts({ ...input, declarations: [{ ...declaration, module: 'unsupported.ts' }] }),
    /node:vm/u,
  );
  await writeFile(
    path.join(project, 'dynamic.ts'),
    'export class Counter { load(specifier) { return import(specifier); } }',
  );
  await assert.rejects(
    durableObjectParts({ ...input, declarations: [{ ...declaration, module: 'dynamic.ts' }] }),
    /durable-object\/COUNTERS\/durable-object\.mjs:1/u,
  );
  await writeFile(
    path.join(project, 'native-imports.ts'),
    'import { httpServerHandler } from "cloudflare:node"; import { NonRetryableError } from "cloudflare:workflows"; export { Counter } from "./counter.ts"; if (typeof httpServerHandler !== "function") throw new NonRetryableError("missing-native-api");',
  );
  const native = await durableObjectParts({
    ...input,
    declarations: [{ ...declaration, module: 'native-imports.ts' }],
  });
  assert.ok(
    native.dependencies['durable-object/COUNTERS']?.externals.includes('cloudflare:node') === true,
  );
  assert.ok(
    native.dependencies['durable-object/COUNTERS'].externals.includes('cloudflare:workflows'),
  );
  const previous = process.env[UPWIND_DURABLE_OBJECTS_ENV];
  try {
    process.env[UPWIND_DURABLE_OBJECTS_ENV] = '{';
    await assert.rejects(
      durableObjectParts({ ...input, declarations: undefined }),
      /UPWIND_DURABLE_OBJECTS/u,
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, UPWIND_DURABLE_OBJECTS_ENV);
    else process.env[UPWIND_DURABLE_OBJECTS_ENV] = previous;
  }
}

async function checkBrokenSource(): Promise<void> {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  try {
    const resources = await startLocalResources(project, { answersSignals: true });
    try {
      assert.ok(resources.watchedFiles?.includes(path.join(project, MODULE)) === true);
      assert.ok(resources.watchedFiles.includes(path.join(project, BROKEN_DEPENDENCY)));
      assert.equal(durableObject('COUNTERS'), undefined);
      assert.equal(await kv('UPWIND_KV')?.get('constructed'), 'yes');
      assert.ok(warnings.some((warning) => warning.includes(BROKEN_DEPENDENCY)));
    } finally {
      await resources.dispose();
    }
  } finally {
    console.warn = warn;
  }
}

async function checkNativeResources(): Promise<void> {
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.ok(resources.watchedFiles?.includes(path.join(project, MODULE)) === true);
    assert.equal(resources.sourcesChanged?.(), false);
    const watchedSource = await readFile(path.join(project, MODULE), 'utf8');
    try {
      await writeFile(
        path.join(project, MODULE),
        `${watchedSource}\n// edit before watches attach\n`,
      );
      assert.equal(resources.sourcesChanged(), true);
    } finally {
      await writeFile(path.join(project, MODULE), watchedSource);
    }
    assert.equal(durableObject('UPWIND_D1'), undefined);
    assert.equal(durableObject('MISSING'), undefined);
    assert.equal(await kv('UPWIND_KV')?.get('constructed'), restoringData ? 'yes' : null);
    const counters = durableObject('COUNTERS');
    assert.ok(counters);
    // A namespace is published without constructing any instance.
    const response = await counters.getByName('first').fetch(FIXTURE_URL);
    assert.deepEqual(await response.json(), {
      value: restoringData ? FIRST_RESTORED_FETCH_COUNT : 1,
    });
    assert.deepEqual(await (await namespace.getByName('first').fetch(FIXTURE_URL)).json(), {
      value: restoringData ? SECOND_RESTORED_FETCH_COUNT : 2,
    });
    const rpc = counters.getByName('first') as unknown as { increment: () => Promise<number> };
    assert.equal(await rpc.increment(), restoringData ? RESTORED_RPC_COUNT : FIRST_RUN_COUNT);
  } finally {
    await resources.dispose();
  }
  assert.ok(Object.hasOwn(globalThis, Symbol.for(RESOURCES_SYMBOL_KEY)));
}

async function checkPrototypeBinding(): Promise<void> {
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([{ ...declaration, name: '__proto__' }]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.equal(durableObject('__proto__'), undefined);
    assert.equal(await kv('UPWIND_KV')?.get('constructed'), 'yes');
  } finally {
    await resources.dispose();
  }
}

async function checkCommonJSBinding(): Promise<void> {
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([
    { ...declaration, module: COMMONJS_MODULE },
  ]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    const counters = durableObject('COUNTERS');
    assert.ok(counters);
    const response = await counters.getByName('commonjs').fetch(FIXTURE_URL);
    assert.equal(await response.text(), 'fixture:development');
  } finally {
    await resources.dispose();
  }
}

async function checkStartupEdit(): Promise<void> {
  const raceProject = path.join(project, 'race');
  const adapter = path.join(raceProject, 'node_modules', '@stayingupwind', 'adapter');
  await mkdir(adapter, { recursive: true });
  await writeFile(path.join(raceProject, PACKAGE_MANIFEST), '{"type":"module"}');
  await writeFile(path.join(adapter, PACKAGE_MANIFEST), '{"type":"module","exports":"./index.js"}');
  await writeFile(path.join(raceProject, RACE_DEPENDENCY), 'export const revision = "before";');
  await writeFile(
    path.join(raceProject, MODULE),
    `import { revision } from "./race-dependency.ts"; if (revision !== "before") throw new Error("unexpected-revision");\n${await readFile(COUNTER_FIXTURE, 'utf8')}`,
  );
  const bundler = pathToFileURL(path.join(root, 'packages/adapter/src/durable-objects.ts')).href;
  await writeFile(
    path.join(adapter, 'index.js'),
    String.raw`import { appendFile } from "node:fs/promises"; import path from "node:path"; import { bundleDurableObjects as bundle } from ${JSON.stringify(bundler)}; export async function bundleDurableObjects(directory, declarations, options) { const built = await bundle(directory, declarations, options); await appendFile(path.join(directory, "race-dependency.ts"), "\n// saved during startup\n"); return built; }`,
  );
  const resources = await startLocalResources(raceProject, { answersSignals: true });
  try {
    assert.ok(durableObject('COUNTERS'));
    assert.ok(resources.watchedFiles?.includes(path.join(raceProject, RACE_DEPENDENCY)) === true);
    assert.equal(resources.sourcesChanged?.(), true);
  } finally {
    await resources.dispose();
  }
}

async function checkDependencyEdit(): Promise<void> {
  process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([
    { ...declaration, module: COMMONJS_MODULE },
  ]);
  const resources = await startLocalResources(project, { answersSignals: true });
  const lockfile = path.join(project, 'pnpm-lock.yaml');
  const manifest = path.join(project, 'node_modules', 'upwind-cjs-test', PACKAGE_MANIFEST);
  const originalManifest = await readFile(manifest, 'utf8');
  try {
    assert.ok(resources.watchedFiles?.includes(path.join(project, PACKAGE_MANIFEST)) === true);
    assert.ok(resources.watchedFiles.includes(lockfile));
    assert.equal(resources.sourcesChanged?.(), false);
    await writeFile(lockfile, 'lockfileVersion: 9.0\n');
    assert.equal(resources.sourcesChanged(), true);
    await rm(lockfile);
    assert.equal(resources.sourcesChanged(), false);
    assert.ok(resources.watchedFiles.includes(manifest));
    await writeFile(manifest, `${originalManifest}\n`);
    assert.equal(resources.sourcesChanged(), true);
  } finally {
    await rm(lockfile, { force: true });
    await writeFile(manifest, originalManifest);
    await resources.dispose();
  }
}

process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';
process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([declaration]);

async function checkProject(): Promise<void> {
  try {
    if (!restoring) {
      await writeFile(path.join(project, MODULE), await readFile(COUNTER_FIXTURE));
      await writeFile(path.join(project, PACKAGE_MANIFEST), '{"type":"module"}');
      const commonjsPackage = path.join(project, 'node_modules', 'upwind-cjs-test');
      await mkdir(commonjsPackage, { recursive: true });
      await writeFile(path.join(commonjsPackage, PACKAGE_MANIFEST), '{"main":"index.cjs"}');
      await writeFile(
        path.join(commonjsPackage, 'index.cjs'),
        'exports.fixtureValue = () => require("./value.cjs")();',
      );
      await writeFile(
        path.join(commonjsPackage, 'value.cjs'),
        'module.exports = () => require("node:path").basename("/fixture");',
      );
      await writeFile(
        path.join(project, COMMONJS_MODULE),
        'import { DurableObject } from "cloudflare:workers"; import { fixtureValue } from "upwind-cjs-test"; export class Counter extends DurableObject { fetch() { return new Response(fixtureValue() + ":" + process.env.NODE_ENV); } }',
      );
      const adapterModules = path.join(project, 'node_modules', '@stayingupwind', 'adapter');
      await mkdir(path.dirname(adapterModules), { recursive: true });
      await symlink(path.join(root, 'packages/adapter'), adapterModules, 'dir');

      await checkBuildResolution(project, declaration);
      await checkPrefixOnlyImports(project, declaration);
    }

    const built = await bundleDurableObjects(project, [declaration]);
    assert.ok(built[0]?.source.includes(DURABLE_OBJECT_EXPORT) === true);
    assert.ok(built[0].inputs.includes(path.join(project, MODULE)));
    await checkBuildMetadata();
    assert.ok(
      !durableObjectDeclarationsSchema.safeParse([{ ...declaration, module: '../counter.ts' }])
        .success,
    );
    assert.ok(!durableObjectDeclarationsSchema.safeParse([declaration, declaration]).success);
    assert.ok(
      !durableObjectDeclarationsSchema.safeParse([{ ...declaration, name: 'ARKOR_RESOURCES' }])
        .success,
    );
    assert.ok(
      !durableObjectDeclarationsSchema.safeParse([{ ...declaration, name: '__proto__' }]).success,
    );
    assert.ok(
      // eslint-disable-next-line unicorn/no-keyword-prefix -- Requires a named public class export.
      !durableObjectDeclarationsSchema.safeParse([{ ...declaration, className: 'default' }])
        .success,
    );
    await assert.rejects(
      bundleDurableObjects(project, [{ ...declaration, module: 'missing.ts' }]),
      (error: unknown) => {
        return (
          error instanceof Error &&
          error.message.includes('COUNTERS:') &&
          error.message.includes('missing.ts')
        );
      },
    );
    if (!restoring) await symlink(COUNTER_FIXTURE, path.join(project, 'outside.ts'));
    await assert.rejects(
      bundleDurableObjects(project, [{ ...declaration, module: 'outside.ts' }]),
      /inside the project/u,
    );
    // eslint-disable-next-line unicorn/no-keyword-prefix -- Exercises a missing public class export.
    await assert.rejects(bundleDurableObjects(project, [{ ...declaration, className: 'Missing' }]));

    process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';
    process.env[UPWIND_DURABLE_OBJECTS_ENV] = JSON.stringify([declaration]);
    if (restoring) {
      await checkNativeResources();
    } else {
      // Separate processes leave no live storage claim between native persistence checks.
      await promisify(execFile)(process.execPath, [import.meta.filename, project, 'first'], {
        timeout: 30_000,
      });
      await promisify(execFile)(process.execPath, [import.meta.filename, project, 'prototype'], {
        timeout: 30_000,
      });
      await promisify(execFile)(process.execPath, [import.meta.filename, project, 'commonjs'], {
        timeout: 30_000,
      });
      await promisify(execFile)(process.execPath, [import.meta.filename, project, 'race'], {
        timeout: 30_000,
      });
      await promisify(execFile)(process.execPath, [import.meta.filename, project, 'dependency'], {
        timeout: 30_000,
      });
    }
    if (!restoring) {
      const originalSource = await readFile(path.join(project, MODULE), 'utf8');
      try {
        await writeFile(
          path.join(project, MODULE),
          'export { Counter } from "./broken-dependency.ts";',
        );
        await writeFile(path.join(project, BROKEN_DEPENDENCY), 'export class Counter { broken( }');
        await promisify(execFile)(process.execPath, [import.meta.filename, project, 'broken'], {
          timeout: 30_000,
        });
      } finally {
        await writeFile(path.join(project, MODULE), originalSource);
      }
    }
    if (!restoring)
      await promisify(execFile)(process.execPath, [import.meta.filename, project], {
        timeout: 30_000,
      });
    console.log(
      'Durable Object source validation, native namespace publication, SQLite persistence, RPC and SDK access passed',
    );
  } finally {
    if (!restoring) await rm(project, { recursive: true, force: true });
  }
}

const sideCheck = new Map([
  ['broken', checkBrokenSource],
  ['commonjs', checkCommonJSBinding],
  ['dependency', checkDependencyEdit],
  ['prototype', checkPrototypeBinding],
  ['race', checkStartupEdit],
]).get(process.argv[3] ?? '');
await (sideCheck ?? checkProject)();
