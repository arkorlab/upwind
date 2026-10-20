import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BlobRef, DeploymentBundle } from '@stayingupwind/core/bundle';
import { NO_STORE_CACHE_CONTROL } from '@stayingupwind/core/request';
import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare,
  Response as LocalResponse,
  type V4FetchHandler,
} from 'miniflare';

import { failureOf, type Failure } from './twoslash-probes.ts';

const REQUEST_MS = 30_000;
const CLEANUP_MS = 5000;
const MAX_BODY_BYTES = 33_554_432;
const HTTP_OK = 200;
const HTTP_MISSING = 404;
const HTTP_ERROR = 500;
const BLOB_BINDING = 'BUNDLE_BLOBS';
const NO_READER = 'no-reader';
const NO_READER_HEAD = 'no-reader-head';
const SMALL_HEAD_NO_READER = 'small-head-no-reader';
const WRONG_SIZE = 'wrong-size';
const HEAD_MODES: ReadonlySet<Mode> = new Set(['head', NO_READER_HEAD, SMALL_HEAD_NO_READER]);
const NO_READER_MODES: ReadonlySet<Mode> = new Set([
  NO_READER,
  NO_READER_HEAD,
  SMALL_HEAD_NO_READER,
]);
const FAILURE_MODES: ReadonlySet<Mode> = new Set([
  'missing',
  NO_READER,
  NO_READER_HEAD,
  WRONG_SIZE,
]);
const ZERO_READ_MODES: ReadonlySet<Mode> = new Set([...HEAD_MODES, NO_READER, 'small']);
const TYPES = {
  esm: 'ESModule',
  commonjs: 'CommonJS',
  text: 'Text',
  json: 'Text',
  data: 'Data',
  wasm: 'CompiledWasm',
} as const;

type Mode =
  | 'html'
  | 'rsc'
  | 'head'
  | 'small'
  | 'missing'
  | 'wrong-size'
  | 'no-reader'
  | 'no-reader-head'
  | 'small-head-no-reader';
interface BlobCall {
  sha256: string;
  expectedByteLength: number;
  method: string;
  repliedBytes: number | null;
  missing: boolean;
}
export interface CaseProof {
  mode: Mode;
  status: 'running' | 'passed' | 'failed';
  calls: BlobCall[];
  egressAttempts: number;
  serviceFailures: Failure[];
  response?: {
    status: number;
    bytes: number;
    sha256: string;
    cache: string | null;
    contentType: string | null;
    cacheControl: string | null;
    vary: string | null;
  };
  failure?: Failure;
}

async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const refused = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Large body fixture aborted'),
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

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Exactly the uploaded modules; no replacement runtime or body module is injected. */
interface EmittedModule {
  type: (typeof TYPES)[keyof typeof TYPES];
  path: string;
  contents: string | Uint8Array<ArrayBuffer>;
}

