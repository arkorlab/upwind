import { serializeManifest } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const PRIVATE_PATH = '/private';
const FALLBACK = 'the application answered without the gate';
const READ_MS = 2000;
const HEDGE_MS = 50;

const CASES = [
  {
    name: 'missing metadata rejects a gated GET',
    gated: true,
    method: 'GET',
    backend: 'missing',
    status: 503,
    gates: 0,
    dispatches: 0,
  },
  {
    name: 'missing metadata rejects a gated HEAD',
    gated: true,
    method: 'HEAD',
    backend: 'missing',
    status: 503,
    gates: 0,
    dispatches: 0,
  },
  {
    name: 'failed metadata rejects a gated GET',
    gated: true,
    method: 'GET',
    backend: 'failed',
    status: 503,
    gates: 0,
    dispatches: 0,
  },
  {
    name: 'failed metadata rejects a gated HEAD',
    gated: true,
    method: 'HEAD',
    backend: 'failed',
    status: 503,
    gates: 0,
    dispatches: 0,
  },
  {
    name: 'metadata deadline rejects a gated GET',
    gated: true,
    method: 'GET',
    backend: 'stalled',
    status: 503,
    gates: 0,
    dispatches: 0,
  },
  {
    name: 'metadata deadline rejects a gated HEAD',
    gated: true,
    method: 'HEAD',
    backend: 'stalled',
    status: 503,
    gates: 0,
    dispatches: 0,
  },
  {
    name: 'missing metadata preserves an ungated GET fallback',
    gated: false,
    method: 'GET',
    backend: 'missing',
    status: 200,
    gates: 0,
    dispatches: 1,
  },
  {
    name: 'metadata deadline preserves an ungated GET fallback',
    gated: false,
    method: 'GET',
    backend: 'stalled',
    status: 200,
    gates: 0,
    dispatches: 1,
  },
  {
    name: 'a present manifest still asks the gate before the application',
    gated: true,
    method: 'GET',
    backend: 'found',
    status: 403,
    gates: 1,
    dispatches: 0,
  },
  {
    name: 'a gated POST dispatches before a stalled manifest',
    gated: true,
    method: 'POST',
    backend: 'stalled',
    status: 200,
    gates: 0,
    dispatches: 1,
  },
  // Deliberate marker/manifest mismatch: supplemental hardening, not an existing gate baseline.
  {
    name: 'a required gate rejects a present manifest with no gate map',
    gated: false,
    requireGateMarker: true,
    method: 'GET',
    backend: 'found',
    status: 503,
    gates: 0,
    dispatches: 0,
  },
] as const;

type Case = (typeof CASES)[number];

async function fixture(row: Case) {
  const site = await seedSite({
    document: pprDocument(),
    pathname: PRIVATE_PATH,
    ...(row.gated && {
      gates: { [PRIVATE_PATH]: 'authorization' },
      gatedPathnames: { [PRIVATE_PATH]: PRIVATE_PATH },
    }),
  });
  const bytes = new TextEncoder().encode(serializeManifest(site.manifest));
  const owned = bytes.buffer;
  if (!(owned instanceof ArrayBuffer)) throw new TypeError('owned manifest buffer required');
  const kv = Promise.withResolvers<ArrayBuffer | null>();
  const bucket = Promise.withResolvers<R2ObjectBody | null>();
  const get = vi.fn((): Promise<ArrayBuffer | null> => {
    if (row.backend === 'failed') return Promise.reject(new Error('KV unavailable'));
    if (row.backend === 'found') return Promise.resolve(owned);
    if (row.backend === 'stalled') return kv.promise;
    return Promise.resolve(null);
  });
  const getObject = vi.fn((): Promise<R2ObjectBody | null> => {
    if (row.backend === 'failed') return Promise.reject(new Error('R2 unavailable'));
    return row.backend === 'stalled' ? bucket.promise : Promise.resolve(null);
  });
  const bindings: EdgeBindings = {
    ...env,
    EDGE_STATE: { get } as unknown as KVNamespace,
    ARTIFACTS: { get: getObject } as unknown as R2Bucket,
  };
  const gate = vi.fn(() => Promise.resolve(new Response('denied', { status: 403 })));
  const dispatch = vi.fn(() => Promise.resolve(htmlResponse(FALLBACK)));
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: dispatch,
  });
  const ctx = createExecutionContext();
  const request = navigation(PRIVATE_PATH, { method: row.method });
  return {
    ctx,
    gate,
    dispatch,
    release: (): void => {
      kv.resolve(null);
      bucket.resolve(null);
    },
    serve: (): Promise<Response> => {
      return serveFromPointer({
        request,
        url: new URL(request.url),
        env: bindings,
        runtime,
        ctx,
        host: { ...standaloneHost(env), gates: { answer: gate } },
        pointer: {
          ...site.pointer,
          ...('requireGateMarker' in row && { requiresGate: true as const }),
          selectedPolicy: 'builtin',
        },
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      });
    },
  };
}

function prepareClock(row: Case): void {
  if (row.backend === 'stalled') vi.useFakeTimers();
}

async function advanceBackendClock(row: Case): Promise<void> {
  if (row.backend !== 'stalled') return;
  const elapsed = row.method === 'POST' ? 0 : READ_MS + HEDGE_MS + 1;
  await vi.advanceTimersByTimeAsync(elapsed);
}

async function releaseSubject(
  subject: Awaited<ReturnType<typeof fixture>>,
  answering: Promise<Response>,
): Promise<void> {
  subject.release();
  const response = await answering;
  if (!response.bodyUsed) await response.body?.cancel();
  await waitOnExecutionContext(subject.ctx);
}

describe('a gated deployment whose cold manifest cannot be read', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(CASES)('$name', async (row) => {
    const subject = await fixture(row);
    vi.spyOn(console, 'warn').mockReturnValue();
    prepareClock(row);
    const answering = subject.serve();
    try {
      await advanceBackendClock(row);
      const response = await answering;
      const gateUnavailable =
        response.headers.get(EDGE_DEBUG_HEADER) === 'error;reason=gate-unavailable';

      expect(response.status).toBe(row.status);
      expect(subject.gate).toHaveBeenCalledTimes(row.gates);
      expect(subject.dispatch).toHaveBeenCalledTimes(row.dispatches);
      expect(gateUnavailable).toBe(row.status === 503);

      await response.body?.cancel();
    } finally {
      await releaseSubject(subject, answering);
    }
  });
});
