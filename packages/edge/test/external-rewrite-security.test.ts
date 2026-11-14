import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeHost } from '../src/edge-host.ts';
import { EXTERNAL_REWRITE_TIMEOUT_MS } from '../src/handlers/external-rewrite-target.ts';
import { followExternalRewrite } from '../src/handlers/middleware.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { forwardingFor } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const MIDDLEWARE_SCRIPT = 'site-middleware';
const EVERY_PATH = '^/.*$';
const BAD_GATEWAY_STATUS = 502;
const OK_STATUS = 200;

interface RewriteObservation {
  readonly response: Response;
  readonly fetched: readonly Request[];
  readonly metrics: readonly EdgeMetric[];
}

async function rewriteTo(
  target: string,
  options: {
    readonly origin?: (request: Request) => Promise<Response> | Response;
    readonly init?: RequestInit;
    readonly ownDomains?: readonly string[];
    readonly ownHostnames?: readonly string[];
  } = {},
): Promise<RewriteObservation> {
  const site = await seedSite({ document: pprDocument() });
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: EVERY_PATH }] },
  };
  const fetched: Request[] = [];
  const metrics: EdgeMetric[] = [];
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (scriptName: string): Promise<Response> => {
      if (scriptName === MIDDLEWARE_SCRIPT) {
        return Promise.resolve(
          new Response(null, {
            headers: {
              'x-middleware-rewrite': target,
              'x-set-by': 'middleware',
            },
          }),
        );
      }
      return Promise.resolve(new Response('unexpected Function call'));
    },
    fetchImpl: (request: Request): Promise<Response> => {
      fetched.push(request);
      return Promise.resolve(
        options.origin === undefined
          ? new Response('from external origin')
          : options.origin(request),
      );
    },
  });
  const baseHost = standaloneHost(env);
  const host: EdgeHost = {
    ...baseHost,
    ownDomains: options.ownDomains ?? ['hosted.example'],
    ownHostnames: options.ownHostnames ?? baseHost.ownHostnames,
    observer: {
      ...baseHost.observer,
      metric: (metric): void => {
        metrics.push(metric);
      },
    },
  };
  const request = navigation('/entry', options.init);
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host,
      pointer: {
        ...site.pointer,
        app: {
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          middlewareScriptName: MIDDLEWARE_SCRIPT,
        },
      },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: Promise.resolve({
        kind: 'found',
        source: 'exact',
        policy: DEFAULT_DELIVERY_POLICY,
      }),
    },
  );
  await waitOnExecutionContext(ctx);
  return { response, fetched, metrics };
}

