import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { RESOURCES_SYMBOL_KEY, resourcesOf } from '@stayingupwind/core/paas';

import capability from '../../sdk/src/ai.ts';
import { ai, durableObject } from '../../sdk/src/named.ts';
import { parseDevRequest } from '../src/args.ts';
import { RESTART_EXIT_CODE } from '../src/dev/restart.ts';
import { aiBindingNames, localInferenceSource, prepareLocalAi } from '../src/resources/local-ai.ts';
import { startLocalResources } from '../src/resources/local.ts';

const symbol = Symbol.for(RESOURCES_SYMBOL_KEY);
const previous: unknown = Reflect.get(globalThis, symbol);
const MODEL = '@cf/new/model';
const AUDIO = 'encoded-audio';
const oldNames = process.env['UPWIND_AI_BINDINGS'];
const oldObjects = process.env['UPWIND_DURABLE_OBJECTS'];
const oldAccount = process.env['CLOUDFLARE_ACCOUNT_ID'];
const oldToken = process.env['CLOUDFLARE_API_TOKEN'];
const oldFetch = process.env['CLOUDFLARE_CF_FETCH_ENABLED'];
process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

async function checkAccessors(): Promise<void> {
  Reflect.deleteProperty(globalThis, symbol);
  assert.equal(ai('INFERENCE'), undefined);
  await assert.rejects(async () => capability.run(MODEL, {}), /no storage published/u);
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
  Reflect.set(
    globalThis,
    symbol,
    resourcesOf({
      ARKOR_RESOURCES: JSON.stringify([
        { name: 'INFERENCE', type: 'ai' },
        { name: 'STORE', type: 'kv_namespace' },
      ]),
      INFERENCE: raw,
      STORE: {},
    }),
  );
  assert.equal(ai('STORE'), undefined);
  const named = ai('INFERENCE');
  assert.ok(named);
  assert.deepEqual(Object.keys(named), ['run']);
  assert.equal(ai('INFERENCE'), named);
  assert.equal(await named.run(MODEL, {}), stream);
  assert.equal(await capability.run(MODEL, {}), stream);
  await assert.rejects(async () => {
    return await Reflect.apply(
      Reflect.get(named, 'run') as (...args: unknown[]) => unknown,
      named,
      [MODEL, {}, {}],
    );
  }, /only run/u);
  await assert.rejects(async () => {
    return await Reflect.apply(
      Reflect.get(capability, 'run') as (...args: unknown[]) => unknown,
      capability,
      [MODEL, {}, {}],
    );
  }, /only run/u);
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
  assert.equal(request.options.remoteAi, true);
  let calls = 0;
  process.env['UPWIND_AI_BINDINGS'] = '["INFERENCE"]';
  process.env['CLOUDFLARE_ACCOUNT_ID'] = 'fixture-account';
  process.env['CLOUDFLARE_API_TOKEN'] = 'fixture-token';
  const disabled = await prepareLocalAi([], false, () => {
    calls += 1;
    return Promise.reject(new Error('must never connect'));
  });
  assert.equal(calls, 0);
  assert.equal(disabled.entries[0]?.type, 'ai');
  await disabled.dispose();
  const failed = await prepareLocalAi([], true, () => {
    calls += 1;
    return Promise.reject(new Error('fixture authentication failure'));
  });
  assert.equal(calls, 1);
  assert.ok(failed.worker);
  await failed.dispose();
  let disposed = 0;
  await prepareLocalAi([], true, () => {
    return Promise.resolve({
      remoteProxyConnectionString: new URL('https://fixture.invalid') as never,
      ready: Promise.reject(new Error('fixture readiness failure')),
      dispose: () => {
        disposed += 1;
        return Promise.resolve();
      },
    });
  });
  assert.equal(disposed, 1);
}

