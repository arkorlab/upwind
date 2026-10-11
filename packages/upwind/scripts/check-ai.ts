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
import { bridgeNextRestartSource } from '../src/dev/next-restart-loader.ts';
import { RESTART_EXIT_CODE } from '../src/dev/restart.ts';
import { closeDevResources } from '../src/dev/shutdown.ts';
import {
  aiBindingNames,
  connectRemoteAi,
  localInferenceSource,
  prepareLocalAi,
} from '../src/resources/local-ai.ts';
import { startLocalResources } from '../src/resources/local.ts';
import { disposeLocalResources } from '../src/resources/shutdown.ts';

const symbol = Symbol.for(RESOURCES_SYMBOL_KEY);
const previous: unknown = Reflect.get(globalThis, symbol);
const MODEL = '@cf/new/model';
const AUDIO = 'encoded-audio';
const INVALID_NUMERIC_INPUT = 27;
const MAX_CACHED_MODELS = 256;
const EXCESS_MODEL_NAMES = 300;
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
  let cancelled = false;
  const stream = new ReadableStream({
    cancel: () => {
      cancelled = true;
    },
  });
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
  await assert.rejects(async () => {
    return await Reflect.apply(
      Reflect.get(named, 'run') as (...args: unknown[]) => Promise<unknown>,
      named,
      [MODEL, { lora: 'private' }],
    );
  }, /private LoRA/u);
  assert.equal(calls, 2);
  await stream.cancel();
  assert.equal(cancelled, true);
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
  const proxyUrl = 'https://fixture.invalid';
  const accountId = 'fixture-account';
  const apiToken = 'fixture-token';
  const connection = await connectRemoteAi({ accountId, apiToken }, async (bindings, options) => {
    assert.deepEqual(bindings, { UPWIND_INTERNAL_AI: { type: 'ai', remote: true } });
    assert.deepEqual(await options.auth(), { accountId, apiToken: { apiToken } });
    return {
      remoteProxyConnectionString: new URL(proxyUrl) as never,
      ready: Promise.resolve(),
      dispose: () => Promise.resolve(),
    };
  });
  await connection.dispose();
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
      remoteProxyConnectionString: new URL(proxyUrl) as never,
      ready: Promise.reject(new Error('fixture readiness failure')),
      dispose: () => {
        disposed += 1;
        return Promise.resolve();
      },
    });
  });
  assert.equal(disposed, 1);
  const controller = new AbortController();
  const connected = Promise.withResolvers<undefined>();
  const cancelled = prepareLocalAi(
    [],
    true,
    () => {
      connected.resolve(undefined);
      return Promise.resolve({
        remoteProxyConnectionString: new URL(proxyUrl) as never,
        ready: Promise.withResolvers<undefined>().promise,
        dispose: () => {
          disposed += 1;
          return Promise.resolve();
        },
      });
    },
    controller.signal,
  );
  await connected.promise;
  controller.abort();
  await assert.rejects(async () => cancelled, /cancelled/u);
  assert.equal(
    disposed,
    2,
    'cancellation awaits a returned session disposer while readiness is pending',
  );
}

