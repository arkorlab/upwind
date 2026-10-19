import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeploymentBundle, FunctionSpec } from '@stayingupwind/core/bundle';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

const REQUEST_MS = 30_000;
const CLEANUP_MS = 5000;
const TOTAL_MS = 120_000;
const HTTP_OK = 200;
const MAX_BODY_BYTES = 1_048_576;
const SAFE_TOKEN = /^[\w.-]{1,64}$/u;
const PROBE_MODULE = 'twoslash-import-probe.mjs';
const PROBE_STAGES = new Set([
  'entry-table-import',
  'linked-import',
  'route-import',
  'route-ready',
  'runtime-import',
]);
const PROBE_OUTCOMES = new Set(['failed', 'success', 'unsupported']);
const TWOSLASH_MODULE = /^twoslash-[0-9a-f]{16}(?:\/.*)?$/u;
const TYPES = {
  esm: 'ESModule',
  commonjs: 'CommonJS',
  text: 'Text',
  json: 'Text',
  data: 'Data',
  wasm: 'CompiledWasm',
} as const;

const EXPECTED = {
  code: "type X = Promise<number>;\n'hello'.toUpperCase()",
  nodes: [
    {
      character: 5,
      length: 1,
      line: 0,
      start: 5,
      target: 'X',
      text: 'type X = Promise<number>',
      type: 'hover',
    },
    {
      character: 9,
      docs: 'Represents the completion of an asynchronous operation',
      length: 7,
      line: 0,
      start: 9,
      target: 'Promise',
      text: 'interface Promise<T>',
      type: 'hover',
    },
    {
      character: 8,
      docs: 'Converts all the alphabetic characters in a string to uppercase.',
      length: 11,
      line: 1,
      start: 34,
      target: 'toUpperCase',
      text: '(method) String.toUpperCase(): string',
      type: 'hover',
    },
  ],
  error: undefined,
};

interface Failure {
  name: string;
  code: string | null;
}

interface ImportProbe {
  stage: string;
  outcome: string;
  error?: Failure;
  undefinedPathArgument?: boolean;
}

interface LinkedModuleEvidence {
  kind: 'twoslash-entry' | 'shared-linked';
  sha256: string;
  byteLength: number;
  importMetaUrl: number;
  createRequire: number;
  createRequireFromImportMeta: number;
}

interface Proof {
  status: 'running' | 'passed' | 'failed';
  sdk: { head: string | null; baseline: string | null };
  nextVersion: string;
  packageVersions: Record<string, string | null>;
  sourceSha256: Record<string, string>;
  declarationNamedModules: number;
  tracedDeclarations: number | null;
  modulesVerified: number;
  linkedModules: LinkedModuleEvidence[];
  egressAttempts: number;
  normalStage:
    | 'preparation'
    | 'runtime-start'
    | 'request'
    | 'response-read'
    | 'annotations'
    | 'complete';
  response?: {
    status: number;
    bytes: number | null;
    stage: string | null;
    errorCategory: string | null;
    errorName: string | null;
    errorCode: string | null;
    annotationsMatch: boolean;
  };
  importProbe?: ImportProbe;
  linkedImportProbe?: ImportProbe;
  probeFailure?: Failure;
  linkedProbeFailure?: Failure;
  failure?: Failure;
}

function tokenOf(value: unknown): string | null {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : null;
}

/** Store only bounded error identities, never messages, stacks, filenames or source. */
function failureOf(error: unknown): Failure {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  return {
    name: tokenOf(name) ?? 'unknown',
    code: tokenOf(code),
  };
}

/** The native runtime can fail to start or dispose without honoring a request's signal. */
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const refused = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Twoslash fixture aborted'),
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

