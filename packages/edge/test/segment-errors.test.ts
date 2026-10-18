import { sha256Hex } from '@stayingupwind/core/artifact';
import { EDGE_DEBUG_HEADER, EDGE_VALIDATED_HEADER } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY, type ShellRead } from '@stayingupwind/host/delivery';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { handleSegment, type RouterPart, type SegmentInput } from '../src/handlers/segment.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const BODY = encodeUtf8('the stored router part');
const CSP = "default-src 'none'";
const ORIGIN = 'https://reader.example';
const FORWARDING = {
  previewDomain: 'example.test',
  previewHost: 'customer.example.test',
  clientIp: undefined,
};
type Failure = 'missing' | 'corrupt' | 'unavailable';

async function inputFor(kind: RouterPart = 'segment') {
  const metric = vi.fn();
  const host = standaloneHost(env);
  const runtime = standaloneRuntime(env, {
    now: () => 100,
    memory: createEdgeMemory(() => 100),
  });
  const edge: EdgeContext = {
    env,
    ctx: createExecutionContext(),
    runtime,
    host: { ...host, observer: { ...host.observer, metric } },
    forwarding: FORWARDING,
    app: undefined,
    originalUrl: undefined,
    policy: {
      ...DEFAULT_DELIVERY_POLICY,
      shell: { backend: 'kv', memoryLru: false, cacheApiLayer: false },
    },
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: false,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: 'a'.repeat(64),
    colo: 'NRT',
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: 0 },
  };
  const request = new Request<unknown, IncomingRequestCfProperties>(
    'https://customer.example.test/page',
    { headers: { 'accept-encoding': 'br' } },
  );
  const getShell = vi.fn<() => Promise<ShellRead | undefined>>();
  const input: SegmentInput = {
    request,
    edge,
    pathname: '/page',
    kind,
    segment: {
      artifact: {
        sha256: await sha256Hex(BODY),
        byteLength: BODY.byteLength,
        contentType: kind === 'data' ? 'application/json' : 'text/x-component',
        encoding: 'identity',
      },
    },
    routeHeaders: { 'x-route': 'kept', 'content-type': 'text/document' },
    configured: {
      conditioned: false,
      headers: {
        'access-control-allow-origin': ORIGIN,
        'content-security-policy': CSP,
        'content-type': 'text/configured',
        'content-encoding': 'gzip',
        'content-length': '123',
        'cache-control': 'public, max-age=600',
        'cdn-cache-control': 'max-age=600',
        'cloudflare-cdn-cache-control': 'max-age=600',
        'set-cookie': 'configured=1; Domain=.example.test; Path=/',
        [EDGE_DEBUG_HEADER]: 'forged-configured',
        [EDGE_VALIDATED_HEADER]: '1',
      },
    },
    strategy: { id: 'kv', getShell },
    middleware: {
      kind: 'continue',
      url: new URL(request.url),
      rewritten: false,
      requestHeaders: request.headers,
      responseHeaders: new Headers({
        'x-middleware-added': 'kept',
        'set-cookie': 'middleware=1; Domain=.example.test; Path=/',
        'surrogate-control': 'max-age=600',
        'content-type': 'text/middleware',
        'content-encoding': 'br',
        'content-length': '456',
        [EDGE_DEBUG_HEADER]: 'forged-middleware',
      }),
      setCookie: undefined,
    },
    middlewareDispatches: 2,
    startedAt: 80,
  };
  return { input, metric, getShell };
}

function failureRead(failure: Failure): Promise<ShellRead | undefined> {
  if (failure === 'missing') return Promise.resolve(undefined);
  if (failure === 'unavailable') return Promise.reject(new Error('storage refused'));
  return Promise.resolve({ bytes: encodeUtf8('corrupt'), source: 'kv', latencyMs: 0 });
}

async function compressed(input: SegmentInput): Promise<SegmentInput> {
  const bytes = encodeUtf8('a compressed rendering');
  return {
    ...input,
    segment: {
      ...input.segment,
      encodings: {
        br: {
          sha256: await sha256Hex(bytes),
          byteLength: bytes.byteLength,
          contentType: 'text/x-component',
          encoding: 'br',
        },
      },
    },
  };
}

