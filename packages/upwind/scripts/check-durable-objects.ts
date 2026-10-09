import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { durableObjectDeclarationsSchema, DURABLE_OBJECT_EXPORT } from '@stayingupwind/core/bundle';
import { RESOURCES_SYMBOL_KEY } from '@stayingupwind/core/paas';

import { bundleDurableObjects } from '../../adapter/src/durable-objects.ts';
import namespace from '../../sdk/src/durable-object.ts';
import { durableObject, kv } from '../../sdk/src/named.ts';
import { startLocalResources } from '../src/resources/local.ts';

/** Small native-runtime fixture; no Next.js build, credentials, or remote object invocation. */
const restoring = process.argv[2] !== undefined;
const project =
  process.argv[2] ?? (await mkdtemp(path.join(os.tmpdir(), 'upwind-durable-objects-')));
const root = path.resolve(import.meta.dirname, '../../..');
const MODULE = 'counter.ts';
const FIRST_RUN_COUNT = 3;
const FIRST_RESTORED_FETCH_COUNT = FIRST_RUN_COUNT + 1;
const SECOND_RESTORED_FETCH_COUNT = FIRST_RUN_COUNT + 2;
const RESTORED_RPC_COUNT = FIRST_RUN_COUNT * 2;
// eslint-disable-next-line unicorn/no-keyword-prefix -- Exercises the public registration field.
const declaration = { name: 'COUNTERS', module: MODULE, className: 'Counter' };
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
  }

  const built = await bundleDurableObjects(project, [declaration]);
  assert.ok(built[0]?.source.includes(DURABLE_OBJECT_EXPORT) === true);
  assert.ok(built[0].inputs.includes(path.join(project, MODULE)));
  assert.ok(
    !durableObjectDeclarationsSchema.safeParse([{ ...declaration, module: '../counter.ts' }])
      .success,
  );
  assert.ok(!durableObjectDeclarationsSchema.safeParse([declaration, declaration]).success);
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
  const resources = await startLocalResources(project, { answersSignals: true });
  try {
    assert.ok(resources.watchedFiles?.includes(path.join(project, MODULE)) === true);
    assert.equal(durableObject('UPWIND_D1'), undefined);
    assert.equal(durableObject('MISSING'), undefined);
    assert.equal(await kv('UPWIND_KV')?.get('constructed'), restoring ? 'yes' : null);
    const counters = durableObject('COUNTERS');
    assert.ok(counters);
    // A namespace is published without constructing any instance.
    const response = await counters.getByName('first').fetch('https://fixture.invalid/');
    assert.deepEqual(await response.json(), { value: restoring ? FIRST_RESTORED_FETCH_COUNT : 1 });
    assert.deepEqual(
      await (await namespace.getByName('first').fetch('https://fixture.invalid/')).json(),
      { value: restoring ? SECOND_RESTORED_FETCH_COUNT : 2 },
    );
    const rpc = counters.getByName('first') as unknown as { increment: () => Promise<number> };
    assert.equal(await rpc.increment(), restoring ? RESTORED_RPC_COUNT : FIRST_RUN_COUNT);
  } finally {
    await resources.dispose();
  }
  assert.ok(Object.hasOwn(globalThis, Symbol.for(RESOURCES_SYMBOL_KEY)));
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
