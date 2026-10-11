import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RESOURCES_SYMBOL_KEY, resourcesOf } from '@stayingupwind/core/paas';

import capability from '../../sdk/src/ai.ts';
import { ai, durableObject } from '../../sdk/src/named.ts';
import { parseDevRequest } from '../src/args.ts';
import { aiBindingNames, prepareLocalAi } from '../src/resources/local-ai.ts';
import { startLocalResources } from '../src/resources/local.ts';

const symbol = Symbol.for(RESOURCES_SYMBOL_KEY);
const globals = globalThis as unknown as Record<symbol, unknown>;
const previous = globals[symbol];
const oldNames = process.env['UPWIND_AI_BINDINGS'];
const oldObjects = process.env['UPWIND_DURABLE_OBJECTS'];
const oldAccount = process.env['CLOUDFLARE_ACCOUNT_ID'];
const oldToken = process.env['CLOUDFLARE_API_TOKEN'];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

async function checkAccessors(): Promise<void> {
  Reflect.deleteProperty(globals, symbol);
  assert.equal(ai('INFERENCE'), undefined);
  assert.throws(() => capability.run('@cf/new/model', {}), /no storage published/u);
  let calls = 0;
  const stream = new ReadableStream();
  const raw = {
    run: (...args: unknown[]) => {
      assert.equal(args.length, 2);
      calls += 1;
      return Promise.resolve(stream);
    },
    gateway: () => assert.fail('gateway was exposed'),
  };
  globals[symbol] = resourcesOf({
    ARKOR_RESOURCES: JSON.stringify([
      { name: 'INFERENCE', type: 'ai' },
      { name: 'STORE', type: 'kv_namespace' },
    ]),
    INFERENCE: raw,
    STORE: {},
  });
  assert.equal(ai('STORE'), undefined);
  const named = ai('INFERENCE');
  assert.ok(named);
  assert.deepEqual(Object.keys(named), ['run']);
  assert.equal(ai('INFERENCE'), named);
  assert.equal(await named.run('@cf/new/model', {}), stream);
  assert.equal(await capability.run('@cf/new/model', {}), stream);
  assert.throws(() => Reflect.apply(named.run, named, ['@cf/new/model', {}, {}]), /only run/u);
  assert.throws(
    () => Reflect.apply(capability.run, capability, ['@cf/new/model', {}, {}]),
    /only run/u,
  );
  assert.equal(calls, 2);
}

async function checkSetup(): Promise<void> {
  assert.deepEqual(aiBindingNames('["INFERENCE"]', []), ['INFERENCE']);
  assert.throws(() => aiBindingNames('["INFERENCE","INFERENCE"]', []), /duplicate/u);
  assert.throws(() => aiBindingNames('["COUNTERS"]', ['COUNTERS']), /duplicate/u);
  assert.throws(() => aiBindingNames('["arkor_PLATFORM"]', []), /invalid/u);
  assert.throws(() => aiBindingNames('{}', []), /JSON array/u);
  const request = parseDevRequest(['--remote-ai']);
  assert.equal(request.answer, undefined);
  if (request.answer === undefined) assert.equal(request.options.remoteAi, true);
  let calls = 0;
  process.env['UPWIND_AI_BINDINGS'] = '["INFERENCE"]';
  process.env['CLOUDFLARE_ACCOUNT_ID'] = 'fixture-account';
  process.env['CLOUDFLARE_API_TOKEN'] = 'fixture-token';
  const disabled = await prepareLocalAi([], false, async () => {
    calls += 1;
    throw new Error('must never connect');
  });
  assert.equal(calls, 0);
  assert.equal(disabled.entries[0]?.type, 'ai');
  await disabled.dispose();
  const failed = await prepareLocalAi([], true, async () => {
    calls += 1;
    throw new Error('fixture authentication failure');
  });
  assert.equal(calls, 1);
  assert.ok(failed.worker);
  await failed.dispose();
  let disposed = 0;
  await prepareLocalAi([], true, async () => ({
    remoteProxyConnectionString: new URL('http://fixture.invalid') as never,
    ready: Promise.reject(new Error('fixture readiness failure')),
    dispose: async () => {
      disposed += 1;
    },
  }));
  assert.equal(disposed, 1);
}

async function checkNativeRuntime(): Promise<void> {
  Reflect.deleteProperty(globals, symbol);
  const project = await mkdtemp(path.join(os.tmpdir(), 'upwind-ai-'));
  const adapter = path.join(project, 'node_modules', '@stayingupwind', 'adapter');
  await mkdir(path.dirname(adapter), { recursive: true });
  await symlink(path.resolve(import.meta.dirname, '../../adapter'), adapter, 'dir');
  await writeFile(
    path.join(project, 'probe.ts'),
    `import { DurableObject } from 'cloudflare:workers';
export class Probe extends DurableObject {
  async infer() {
    try { await this.env.INFERENCE.run('@cf/new/model', {}); return 'unexpected'; }
    catch (error) { return error.message; }
  }
  async gateway() {
    try { await this.env.INFERENCE.gateway('private'); return 'unexpected'; }
    catch { return 'blocked'; }
  }
}`,
  );
  process.env['UPWIND_DURABLE_OBJECTS'] = JSON.stringify([
    { name: 'PROBES', module: 'probe.ts', className: 'Probe' },
  ]);
  const local = await startLocalResources(project, { answersSignals: true, remoteAi: false });
  try {
    const binding = ai('INFERENCE');
    assert.ok(binding);
    await assert.rejects(async () => binding.run('@cf/new/model', {}), /AI is disabled locally/u);
    const storage = globals[symbol] as { resources: Record<string, { binding: unknown }> };
    assert.ok(storage.resources['UPWIND_D1']);
    assert.ok(storage.resources['UPWIND_KV']);
    assert.ok(storage.resources['UPWIND_R2']);
    const namespace = durableObject('PROBES');
    assert.ok(namespace);
    const probe = namespace.get(namespace.idFromName('fixture')) as unknown as {
      infer: () => Promise<string>;
      gateway: () => Promise<string>;
    };
    assert.match(await probe.infer(), /AI is disabled locally/u);
    assert.equal(await probe.gateway(), 'blocked');
  } finally {
    await local.dispose();
    await local.dispose();
    await rm(project, { recursive: true, force: true });
  }
}

try {
  await checkAccessors();
  await checkSetup();
  await checkNativeRuntime();
  console.log(
    'AI capability, types, opt-in, authentication isolation and native runtime checks passed',
  );
} finally {
  if (Object.getOwnPropertyDescriptor(globalThis, symbol)?.configurable !== false) {
    globals[symbol] = previous;
  }
  restore('UPWIND_AI_BINDINGS', oldNames);
  restore('UPWIND_DURABLE_OBJECTS', oldObjects);
  restore('CLOUDFLARE_ACCOUNT_ID', oldAccount);
  restore('CLOUDFLARE_API_TOKEN', oldToken);
}