/** The exact bytes and module names the adapter wrote, without rebundling its output. */
async function modulesOf(spec: FunctionSpec, out: string, proof: Proof) {
  const modules = await Promise.all(
    spec.modules.map(async (module) => {
      const bytes = await readFile(path.join(out, 'blobs', module.blob.sha256));
      assert.equal(bytes.byteLength, module.blob.byteLength, 'Function module byte length');
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        module.blob.sha256,
        'Function module SHA-256',
      );
      proof.modulesVerified += 1;
      const kind = TWOSLASH_MODULE.test(module.name)
        ? 'twoslash-entry'
        : module.name.startsWith('__linked/')
          ? 'shared-linked'
          : undefined;
      if (kind !== undefined) {
        const source = bytes.toString('utf8');
        proof.linkedModules.push({
          kind,
          sha256: module.blob.sha256,
          byteLength: module.blob.byteLength,
          importMetaUrl: source.match(/import\.meta\.url/gu)?.length ?? 0,
          createRequire: source.match(/\bcreateRequire\b/gu)?.length ?? 0,
          createRequireFromImportMeta:
            source.match(/\bcreateRequire\(\s*import\.meta\.url\s*\)/gu)?.length ?? 0,
        });
      }
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

type Modules = Awaited<ReturnType<typeof modulesOf>>;
type LocalResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>;

/** A separate isolate probes lazy imports only after the unmodified Function was exercised. */
function importProbeSource(rootId: string): string {
  return String.raw`export default {
    async fetch() {
      let stage = 'runtime-import';
      try {
        await import('./index.mjs');
        stage = 'entry-table-import';
        const app = await import('./app.cjs');
        const load = app.default?.entries?.[${JSON.stringify(rootId)}];
        if (typeof load !== 'function') return Response.json({ stage, outcome: 'unsupported' });
        stage = 'route-import';
        await load();
        return Response.json({ stage: 'route-ready', outcome: 'success' });
      } catch (error) {
        const token = (value) => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : null;
        return Response.json({ stage, outcome: 'failed', error: { name: token(error?.name), code: token(error?.code) } });
      }
    }
  };`;
}

/** Import only the emitted linked package in a fresh isolate, without the application runtime. */
function linkedImportProbeSource(moduleName: string): string {
  return String.raw`export default {
    async fetch() {
      try {
        await import(${JSON.stringify(`./${moduleName}`)});
        return Response.json({ stage: 'linked-import', outcome: 'success' });
      } catch (error) {
        const token = (value) => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : null;
        const undefinedPathArgument = error?.code === 'ERR_INVALID_ARG_VALUE'
          && typeof error.message === 'string'
          && error.message.includes("The argument 'path'")
          && error.message.includes("Received 'undefined'");
        return Response.json({ stage: 'linked-import', outcome: 'failed', undefinedPathArgument, error: { name: token(error?.name), code: token(error?.code) } });
      }
    }
  };`;
}

function runtimeOf(
  bundle: DeploymentBundle,
  modules: Modules,
  proof: Proof,
  probeSource?: string,
): Miniflare {
  const probe =
    probeSource === undefined
      ? []
      : [
          {
            type: 'ESModule' as const,
            path: path.join('/bundle', PROBE_MODULE),
            contents: probeSource,
          },
        ];
  return new Miniflare(
    convertV4MiniflareOptions({
      name: 'twoslash-fixture',
      modulesRoot: '/bundle',
      modules: [...probe, ...modules],
      compatibilityDate: bundle.functions.app.compatibilityDate,
      compatibilityFlags: bundle.functions.app.compatibilityFlags,
      bindings: { NODE_ENV: 'production', NEXT_DEPLOYMENT_ID: bundle.deploymentId },
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      outboundService: () => {
        proof.egressAttempts += 1;
        throw new Error('Twoslash fixture attempted outbound network');
      },
    }),
  );
}

async function responseOf(
  runtime: Miniflare,
  signal: AbortSignal,
  proof?: Proof,
): Promise<LocalResponse> {
  await bounded(runtime.ready, signal);
  if (proof !== undefined) proof.normalStage = 'request';
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);
  return bounded(
    runtime.dispatchFetch('https://twoslash.test/?default', { signal: requestSignal }),
    requestSignal,
  );
}

async function bodyOf(response: LocalResponse, signal: AbortSignal): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const result = await bounded(reader.read(), signal);
      if (result.done) {
        complete = true;
        return Buffer.concat(chunks, bytes).toString('utf8');
      }
      const chunk: unknown = result.value;
      assert.ok(chunk instanceof Uint8Array, 'Twoslash response chunk must contain bytes');
      bytes += chunk.byteLength;
      assert.ok(bytes <= MAX_BODY_BYTES, 'Twoslash response exceeded the body limit');
      chunks.push(chunk);
    }
  } finally {
    if (!complete) {
      try {
        await bounded(reader.cancel(), AbortSignal.timeout(CLEANUP_MS));
      } catch {
        // Preserve the original request failure if bounded cancellation also fails.
      }
    }
    reader.releaseLock();
  }
}

