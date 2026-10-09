import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DURABLE_OBJECT_BUNDLE_VERSION,
  DURABLE_OBJECT_SPLIT_BUNDLE_VERSION,
  durableObjectDeclarationsSchema,
  DURABLE_OBJECT_EXPORT,
} from '@stayingupwind/core/bundle';
import { RESOURCES_SYMBOL_KEY } from '@stayingupwind/core/paas';

import { BlobStore } from '../../adapter/src/blobs.ts';
import { bundleDurableObjects, durableObjectParts } from '../../adapter/src/durable-objects.ts';
import namespace from '../../sdk/src/durable-object.ts';
import { durableObject, kv } from '../../sdk/src/named.ts';
import { startLocalResources } from '../src/resources/local.ts';

/** Small native-runtime fixture; no Next.js build, credentials, or remote object invocation. */
const restoring = process.argv[2] !== undefined;
const restoringData = restoring && process.argv[3] !== 'first';
const project =
  process.argv[2] ?? (await mkdtemp(path.join(os.tmpdir(), 'upwind-durable-objects-')));
const root = path.resolve(import.meta.dirname, '../../..');
const MODULE = 'counter.ts';
const BROKEN_DEPENDENCY = 'broken-dependency.ts';
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
  await writeFile(
    path.join(project, 'unsupported.ts'),
    'import { runInNewContext } from "node:vm"; export class Counter { run() { return runInNewContext("1"); } }',
  );
  await assert.rejects(
    durableObjectParts({ ...input, declarations: [{ ...declaration, module: 'unsupported.ts' }] }),
    /node:vm/u,
  );
  const previous = process.env['UPWIND_DURABLE_OBJECTS'];
  try {
    process.env['UPWIND_DURABLE_OBJECTS'] = '{';
    await assert.rejects(
      durableObjectParts({ ...input, declarations: undefined }),
      /UPWIND_DURABLE_OBJECTS/u,
    );
  } finally {
    if (previous === undefined) delete process.env['UPWIND_DURABLE_OBJECTS'];
    else process.env['UPWIND_DURABLE_OBJECTS'] = previous;
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
    const response = await counters.getByName('first').fetch('https://fixture.invalid/');
    assert.deepEqual(await response.json(), {
      value: restoringData ? FIRST_RESTORED_FETCH_COUNT : 1,
    });
    assert.deepEqual(
      await (await namespace.getByName('first').fetch('https://fixture.invalid/')).json(),
      { value: restoringData ? SECOND_RESTORED_FETCH_COUNT : 2 },
    );
    const rpc = counters.getByName('first') as unknown as { increment: () => Promise<number> };
    assert.equal(await rpc.increment(), restoringData ? RESTORED_RPC_COUNT : FIRST_RUN_COUNT);
  } finally {
    await resources.dispose();
  }
  assert.ok(Object.hasOwn(globalThis, Symbol.for(RESOURCES_SYMBOL_KEY)));
}

async function checkPrototypeBinding(): Promise<void> {
  process.env['UPWIND_DURABLE_OBJECTS'] = JSON.stringify([{ ...declaration, name: '__proto__' }]);
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.equal(durableObject('__proto__'), undefined);
    assert.equal(await kv('UPWIND_KV')?.get('constructed'), 'yes');
  } finally {
    await resources.dispose();
  }
}

process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';
process.env['UPWIND_DURABLE_OBJECTS'] = JSON.stringify([declaration]);

if (process.argv[3] === 'broken') {
  await checkBrokenSource();
} else if (process.argv[3] === 'prototype') {
  await checkPrototypeBinding();
} else
  try {
    if (!restoring) {
      await writeFile(
        path.join(project, MODULE),
        await readFile(path.join(root, 'fixtures/durable-objects/counter.ts')),
      );
      await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
      const adapterModules = path.join(project, 'node_modules', '@stayingupwind', 'adapter');
      await mkdir(path.dirname(adapterModules), { recursive: true });
      await symlink(path.join(root, 'packages/adapter'), adapterModules, 'dir');

      const conditionalPackage = path.join(project, 'node_modules', 'upwind-condition-test');
      await mkdir(conditionalPackage, { recursive: true });
      await writeFile(
        path.join(conditionalPackage, 'package.json'),
        JSON.stringify({
          type: 'module',
          exports: { workerd: './worker.js', node: './node.js', default: './node.js' },
        }),
      );
      await writeFile(
        path.join(conditionalPackage, 'worker.js'),
        'export const condition = "workerd";',
      );
      await writeFile(
        path.join(conditionalPackage, 'node.js'),
        'throw new Error("node-branch-must-not-run"); export const condition = "node";',
      );
      const conditionalModule = 'conditional-counter.ts';
      await writeFile(
        path.join(project, conditionalModule),
        'import { condition } from "upwind-condition-test"; export { Counter } from "./counter.ts"; if (condition !== "workerd") throw new Error("unexpected-condition");',
      );
      const conditional = await bundleDurableObjects(project, [
        { ...declaration, module: conditionalModule },
      ]);
      assert.ok(
        conditional[0]?.inputs.includes(path.join(conditionalPackage, 'worker.js')) === true,
      );
      assert.ok(!conditional[0].source.includes('node-branch-must-not-run'));
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
    if (!restoring)
      await symlink(
        path.join(root, 'fixtures/durable-objects/counter.ts'),
        path.join(project, 'outside.ts'),
      );
    await assert.rejects(
      bundleDurableObjects(project, [{ ...declaration, module: 'outside.ts' }]),
      /inside the project/u,
    );
    // eslint-disable-next-line unicorn/no-keyword-prefix -- Exercises a missing public class export.
    await assert.rejects(bundleDurableObjects(project, [{ ...declaration, className: 'Missing' }]));

    process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';
    process.env['UPWIND_DURABLE_OBJECTS'] = JSON.stringify([declaration]);
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