describe.each(['segment', 'payload', 'data'] as const)('a failed stored %s', (kind) => {
  it.each(['missing', 'corrupt', 'unavailable'] as const)(
    'accounts for %s storage and preserves application headers under its own 503',
    async (failure) => {
      const { input, metric, getShell } = await inputFor(kind);
      getShell.mockImplementation(() => failureRead(failure));
      const response = await handleSegment(input);

      expect(response.status).toBe(503);
      expect.soft(metric).toHaveBeenCalledTimes(1);
      expect.soft(metric.mock.calls[0]?.[0]).toMatchObject({
        kind,
        outcomeKind: kind,
        shellSource: failure,
        shellStrategy: 'kv',
        shellBytes: 0,
        suffixBytes: 0,
        encoding: 'identity',
        subrequests: 3,
      });
      expect.soft(response.headers.get('content-security-policy')).toBe(CSP);
      expect.soft(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect.soft(response.headers.get('x-route')).toBe('kept');
      expect.soft(response.headers.get('x-middleware-added')).toBe('kept');
      expect
        .soft(response.headers.getSetCookie())
        .toStrictEqual(['configured=1; Path=/', 'middleware=1; Path=/']);
      expect({
        type: response.headers.get('content-type'),
        encoding: response.headers.get('content-encoding'),
        length: response.headers.get('content-length'),
        validated: response.headers.get(EDGE_VALIDATED_HEADER),
        debug: response.headers.get(EDGE_DEBUG_HEADER),
        cache: response.headers.get('cache-control'),
        sharedOverrides: [
          'cdn-cache-control',
          'cloudflare-cdn-cache-control',
          'surrogate-control',
        ].map((name) => response.headers.get(name)),
      }).toStrictEqual({
        type: 'text/html; charset=utf-8',
        encoding: null,
        length: null,
        validated: null,
        debug: `error;reason=${kind}-${failure}`,
        cache: 'private, no-store',
        sharedOverrides: [null, null, null],
      });
      await expect(response.text()).resolves.toContain('Please retry shortly');
      expect(getShell).toHaveBeenCalledTimes(1);
    },
  );
});

describe('the ownership of a segment delivery', () => {
  it('counts both failed rendering and identity reads when no fallback can answer', async () => {
    const { input, metric, getShell } = await inputFor();
    getShell.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('identity refused'));
    const response = await handleSegment(await compressed(input));

    expect(response.status).toBe(503);
    expect(metric).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shellSource: 'unavailable', shellBytes: 0, subrequests: 4 }),
    );
    expect(getShell).toHaveBeenCalledTimes(2);
  });

  it('hands a failed delivery point to detached regeneration once', async () => {
    const { input, metric, getShell } = await inputFor();
    getShell.mockResolvedValue(undefined);
    const record = vi.fn();
    const response = await handleSegment({ ...input, detached: { record } });

    expect(response.status).toBe(503);
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shellSource: 'missing', shellBytes: 0, subrequests: 3 }),
    );
    expect(metric).not.toHaveBeenCalled();
  });

  it('lets an unavailable fallback own its response and accounting', async () => {
    const { input, metric, getShell } = await inputFor();
    getShell.mockResolvedValue(undefined);
    const fallback = new Response('the Function answered');
    const onUnavailable = vi.fn(() => Promise.resolve(fallback));
    const response = await handleSegment({ ...input, onUnavailable });

    expect(response).toBe(fallback);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(metric).not.toHaveBeenCalled();
  });

  it('keeps a successful delivery and its read count', async () => {
    const { input, metric, getShell } = await inputFor();
    getShell.mockResolvedValue({ bytes: BODY, source: 'kv', latencyMs: 0 });
    const response = await handleSegment(input);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('the stored router part');
    expect(metric).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shellSource: 'kv', shellBytes: BODY.byteLength, subrequests: 3 }),
    );
  });

  it('keeps an identity fallback and both storage reads', async () => {
    const { input, metric, getShell } = await inputFor();
    getShell.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      bytes: BODY,
      source: 'kv',
      latencyMs: 0,
    });
    const response = await handleSegment(await compressed(input));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('the stored router part');
    expect(metric).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        encoding: 'identity',
        shellBytes: BODY.byteLength,
        subrequests: 4,
      }),
    );
  });
});
