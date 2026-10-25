import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeploymentBundle, FunctionSpec } from '@stayingupwind/core/bundle';
import { MIDDLEWARE_DONE_HEADER, MIDDLEWARE_ONLY_HEADER } from '@stayingupwind/core/paas';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

import { workerApp, workerSpec } from './worker-function.ts';

const TOTAL_MS = 120_000;
const REQUEST_MS = 10_000;
const CLEANUP_MS = 5000;
const HTTP_OK = 200;
const HTTP_ERROR = 500;
const HOST_END = 'host:end';
const HOST_ERROR = 'host:error';
const HOST_LOAD_FAILURE = 'host-load-throws';
const HOST_REGISTER_FAILURE = 'host-register-throws';
const TYPES = {
  esm: 'ESModule',
  commonjs: 'CommonJS',
  text: 'Text',
  json: 'Text',
  data: 'Data',
  wasm: 'CompiledWasm',
} as const;

interface Snapshot {
  events: string[];
  hostErrors: number;
  ownErrors: number;
  hostReady: boolean;
  hostDynamicReady: boolean;
  ownReady: boolean;
  hostReceiver: boolean;
  ownReceiver: boolean;
  hostErrorReceiver: boolean;
  ownErrorReceiver: boolean;
  sameArguments: boolean;
  hostRuntime: string | null;
  hostTarget: string | null;
  ownRuntime: string | null;
  error: { message: string; path: string; method: string; routeType: string } | null;
}

interface CaseProof {
  function: string;
  selectedCase: string;
  hostInstrumentation: boolean;
  status: string;
  snapshots: Snapshot[];
  errorStatus?: number;
  egressAttempts: number;
}

/** Bound startup, response bodies and disposal, including promises without cancellation support. */
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const refused = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Instrumentation fixture aborted'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, refused]);
  } finally {
    if (abort !== undefined) signal.removeEventListener('abort', abort);
  }
}

/** Verify uploaded bytes before constructing the same module graph in workerd. */
async function modulesOf(inputSpec: FunctionSpec, out: string) {
  const spec = workerSpec(inputSpec);
  const modules = await Promise.all(
    spec.modules.map(async (module) => {
      const bytes = await readFile(path.join(out, 'blobs', module.blob.sha256));
      assert.equal(bytes.byteLength, module.blob.byteLength, `${module.name}: byte length`);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        module.blob.sha256,
        `${module.name}: SHA-256`,
      );
      return {
        type: TYPES[module.type],
        path: path.join('/bundle', module.name),
        contents:
          module.type === 'data' || module.type === 'wasm'
            ? new Uint8Array(bytes)
            : bytes.toString('utf8'),
      };
    }),
  );
  const main = path.join('/bundle', spec.mainModule);
  assert.ok(modules.some((module) => module.path === main && module.type === 'ESModule'));
  modules.sort((left, right) => Number(right.path === main) - Number(left.path === main));
  return modules;
}

function assertRegistered(value: Snapshot, own: boolean, proof: CaseProof) {
  const edge = proof.function !== 'app';
  const hostLoaded = proof.hostInstrumentation && proof.selectedCase !== HOST_LOAD_FAILURE;
  const hostReady = hostLoaded && proof.selectedCase !== HOST_REGISTER_FAILURE;
  const expected = [
    ...(hostLoaded ? ['host:start', ...(hostReady ? [HOST_END] : [])] : []),
    ...(own ? ['own:start', 'own:end'] : []),
  ];
  assert.deepEqual(value.events, expected, 'register order or once-only guarantee');
  assert.equal(value.hostReady, hostReady, 'host registration was not awaited');
  assert.equal(value.ownReady, own, 'project registration was not awaited');
  if (hostLoaded) {
    assert.equal(value.hostDynamicReady, true, 'awaited host dependency is absent');
    assert.equal(value.hostReceiver, true, 'host register receiver');
    assert.equal(value.hostTarget, edge ? 'edge-light' : 'node', 'host conditional export target');
    if (edge) assert.equal(value.hostRuntime, 'edge', 'host NEXT_RUNTIME');
  }
  if (own) {
    assert.equal(value.ownReceiver, true, 'project register receiver');
    assert.equal(value.ownRuntime, edge ? 'edge' : 'nodejs');
  }
}

interface ExerciseInput {
  bundle: DeploymentBundle;
  out: string;
  own: boolean;
  edgeHosts: boolean;
  signal: AbortSignal;
}

function basePath(kind: string): string {
  if (kind === 'middleware') return '/state';
  if (kind === 'app-edge') return '/api/edge-probe';
  return '/api/probe';
}

