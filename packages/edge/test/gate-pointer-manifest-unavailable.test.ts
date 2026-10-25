import { serializeManifest } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import type { EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const PRIVATE_PATH = '/private';
const FALLBACK = 'the application answered without the gate';
const READ_MS = 2000;
const HEDGE_MS = 50;

const CASES = [
  {
    name: 'a hasGates-only GET fails closed on missing metadata',
    marker: 'hasGates',
    gated: true,
    method: 'GET',
    backend: 'missing',
    status: 503,
    gates: 0,
    dispatches: 0,
    terminal: 1,
  },
  {
    name: 'a hasGates-only HEAD fails closed on missing metadata',
    marker: 'hasGates',
    gated: true,
    method: 'HEAD',
    backend: 'missing',
    status: 503,
    gates: 0,
    dispatches: 0,
    terminal: 1,
  },
  {
    name: 'a hasGates-only GET fails closed on failed metadata',
    marker: 'hasGates',
    gated: true,
    method: 'GET',
    backend: 'failed',
    status: 503,
    gates: 0,
    dispatches: 0,
    terminal: 1,
  },
  {
    name: 'a hasGates-only HEAD fails closed on failed metadata',
    marker: 'hasGates',
    gated: true,
    method: 'HEAD',
    backend: 'failed',
    status: 503,
    gates: 0,
    dispatches: 0,
    terminal: 1,
  },
  {
    name: 'a hasGates-only GET fails closed on stalled metadata',
    marker: 'hasGates',
    gated: true,
    method: 'GET',
    backend: 'stalled',
    status: 503,
    gates: 0,
    dispatches: 0,
    terminal: 1,
  },
  {
    name: 'a hasGates-only HEAD fails closed on stalled metadata',
    marker: 'hasGates',
    gated: true,
    method: 'HEAD',
    backend: 'stalled',
    status: 503,
    gates: 0,
    dispatches: 0,
    terminal: 1,
  },
  {
    name: 'a legacy requiresGate-only pointer keeps its unavailable guard',
    marker: 'requiresGate',
    gated: true,
    method: 'GET',
    backend: 'missing',
    status: 503,
    gates: 0,
    dispatches: 0,
    terminal: 0,
  },
  {
    name: 'an unmarked ungated pointer keeps its application fallback',
    marker: 'none',
    gated: false,
    method: 'GET',
    backend: 'failed',
    status: 200,
    gates: 0,
    dispatches: 1,
    terminal: 0,
  },
  {
    name: 'a hasGates-only POST stays independent of a stalled manifest',
    marker: 'hasGates',
    gated: true,
    method: 'POST',
    backend: 'stalled',
    status: 200,
    gates: 0,
    dispatches: 1,
    terminal: 0,
  },
  {
    name: 'a hasGates-only pointer still asks its gate after durable fallback',
    marker: 'hasGates',
    gated: true,
    method: 'GET',
    backend: 'durable',
    status: 403,
    gates: 1,
    dispatches: 0,
    terminal: 0,
  },
] as const;

type Case = (typeof CASES)[number];

/** Each wire-contract variant is isolated from the fixture's other marker. */
function pointerForMarker(pointer: EdgePointer, marker: Case['marker']): EdgePointer {
  const selected = { ...pointer, selectedPolicy: 'builtin' as const };
  Reflect.deleteProperty(selected, 'requiresGate');
  Reflect.deleteProperty(selected, 'hasGates');
  if (marker !== 'none') Reflect.set(selected, marker, true);
  return selected;
}

/** Only the new early terminal point is expected before a gate or an app dispatch starts. */
function expectedTerminal(row: Case, subject: Awaited<ReturnType<typeof fixture>>) {
  return row.terminal === 0
    ? []
    : [{ pathname: PRIVATE_PATH, manifestId: subject.manifestId, subrequests: 0 }];
}

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
  const kv = Promise.withResolvers<ArrayBuffer | null>();
  const bucket = Promise.withResolvers<R2ObjectBody | null>();
  const get = vi.fn((): Promise<ArrayBuffer | null> => {
    if (row.backend === 'failed' || row.backend === 'durable')
      return Promise.reject(new Error('KV unavailable'));
    if (row.backend === 'stalled') return kv.promise;
    return Promise.resolve(null);
  });
  const getObject = vi.fn((): Promise<R2ObjectBody | null> => {
    if (row.backend === 'failed') return Promise.reject(new Error('R2 unavailable'));
    if (row.backend === 'durable') {
      const response = new Response(bytes);
      return Promise.resolve({
        size: bytes.byteLength,
        body: response.body,
        arrayBuffer: () => response.arrayBuffer(),
      } as unknown as R2ObjectBody);
    }
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
  const points: EdgeMetric[] = [];
  const ctx = createExecutionContext();
  const request = navigation(PRIVATE_PATH, { method: row.method });
  return {
    ctx,
    points,
    manifestId: site.manifestId,
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
        host: {
          ...standaloneHost(env),
          gates: { answer: gate },
          observer: {
            metric: (point) => {
              points.push(point);
            },
            recordServed: vi.fn(),
            imageTransformed: vi.fn(),
          },
        },
        pointer: pointerForMarker(site.pointer, row.marker),
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

describe('a hasGates pointer whose cold manifest cannot be read', () => {
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
      const terminalPoints = subject.points.filter(
        (point) => point.outcomeKind === 'gate-manifest-unavailable',
      );
      const debug = response.headers.get(EDGE_DEBUG_HEADER);
      const body = await response.text();

      expect(response.status).toBe(row.status);
      expect(subject.gate).toHaveBeenCalledTimes(row.gates);
      expect(subject.dispatch).toHaveBeenCalledTimes(row.dispatches);
      expect(debug === 'error;reason=gate-manifest-unavailable').toBe(row.terminal === 1);
      expect(debug === 'error;reason=gate-unavailable').toBe(row.marker === 'requiresGate');
      expect(body.includes(FALLBACK)).toBe(row.status === 200);
      expect(
        terminalPoints.map((point) => {
          return {
            pathname: point.pathname,
            manifestId: point.manifestId,
            subrequests: point.subrequests,
          };
        }),
      ).toStrictEqual(expectedTerminal(row, subject));
    } finally {
      await releaseSubject(subject, answering);
    }
  });
});