export async function modulesOf(bundle: DeploymentBundle, out: string): Promise<EmittedModule[]> {
  const spec = bundle.functions.app;
  const modules = await Promise.all(
    spec.modules.map(async (module) => {
      const bytes = await readFile(path.join(out, 'blobs', module.blob.sha256));
      assert.equal(bytes.byteLength, module.blob.byteLength, 'Module byte length');
      assert.equal(sha256(bytes), module.blob.sha256, 'Module hash');
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

async function bodyOf(
  response: Awaited<ReturnType<Miniflare['dispatchFetch']>>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const result = await bounded(reader.read(), signal);
      if (result.done) {
        complete = true;
        return Buffer.concat(chunks, bytes);
      }
      const chunk: unknown = result.value;
      assert.ok(chunk instanceof Uint8Array, 'Response chunk must contain bytes');
      bytes += chunk.byteLength;
      assert.ok(bytes <= MAX_BODY_BYTES, 'Response exceeded the body limit');
      chunks.push(chunk);
    }
  } finally {
    if (!complete) {
      try {
        await bounded(reader.cancel(), AbortSignal.timeout(CLEANUP_MS));
      } catch {
        /* Keep the original failure. */
      }
    }
    reader.releaseLock();
  }
}

interface Exercise {
  bundle: DeploymentBundle;
  modules: Awaited<ReturnType<typeof modulesOf>>;
  out: string;
  signal: AbortSignal;
  mode: Mode;
  pathname: string;
  expected: BlobRef;
}

function blobService(input: Exercise, proof: CaseProof): V4FetchHandler {
  return async (request) => {
    try {
      const sha = new URL(request.url).pathname.slice(1);
      const size = Number(request.headers.get('x-expected-byte-length'));
      const call: BlobCall = {
        sha256: sha,
        expectedByteLength: size,
        method: request.method,
        repliedBytes: null,
        missing: false,
      };
      proof.calls.push(call);
      assert.equal(request.method, 'GET', 'Blob service method');
      assert.equal(sha, input.expected.sha256, 'Reader selected a different immutable blob');
      assert.equal(size, input.expected.byteLength, 'Reader omitted or changed the known length');
      assert.ok(size > 0 && size <= MAX_BODY_BYTES, 'Reader exceeded its bound');
      if (input.mode === 'missing') {
        call.missing = true;
        return new LocalResponse(null, { status: HTTP_MISSING });
      }
      const bytes = await bounded(readFile(path.join(input.out, 'blobs', sha)), input.signal);
      assert.equal(bytes.byteLength, size, 'Selected uploaded blob length');
      assert.equal(sha256(bytes), sha, 'Selected uploaded blob hash');
      const body = input.mode === WRONG_SIZE ? bytes.subarray(0, -1) : bytes;
      call.repliedBytes = body.byteLength;
      return new LocalResponse(new Uint8Array(body));
    } catch (error) {
      proof.serviceFailures.push(failureOf(error));
      throw error;
    }
  };
}

function assertResponse(
  input: Exercise,
  proof: CaseProof,
  response: Awaited<ReturnType<Miniflare['dispatchFetch']>>,
  body: Uint8Array,
): void {
  const { bundle, mode, expected } = input;
  const rsc = mode === 'rsc';
  const head = HEAD_MODES.has(mode);
  assert.ok(proof.response !== undefined);
  if (head) assert.equal(body.byteLength, 0, 'HEAD body');
  if (FAILURE_MODES.has(mode)) {
    assert.equal(response.status, HTTP_ERROR, 'Unavailable immutable body must fail');
    assert.equal(proof.response.cache, null, 'Failed read must not claim HIT');
    if (!head)
      assert.ok(
        new TextDecoder().decode(body).includes('required built page body'),
        'Failure must identify the required built body',
      );
  } else {
    assert.equal(response.status, HTTP_OK, 'Built response status');
    assert.equal(proof.response.cache, 'HIT', 'Built response cache state');
    assert.equal(proof.response.contentType, rsc ? 'text/x-component' : 'text/html; charset=utf-8');
    if (!head) {
      assert.equal(body.byteLength, expected.byteLength, 'Response byte length');
      assert.equal(
        proof.response.sha256,
        expected.sha256,
        'Response must be the selected immutable blob',
      );
    }
    if (rsc) {
      assert.equal(proof.response.vary, bundle.routing.rsc.varyHeader, 'Whole RSC Vary');
      assert.equal(proof.response.cacheControl, NO_STORE_CACHE_CONTROL);
      assert.equal(response.headers.get('link'), null, 'Whole RSC has no document preload links');
    }
  }
  const noRead = ZERO_READ_MODES.has(mode);
  assert.deepEqual(
    proof.calls,
    noRead
      ? []
      : [
          {
            sha256: expected.sha256,
            expectedByteLength: expected.byteLength,
            method: 'GET',
            repliedBytes:
              mode === 'missing' ? null : expected.byteLength - Number(mode === WRONG_SIZE),
            missing: mode === 'missing',
          },
        ],
    'Expected exact immutable reader arguments and count',
  );
  assert.deepEqual(proof.serviceFailures, [], 'Fake blob service must not fail unexpectedly');
  assert.equal(proof.egressAttempts, 0, 'No network egress');
}

/** A fresh isolate for every success, zero-read and failure case. */
export async function exercise(input: Exercise): Promise<CaseProof> {
  const { bundle, mode, signal } = input;
  const proof: CaseProof = {
    mode,
    status: 'running',
    calls: [],
    egressAttempts: 0,
    serviceFailures: [],
  };
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'large-prerender-fixture',
      modulesRoot: '/bundle',
      modules: input.modules,
      compatibilityDate: bundle.functions.app.compatibilityDate,
      compatibilityFlags: bundle.functions.app.compatibilityFlags,
      bindings: {
        NODE_ENV: 'production',
        NEXT_DEPLOYMENT_ID: bundle.deploymentId,
        NO_BLOB_READER: NO_READER_MODES.has(mode) ? '1' : '0',
      },
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      outboundService: () => {
        proof.egressAttempts += 1;
        throw new Error('Fixture attempted outbound network');
      },
      serviceBindings: {
        [BLOB_BINDING]: blobService(input, proof),
      },
    }),
  );
  try {
    await bounded(runtime.ready, signal);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);
    const rsc = mode === 'rsc';
    const response = await bounded(
      runtime.dispatchFetch(`https://large-prerender.test${input.pathname}`, {
        method: HEAD_MODES.has(mode) ? 'HEAD' : 'GET',
        headers: rsc ? { [bundle.routing.rsc.header]: '1' } : {},
        signal: requestSignal,
      }),
      requestSignal,
    );
    const body = await bodyOf(response, requestSignal);
    proof.response = {
      status: response.status,
      bytes: body.byteLength,
      sha256: sha256(body),
      cache: response.headers.get('x-nextjs-cache'),
      contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
      vary: response.headers.get('vary'),
    };
    assertResponse(input, proof, response, body);
    proof.status = 'passed';
  } catch (error) {
    proof.failure = failureOf(error);
    proof.status = 'failed';
  } finally {
    try {
      await bounded(runtime.dispose(), AbortSignal.timeout(CLEANUP_MS));
    } catch (error) {
      proof.failure ??= failureOf(error);
      proof.status = 'failed';
    }
  }
  return proof;
}