describe('followExternalRewrite target refusal and timeout bounds', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['IPv4 loopback', 'http://127.0.0.1/internal'],
    ['IPv4 loopback with port', 'http://127.0.0.1:8787/internal'],
    ['localhost', 'http://localhost/internal'],
    ['localhost with trailing dot', 'http://localhost./internal'],
    ['subdomain of localhost', 'http://admin.localhost/internal'],
    ['IPv6 loopback', 'http://[::1]/internal'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/internal'],
    ['link-local metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['deployment own domain over http', 'http://site.example/internal'],
    ['deployment own domain with port', 'https://site.example:8443/internal'],
    ['deployment own domain with trailing dot', 'https://site.example./internal'],
    ['deployment own domain uppercase with trailing dot', 'https://SITE.EXAMPLE./internal'],
    ['standalone ownHostname with trailing dot', 'https://site-edge.example.workers.dev./internal'],
    ['host ownDomain root', 'https://hosted.example/internal'],
    ['host ownDomain subdomain with trailing dot', 'https://other.hosted.example./internal'],
  ])('refuses %s (%s) before issuing a fetch', async (_label, target) => {
    const { response, fetched, metrics } = await rewriteTo(target);

    expect(response.status).toBe(BAD_GATEWAY_STATUS);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(
      'error;reason=external-rewrite-unavailable',
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-set-by')).toBe('middleware');
    expect(fetched).toStrictEqual([]);
    expect(
      metrics.map(({ outcomeKind, subrequests }) => ({ outcomeKind, subrequests })),
    ).toStrictEqual([{ outcomeKind: 'external-rewrite-unavailable', subrequests: 1 }]);
  });

  it('releases the request body stream when an external rewrite target is refused', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => Promise.resolve(),
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://site.example/upload', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    const fetched: string[] = [];
    const baseHost = standaloneHost(env);
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      fetchImpl: (outbound: Request): Promise<Response> => {
        fetched.push(outbound.url);
        return Promise.resolve(new Response('unexpected'));
      },
    });
    const ctx = createExecutionContext();
    const edge: EdgeContext = {
      env,
      ctx,
      runtime,
      host: baseHost,
      forwarding: forwardingFor(request, baseHost.sharedDomain, 'site.example'),
      app: { deploymentId: 'dpl_site', scriptName: 'site-app' },
      originalUrl: undefined,
      policy: DEFAULT_DELIVERY_POLICY,
      cspNonce: false,
      cspNonceMode: 'enforce',
      cspStrictDynamic: false,
      cacheApi: false,
      assetMaxBytes: 1024,
      projectId: 'proj_site',
      manifestId: 'mf_site',
      colo: undefined,
      validated: false,
      demotedRoutes: undefined,
      privateDelivery: false,
      timings: { pointerMs: 0, manifestMs: 0, middlewareMs: 0 },
    };
    const response = await followExternalRewrite(
      edge,
      request,
      {
        kind: 'external-rewrite',
        url: new URL('http://127.0.0.1/internal'),
        requestHeaders: new Headers(),
        responseHeaders: new Headers(),
      },
      { pathname: '/upload', middlewareMs: 1, dispatches: 1, configured: { headers: {} } },
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(BAD_GATEWAY_STATUS);
    expect(fetched).toStrictEqual([]);
    expect(cancelled).toBe(true);
  });

  it('aborts an upstream that never sends headers within 30 seconds and answers 502', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { promise: reached, resolve: reach } = Promise.withResolvers<undefined>();
    let outboundAborted = false;
    const pending = rewriteTo('https://elsewhere.example/stalled', {
      origin: (outbound) => {
        const stalled = Promise.withResolvers<Response>();
        outbound.signal.addEventListener(
          'abort',
          () => {
            outboundAborted = true;
            stalled.reject(new DOMException('The operation timed out.', 'TimeoutError'));
          },
          { once: true },
        );
        reach(undefined);
        return stalled.promise;
      },
    });
    await reached;
    await vi.advanceTimersByTimeAsync(EXTERNAL_REWRITE_TIMEOUT_MS - 1);

    expect(outboundAborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const { response } = await pending;

    expect(outboundAborted).toBe(true);
    expect(response.status).toBe(BAD_GATEWAY_STATUS);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(
      'error;reason=external-rewrite-unavailable',
    );
  });

  it('clears the header timeout once headers arrive so body streaming continues past 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const encoder = new TextEncoder();
    const { promise: pulled, resolve: markPulled } = Promise.withResolvers<undefined>();
    const { promise: nextChunk, resolve: sendSecondChunk } = Promise.withResolvers<undefined>();
    let outboundAborted = false;
    const { response } = await rewriteTo('https://elsewhere.example/events', {
      origin: (outbound) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            outbound.signal.addEventListener(
              'abort',
              () => {
                outboundAborted = true;
                controller.error(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
            controller.enqueue(encoder.encode('first:'));
          },
          async pull(controller) {
            markPulled(undefined);
            await nextChunk;
            controller.enqueue(encoder.encode('second'));
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const reading = response.text();
    await pulled;
    await vi.advanceTimersByTimeAsync(EXTERNAL_REWRITE_TIMEOUT_MS * 2);
    sendSecondChunk(undefined);
    const text = await reading;

    expect(response.status).toBe(OK_STATUS);
    expect(outboundAborted).toBe(false);
    expect(text).toBe('first:second');
  });

  it('propagates client request.signal cancellation to the outbound rewrite fetch', async () => {
    const clientController = new AbortController();
    let outboundAborted = false;
    const { response } = await rewriteTo('https://elsewhere.example/stream', {
      init: { signal: clientController.signal },
      origin: (outbound) => {
        const pending = Promise.withResolvers<Response>();
        outbound.signal.addEventListener(
          'abort',
          () => {
            outboundAborted = true;
            pending.reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
        clientController.abort();
        return pending.promise;
      },
    });

    expect(outboundAborted).toBe(true);
    expect(response.status).toBe(BAD_GATEWAY_STATUS);
  });
});