async function checkConcurrentShutdown(): Promise<void> {
  const localStopped = Promise.withResolvers<undefined>();
  let remoteStarted = false;
  const closing = disposeLocalResources(() => localStopped.promise, {
    dispose: () => {
      remoteStarted = true;
      return Promise.resolve();
    },
  });
  assert.equal(remoteStarted, true, 'remote cleanup starts even while local shutdown is pending');
  localStopped.resolve(undefined);
  await closing;

  const remoteFailure = new Error('remote fixture failure');
  const storageFailure = new Error('storage fixture failure');
  await assert.rejects(
    disposeLocalResources(() => Promise.reject(storageFailure), {
      dispose: () => Promise.reject(remoteFailure),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [remoteFailure, storageFailure]);
      return true;
    },
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  let appClosed = false;
  console.warn = (message: string): void => {
    warnings.push(message);
  };
  try {
    await closeDevResources(
      () => Promise.reject(remoteFailure),
      () => {
        appClosed = true;
        return Promise.resolve();
      },
    );
    assert.equal(appClosed, true, 'remote cleanup rejection does not skip Next.js close');
    assert.deepEqual(warnings, ['upwind: failed to close local resources']);
  } finally {
    console.warn = originalWarn;
  }
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
    `${localInferenceSource(true).replace("import { WorkerEntrypoint } from 'cloudflare:workers';", '').replace('export default class', 'class')}\n({ Inference, modelCache: models });`,
    { WorkerEntrypoint: Entrypoint },
  );
  const { Inference, modelCache } = evaluated as {
    Inference: new () => {
      env: { UPWIND_INTERNAL_AI: Provider };
      run: (...args: unknown[]) => Promise<unknown>;
    };
    modelCache: Map<string, Promise<boolean>>;
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
  const alias = '@cf/moonshotai/kimi-k2.5';
  worker.env.UPWIND_INTERNAL_AI.models = ({ search }) => {
    assert.equal(search, '@cf/moonshotai/kimi-k2.6');
    return Promise.resolve([{ name: search }]);
  };
  worker.env.UPWIND_INTERNAL_AI.run = (model, inputs) => {
    assert.equal(model, alias, 'the provider receives its documented alias');
    return Promise.resolve(inputs);
  };
  assert.equal(await worker.run(alias, AUDIO), AUDIO);
  for (const invalid of [null, undefined, false, INVALID_NUMERIC_INPUT, []]) {
    await assert.rejects(async () => worker.run(MODEL, invalid), /inputs must be/u);
  }
  worker.env.UPWIND_INTERNAL_AI.models = () => Promise.resolve([]);
  for (let index = 0; index < EXCESS_MODEL_NAMES; index += 1) {
    await assert.rejects(
      async () => worker.run(`@cf/missing/${String(index)}`, {}),
      /Unknown public/u,
    );
  }
  assert.ok(
    modelCache.size <= MAX_CACHED_MODELS,
    'unsupported model names cannot grow the cache indefinitely',
  );
}

function checkRestart(): void {
  const restart = new URL('../src/dev/restart.ts', import.meta.url).href;
  const fixture = (request: string, cleanup: string) => {
    return spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { beforeRestart, restart, stopDuringStartup } from ${JSON.stringify(restart)};
      beforeRestart(${cleanup});
      ${request}
    `,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
  };
  const cleanup = String.raw`async () => { await new Promise(resolve => setTimeout(resolve, 15)); process.stdout.write('disposed\n'); }`;
  const child = fixture("restart('fixture configuration');", cleanup);
  assert.equal(child.status, RESTART_EXIT_CODE);
  assert.match(child.stdout, /^disposed\nupwind: fixture configuration; restarting/u);
  const nextSource = bridgeNextRestartSource(
    'const RESTART_EXIT_CODE = 77; setTimeout(() => { process.exit(RESTART_EXIT_CODE); }, 0);',
  );
  const next = fixture(
    `import { runInThisContext } from 'node:vm'; runInThisContext(${JSON.stringify(nextSource)});`,
    cleanup,
  );
  assert.equal(next.status, RESTART_EXIT_CODE);
  assert.match(next.stdout, /^disposed\nupwind: Next.js requested a restart/u);
  const native = fixture('process.exit(77);', cleanup);
  assert.equal(native.status, RESTART_EXIT_CODE);
  assert.equal(native.stdout, '', 'unrelated process.exit calls preserve their native contract');
  const interrupted = fixture('stopDuringStartup();', cleanup);
  assert.equal(interrupted.status, 0);
  assert.equal(interrupted.stdout, 'disposed\n');
  const hung = fixture("restart('hanging fixture');", '() => new Promise(() => {})');
  assert.equal(hung.status, RESTART_EXIT_CODE);
  assert.match(hung.stderr, /could not finish resource cleanup/u);
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
  await checkConcurrentShutdown();
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