async function assertAnnotations(
  runtime: Miniflare,
  proof: Proof,
  signal: AbortSignal,
): Promise<void> {
  const response = await responseOf(runtime, signal, proof);
  proof.normalStage = 'response-read';
  proof.response = {
    status: response.status,
    bytes: null,
    stage: response.headers.get('x-upwind-twoslash-stage'),
    errorCategory: response.headers.get('x-upwind-twoslash-error'),
    errorName: response.headers.get('x-upwind-twoslash-error-name'),
    errorCode: response.headers.get('x-upwind-twoslash-error-code'),
    annotationsMatch: false,
  };
  const body = await bodyOf(response, signal);
  proof.response.bytes = Buffer.byteLength(body);
  proof.normalStage = 'annotations';
  assert.equal(response.status, HTTP_OK, 'Twoslash HTTP status');
  const value = JSON.parse(body) as unknown;
  assert.ok(typeof value === 'object' && value !== null, 'Twoslash response is not an object');
  const result = value as Record<string, unknown>;
  assert.deepEqual(
    { code: result['code'], nodes: result['nodes'], error: result['error'] },
    EXPECTED,
    'Twoslash default code and hover annotations',
  );
  proof.response.annotationsMatch = true;
  proof.normalStage = 'complete';
}

function importProof(body: string): ImportProbe {
  const value = JSON.parse(body) as unknown;
  assert.ok(typeof value === 'object' && value !== null, 'import probe returned no object');
  assert.ok(
    'stage' in value && typeof value.stage === 'string' && PROBE_STAGES.has(value.stage),
    'import probe returned an unknown stage',
  );
  assert.ok(
    'outcome' in value && typeof value.outcome === 'string' && PROBE_OUTCOMES.has(value.outcome),
    'import probe returned an unknown outcome',
  );
  const proof: ImportProbe = { stage: value.stage, outcome: value.outcome };
  if ('undefinedPathArgument' in value && typeof value.undefinedPathArgument === 'boolean') {
    proof.undefinedPathArgument = value.undefinedPathArgument;
  }
  if ('error' in value && typeof value.error === 'object' && value.error !== null) {
    proof.error = {
      name: 'name' in value.error ? (tokenOf(value.error.name) ?? 'unknown') : 'unknown',
      code: 'code' in value.error ? tokenOf(value.error.code) : null,
    };
  }
  return proof;
}

async function probeImports(
  bundle: DeploymentBundle,
  modules: Modules,
  proof: Proof,
  signal: AbortSignal,
): Promise<void> {
  const roots = bundle.entrypoints.filter(
    (entry) => entry.pathname === '/' && entry.kind === 'app-route',
  );
  assert.equal(roots.length, 1, 'one root App Route must own the Twoslash fixture');
  const root = roots[0];
  assert.ok(root !== undefined);
  const runtime = runtimeOf(bundle, modules, proof, importProbeSource(root.id));
  try {
    const response = await responseOf(runtime, signal);
    const value = importProof(await bodyOf(response, signal));
    proof.importProbe = value;
    assert.equal(response.status, HTTP_OK, 'Twoslash import probe HTTP status');
    assert.equal(value.outcome, 'success', 'Twoslash root route import did not complete');
  } finally {
    await bounded(runtime.dispose(), AbortSignal.timeout(CLEANUP_MS));
  }
}

async function probeLinkedImport(
  bundle: DeploymentBundle,
  modules: Modules,
  proof: Proof,
  signal: AbortSignal,
): Promise<void> {
  const linked = bundle.functions.app.modules.filter((module) => TWOSLASH_MODULE.test(module.name));
  assert.equal(linked.length, 1, 'one emitted linked Twoslash entry must own the fixture');
  const module = linked[0];
  assert.ok(module !== undefined);
  const runtime = runtimeOf(bundle, modules, proof, linkedImportProbeSource(module.name));
  try {
    const response = await responseOf(runtime, signal);
    const value = importProof(await bodyOf(response, signal));
    proof.linkedImportProbe = value;
    assert.equal(response.status, HTTP_OK, 'Twoslash linked import probe HTTP status');
    assert.equal(value.outcome, 'success', 'Twoslash linked import did not complete');
  } finally {
    await bounded(runtime.dispose(), AbortSignal.timeout(CLEANUP_MS));
  }
}