function fixtureClient(runtime: Miniflare, proof: CaseProof, signal: AbortSignal) {
  const base = basePath(proof.function);
  const headers = {
    [proof.function === 'middleware' ? MIDDLEWARE_ONLY_HEADER : MIDDLEWARE_DONE_HEADER]: '1',
  };
  const request = async (pathname: string) => {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);
    const response = await bounded(
      runtime.dispatchFetch(`https://instrumentation.test${pathname}`, {
        headers,
        signal: requestSignal,
      }),
      requestSignal,
    );
    return { status: response.status, body: await bounded(response.text(), requestSignal) };
  };
  const snapshot = async (): Promise<Snapshot> => {
    const response = await request(base);
    assert.equal(response.status, HTTP_OK, 'fixture handler did not become ready');
    const value = JSON.parse(response.body) as Snapshot;
    proof.snapshots.push(value);
    return value;
  };
  return { base, request, snapshot };
}

type FixtureClient = ReturnType<typeof fixtureClient>;

async function assertOwnFailure(client: FixtureClient, proof: CaseProof): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    const response = await client.request(client.base);
    assert.equal(response.status, HTTP_ERROR, 'project register failure was swallowed');
    if (proof.function === 'middleware')
      assert.ok(response.body.includes('fixture own register failure'));
  }
}

async function assertErrorHooks(
  client: FixtureClient,
  proof: CaseProof,
  own: boolean,
): Promise<void> {
  const middleware = proof.function === 'middleware';
  const errorPath = middleware ? '/throw?literal=%2B' : `${client.base}?throw=1&literal=%2B`;
  const response = await client.request(errorPath);
  proof.errorStatus = response.status;
  assert.equal(response.status, HTTP_ERROR, 'original handler failure was swallowed');
  if (middleware)
    assert.ok(response.body.includes('fixture middleware failure'), 'hook replaced original error');
  const value = await client.snapshot();
  if (proof.function === 'app-edge') {
    // Next 16.4.2's EdgeRouteModuleWrapper awaits handle() without dispatching onRequestError.
    // Preserve that upstream contract; middleware and Node routes below must compose both hooks.
    assert.equal(value.hostErrors, 0, 'Edge route added an upstream-absent host error dispatch');
    assert.equal(value.ownErrors, 0, 'Edge route changed the project error hook dispatch');
    assert.equal(value.error, null);
    assertRegistered(value, own, proof);
    return;
  }
  assert.equal(value.hostErrors, 1, 'host error hook did not run exactly once');
  assert.equal(value.hostErrorReceiver, true, 'host error hook receiver');
  const errorEvents = own ? [HOST_ERROR, 'own:error'] : [HOST_END, HOST_ERROR];
  assert.deepEqual(value.events.slice(-errorEvents.length), errorEvents);
  assert.equal(value.ownErrors, own ? 1 : 0, 'project error hook did not run exactly once');
  if (own) {
    assert.equal(value.sameArguments, true, 'composition changed original hook arguments');
    assert.equal(value.ownErrorReceiver, true, 'project error hook receiver');
  }
  assert.deepEqual(value.error, {
    message: middleware ? 'fixture middleware failure' : 'fixture route failure',
    path: errorPath,
    method: 'GET',
    routeType: middleware ? 'proxy' : 'route',
  });
}

async function assertCase(client: FixtureClient, proof: CaseProof, own: boolean): Promise<void> {
  if (proof.selectedCase === 'own-register-throws') return assertOwnFailure(client, proof);
  const initial = await Promise.all([client.snapshot(), client.snapshot()]);
  for (const value of initial) assertRegistered(value, own, proof);
  const warm = await client.snapshot();
  assertRegistered(warm, own, proof);
  assert.equal(warm.hostErrors, 0, 'successful handler reported an error');
  assert.equal(warm.ownErrors, 0, 'successful handler reported a project error');
  if (![HOST_LOAD_FAILURE, HOST_REGISTER_FAILURE].includes(proof.selectedCase)) {
    await assertErrorHooks(client, proof, own);
  }
}