async function checkInference(): Promise<void> {
  interface Provider {
    models: (params: { page: number; search: string }) => Promise<{ name: string }[]>;
    run: (model: string, inputs: unknown) => Promise<unknown>;
  }
  class Entrypoint {
    env: { UPWIND_INTERNAL_AI: Provider } | undefined;
  }
  // eslint-disable-next-line sonarjs/code-eval -- Only our generated worker source runs in this isolated context; no customer input or credentials enter it.
  const evaluated: unknown = runInNewContext(
    `${localInferenceSource(true).replace("import { WorkerEntrypoint } from 'cloudflare:workers';", '').replace('export default class', 'class')}\nInference;`,
    { WorkerEntrypoint: Entrypoint },
  );
  const Inference = evaluated as new () => {
    env: { UPWIND_INTERNAL_AI: Provider };
    run: (...args: unknown[]) => Promise<unknown>;
  };
  const worker = new Inference();
  const stream = new ReadableStream();
  const binary = new Uint8Array([1, 2]);
  let searches = 0;
  let calls = 0;
  worker.env = {
    UPWIND_INTERNAL_AI: {
      models: ({ page, search }) => {
        searches += 1;
        return Promise.resolve([{ name: page === 1 ? 'another-model' : search }]);
      },
      run: (_model, input) => {
        calls += 1;
        return Promise.resolve(input);
      },
    },
  };
  assert.equal(await worker.run(MODEL, stream), stream);
  assert.equal(await worker.run(MODEL, binary), binary);
  assert.equal(await worker.run(MODEL, AUDIO), AUDIO);
  assert.equal(searches, 2);
  await assert.rejects(async () => worker.run(MODEL, { lora: 'private' }), /private LoRA/u);
  await assert.rejects(async () => worker.run(MODEL, {}, {}), /only run/u);
  await assert.rejects(async () => worker.run('external-provider/model', {}), /public Workers AI/u);
  assert.equal(calls, [stream, binary, AUDIO].length);
}

function checkRestart(): void {
  const restart = new URL('../src/dev/restart.ts', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      String.raw`
    import { beforeRestart, restart } from ${JSON.stringify(restart)};
    beforeRestart(async () => { await new Promise(resolve => setTimeout(resolve, 15)); process.stdout.write('disposed\n'); });
    restart('fixture configuration');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, RESTART_EXIT_CODE);
  assert.match(child.stdout, /^disposed\nupwind: fixture configuration; restarting/u);
}

async function checkNativeRuntime(): Promise<void> {
  Reflect.deleteProperty(globalThis, symbol);
  const project = await mkdtemp(path.join(os.tmpdir(), 'upwind-ai-'));
  const adapter = path.join(project, 'node_modules', '@stayingupwind', 'adapter');
  await mkdir(path.dirname(adapter), { recursive: true });
  await symlink(path.resolve(import.meta.dirname, '../../adapter'), adapter, 'dir');
  await writeFile(
    path.join(project, 'probe.ts'),
    `import { DurableObject } from 'cloudflare:workers';
export class Probe extends DurableObject {
  async infer() {
    try { await this.env.INFERENCE.run(${JSON.stringify(MODEL)}, {}); return 'unexpected'; }
    catch (error) { return error.message; }
  }
  async gateway() {
    try { await this.env.INFERENCE.gateway('private'); return 'unexpected'; }
    catch { return 'blocked'; }
  }
}`,
  );
  process.env['UPWIND_DURABLE_OBJECTS'] = JSON.stringify([
    // eslint-disable-next-line unicorn/no-keyword-prefix -- Public Durable Object registration field.
    { name: 'PROBES', module: 'probe.ts', className: 'Probe' },
  ]);
  const local = await startLocalResources(project, { answersSignals: true, remoteAi: false });
  try {
    const binding = ai('INFERENCE');
    assert.ok(binding);
    await assert.rejects(async () => binding.run(MODEL, {}), /AI is disabled locally/u);
    const storage = Reflect.get(globalThis, symbol) as {
      resources: Record<string, { binding: unknown }>;
    };
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
  await checkInference();
  checkRestart();
  await checkNativeRuntime();
  console.log(
    'AI capability, types, opt-in, authentication isolation and native runtime checks passed',
  );
} finally {
  if (Object.getOwnPropertyDescriptor(globalThis, symbol)?.configurable !== false) {
    Reflect.set(globalThis, symbol, previous);
  }
  restore('UPWIND_AI_BINDINGS', oldNames);
  restore('UPWIND_DURABLE_OBJECTS', oldObjects);
  restore('CLOUDFLARE_ACCOUNT_ID', oldAccount);
  restore('CLOUDFLARE_API_TOKEN', oldToken);
  restore('CLOUDFLARE_CF_FETCH_ENABLED', oldFetch);
}