async function packageVersions(app: string): Promise<Record<string, string | null>> {
  const versions: Record<string, string | null> = {};
  for (const name of ['next', 'react', 'twoslash', 'typescript', '@typescript/vfs']) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(app, 'node_modules', name, 'package.json'), 'utf8'),
      ) as { version?: string };
      versions[name] = manifest.version ?? null;
    } catch {
      versions[name] = null;
    }
  }
  return versions;
}

async function tracedDeclarations(app: string): Promise<number | null> {
  try {
    const trace = JSON.parse(
      await readFile(path.join(app, '.next', 'server', 'app', 'route.js.nft.json'), 'utf8'),
    ) as { files?: string[] };
    return trace.files?.filter((file) => file.endsWith('.d.ts')).length ?? null;
  } catch {
    return null;
  }
}

/** One semantic check and isolated diagnostic imports, entirely inside CI's local native runtime. */
export async function twoslashHolds(
  bundle: DeploymentBundle,
  _dependencies: unknown,
  out: string,
): Promise<string[]> {
  const directory = process.env['UPWIND_MATRIX_PROOF_DIR'] ?? out;
  const proof: Proof = {
    status: 'running',
    sdk: {
      head: process.env['UPWIND_MATRIX_SDK_HEAD'] ?? null,
      baseline: process.env['UPWIND_MATRIX_BASELINE'] ?? null,
    },
    nextVersion: bundle.nextVersion,
    packageVersions: await packageVersions(path.dirname(out)),
    sourceSha256: {},
    declarationNamedModules: bundle.functions.app.modules.filter((module) =>
      module.name.endsWith('.d.ts'),
    ).length,
    tracedDeclarations: await tracedDeclarations(path.dirname(out)),
    modulesVerified: 0,
    linkedModules: [],
    egressAttempts: 0,
    normalStage: 'preparation',
  };
  const signal = AbortSignal.timeout(TOTAL_MS);
  try {
    for (const name of ['package.json', 'next.config.mjs', 'app/route.js']) {
      const sourceFile = path.join(path.dirname(out), name);
      const bytes = await readFile(sourceFile);
      proof.sourceSha256[name] = createHash('sha256').update(bytes).digest('hex');
    }
    assert.equal(proof.packageVersions['twoslash'], '0.3.4');
    assert.equal(proof.packageVersions['typescript'], '5.9.2');
    assert.equal(
      bundle.functions.app.mainModule,
      'index.mjs',
      'the probe must name the emitted runtime',
    );
    assert.ok(
      bundle.functions.app.modules.some((module) => module.name === 'app.cjs'),
      'the probe must name the emitted application',
    );
    const modules = await modulesOf(bundle.functions.app, out, proof);
    proof.normalStage = 'runtime-start';
    const runtime = runtimeOf(bundle, modules, proof);
    try {
      await assertAnnotations(runtime, proof, signal);
    } catch (error) {
      proof.failure = failureOf(error);
    } finally {
      await bounded(runtime.dispose(), AbortSignal.timeout(CLEANUP_MS));
    }
    try {
      await probeImports(bundle, modules, proof, signal);
    } catch (error) {
      proof.probeFailure = failureOf(error);
    }
    try {
      await probeLinkedImport(bundle, modules, proof, signal);
    } catch (error) {
      proof.linkedProbeFailure = failureOf(error);
    }
    assert.equal(proof.egressAttempts, 0, 'Twoslash fixture attempted outbound network');
    proof.status =
      proof.failure === undefined &&
      proof.probeFailure === undefined &&
      proof.linkedProbeFailure === undefined
        ? 'passed'
        : 'failed';
  } catch (error) {
    proof.failure ??= failureOf(error);
    proof.status = 'failed';
  } finally {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `twoslash-${bundle.nextVersion}.json`),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
  }
  return proof.status === 'passed'
    ? []
    : [
        `Twoslash compatibility failed: ${proof.failure?.name ?? proof.probeFailure?.name ?? 'unknown'}; see the Twoslash proof artifact`,
      ];
}