/** Exercise actual compiler output, not a direct call to a generated hook or its sources. */
async function exercise(
  input: ExerciseInput,
  candidate: FunctionSpec,
  proof: CaseProof,
): Promise<void> {
  const spec = workerSpec(candidate);
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'instrumentation-fixture',
      modulesRoot: '/bundle',
      modules: await modulesOf(spec, input.out),
      compatibilityDate: spec.compatibilityDate,
      compatibilityFlags: spec.compatibilityFlags,
      bindings: {
        NODE_ENV: 'production',
        NEXT_DEPLOYMENT_ID: input.bundle.deploymentId,
        UPWIND_INSTRUMENTATION_CASE: proof.selectedCase,
      },
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      outboundService: () => {
        proof.egressAttempts += 1;
        throw new Error('Instrumentation fixture attempted outbound network');
      },
    }),
  );
  let primary: unknown;
  let failed = false;
  try {
    await bounded(runtime.ready, input.signal);
    await assertCase(fixtureClient(runtime, proof, input.signal), proof, input.own);
    assert.equal(proof.egressAttempts, 0);
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    try {
      await bounded(runtime.dispose(), AbortSignal.timeout(CLEANUP_MS));
      assert.equal(
        proof.egressAttempts,
        0,
        'background instrumentation attempted outbound network',
      );
    } catch (error) {
      if (failed) console.error('Instrumentation fixture cleanup also failed');
      else {
        failed = true;
        primary = error;
      }
    }
  }
  if (failed) throw primary;
}

async function exerciseAll(input: ExerciseInput, cases: CaseProof[]): Promise<void> {
  assert.ok(input.bundle.functions.middleware, 'Edge middleware Function is absent');
  const lanes = input.edgeHosts
    ? ([
        ['middleware', input.bundle.functions.middleware],
        ['app', workerApp(input.bundle)],
        ['app-edge', workerApp(input.bundle)],
      ] as const)
    : ([['app-edge', workerApp(input.bundle)]] as const);
  const selectedCases = input.edgeHosts
    ? [
        'normal',
        HOST_LOAD_FAILURE,
        HOST_REGISTER_FAILURE,
        'host-error-throws',
        ...(input.own ? ['own-register-throws', 'own-error-throws'] : []),
      ]
    : ['normal'];
  for (const [kind, spec] of lanes) {
    for (const selectedCase of selectedCases) {
      const one: CaseProof = {
        function: kind,
        selectedCase,
        hostInstrumentation: input.edgeHosts || kind === 'app',
        status: 'running',
        snapshots: [],
        egressAttempts: 0,
      };
      cases.push(one);
      try {
        await exercise(input, spec, one);
        one.status = 'success';
      } catch (error) {
        one.status = 'failed';
        throw error;
      }
    }
  }
}

/** Save completed and failed cases even when a later hook, response or cleanup fails. */
export async function instrumentationHolds(
  bundle: DeploymentBundle,
  _dependencies: unknown,
  out: string,
): Promise<string[]> {
  const name = path.basename(path.dirname(out));
  const own = name !== 'next-edge-instrumentation-no-own';
  const edgeHosts = name !== 'next-edge-instrumentation-baseline';
  const directory = process.env['UPWIND_MATRIX_PROOF_DIR'] ?? out;
  const file = path.join(directory, `${name}-${bundle.nextVersion}-instrumentation.json`);
  const proof = {
    status: 'running',
    nextVersion: bundle.nextVersion,
    ownInstrumentation: own,
    edgeHostInstrumentation: edgeHosts,
    edgeRouteErrorContract: 'Next 16.4.2 returns 500 without invoking onRequestError',
    sourceSha256: {} as Record<string, string>,
    cases: [] as CaseProof[],
    functions: bundle.functions,
  };
  const signal = AbortSignal.timeout(TOTAL_MS);
  let failure: unknown;
  try {
    const app = path.dirname(out);
    for (const sourceFile of [
      'next.config.mjs',
      'host-hook.js',
      'app/api/edge-probe/route.js',
      ...(own ? ['instrumentation.js'] : []),
    ]) {
      const source = await readFile(path.join(app, sourceFile));
      proof.sourceSha256[sourceFile] = createHash('sha256').update(source).digest('hex');
    }
    const manifestFile = path.join(app, '.next/server/middleware-manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      middleware: Record<string, unknown>;
    };
    assert.notEqual(manifest.middleware['/'], undefined, 'Next.js did not compile Edge middleware');
    await exerciseAll({ bundle, out, own, edgeHosts, signal }, proof.cases);
    proof.status = 'success';
  } catch (error) {
    proof.status = 'failed';
    failure = error;
  } finally {
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(file, `${JSON.stringify(proof, null, 2)}\n`);
    } catch (error) {
      if (failure === undefined) failure = error;
      else console.error('Instrumentation fixture proof could not be saved');
    }
  }
  return failure === undefined
    ? []
    : [failure instanceof Error ? failure.message : 'Unknown instrumentation fixture failure'];
}
