import { serializeManifest } from '@stayingupwind/core/manifest';
import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { kvManifestKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const PATH = '/private';
const NAME = 'checker';
const SECRET = 'the application was dispatched';
type Fault = 'missing' | 'unavailable' | 'corrupt' | 'durable' | 'none';

/** The manifest's two existing reads, not a new lookup for admission information. */
function bindingsFor(fault: Fault, manifestId: string, serialized: string): EdgeBindings {
  if (fault === 'none') return env;
  return {
    ...env,
    EDGE_STATE: {
      get: (key: string) => {
        if (key !== kvManifestKey(manifestId)) return env.EDGE_STATE.get(key, 'arrayBuffer');
        if (fault === 'unavailable' || fault === 'durable')
          return Promise.reject(new Error('KV is unavailable'));
        return Promise.resolve(
          fault === 'corrupt' ? new TextEncoder().encode('not its manifest').buffer : null,
        );
      },
    } as unknown as KVNamespace,
    ARTIFACTS: {
      get: () => {
        if (fault === 'unavailable') return Promise.reject(new Error('R2 is unavailable'));
        if (fault !== 'durable') return Promise.resolve(null);
        const response = new Response(serialized);
        return Promise.resolve({
          size: new TextEncoder().encode(serialized).byteLength,
          body: response.body,
          arrayBuffer: () => response.arrayBuffer(),
        } as unknown as R2ObjectBody);
      },
    } as unknown as R2Bucket,
  };
}

async function routed(input: {
  readonly method: 'GET' | 'HEAD' | 'POST';
  readonly gated: boolean;
  readonly fault: Fault;
  readonly pass?: boolean;
}) {
  const document = pprDocument(SECRET);
  const site = await seedSite({
    document,
    pathname: PATH,
    ...(input.gated && { gates: { [PATH]: NAME }, gatedPathnames: { [PATH]: PATH } }),
  });
  const dispatch = vi.fn(() => Promise.resolve(htmlResponse(document.suffix)));
  const gate = vi.fn(() =>
    Promise.resolve(
      input.pass
        ? new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } })
        : new Response('denied', { status: 403 }),
    ),
  );
  const bindings = bindingsFor(input.fault, site.manifestId, serializeManifest(site.manifest));
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: dispatch,
  });
  const ctx = createExecutionContext();
  const request = navigation(PATH, { method: input.method });
  try {
    const response = await serveFromPointer({
      request,
      url: new URL(request.url),
      env: bindings,
      runtime,
      ctx,
      host: { ...standaloneHost(env), gates: { answer: gate } },
      pointer: { ...site.pointer, selectedPolicy: 'builtin' },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    });
    const body = await response.text();
    return { response, body, dispatch, gate };
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

describe('a gated deployment whose manifest cannot be read', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['GET', 'HEAD'] as const)(
    'fails closed on %s after each storage failure',
    async (method) => {
      vi.spyOn(console, 'warn').mockReturnValue();
      for (const fault of ['missing', 'unavailable', 'corrupt'] as const) {
        const result = await routed({ method, gated: true, fault });
        expect(result.response.status).toBe(503);
        expect(result.response.headers.get('cache-control')).toContain('no-store');
        expect(result.response.headers.get('x-arkor-edge')).toBe(
          'error;reason=gate-manifest-unavailable',
        );
        expect(result.body).not.toContain(SECRET);
        expect(result.dispatch).not.toHaveBeenCalled();
        expect(result.gate).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['GET', 'HEAD'] as const)(
    'retains ungated %s fallback during an outage',
    async (method) => {
      vi.spyOn(console, 'warn').mockReturnValue();
      const result = await routed({ method, gated: false, fault: 'unavailable' });
      expect(result.response.status).toBe(200);
      expect(result.dispatch).toHaveBeenCalledTimes(1);
      expect(result.gate).not.toHaveBeenCalled();
    },
  );

  it('keeps a non-read request on its existing application path', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const result = await routed({ method: 'POST', gated: true, fault: 'unavailable' });
    expect(result.response.status).toBe(200);
    expect(result.dispatch).toHaveBeenCalledTimes(1);
    expect(result.gate).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'] as const)(
    'still asks the gate for %s when durable fallback succeeds',
    async (method) => {
      vi.spyOn(console, 'warn').mockReturnValue();
      const result = await routed({ method, gated: true, fault: 'durable' });
      expect(result.response.status).toBe(403);
      expect(result.gate).toHaveBeenCalledTimes(1);
      expect(result.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(['GET', 'HEAD'] as const)(
    'still dispatches an admitted %s with its manifest available',
    async (method) => {
      const result = await routed({ method, gated: true, fault: 'none', pass: true });
      expect(result.response.status).toBe(200);
      expect(result.gate).toHaveBeenCalledTimes(1);
      expect(result.dispatch).toHaveBeenCalledTimes(1);
    },
  );
});
