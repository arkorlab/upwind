import type { ProjectManifest } from '@stayingupwind/core/manifest';
import {
  FUNCTION_HEADER,
  isLogCorrelationId,
  LOG_CORRELATION_HEADER,
  MISDIRECTED_STATUS,
} from '@stayingupwind/core/paas';
import { NEXT_RESUME_HEADER, sanitizePassthroughHeaders } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DispatchApp } from '../src/edge-runtime.ts';
import { handlePassthrough } from '../src/handlers/passthrough.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { forwardingFor, type IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite, type Site } from './helpers/site.ts';

const MIDDLEWARE = 'site-middleware';

/** Exercise the real request forwarding, including middleware and shell resumes, without a host. */
async function routed(
  site: Site,
  request: IncomingRequest,
  dispatch: DispatchApp,
  options: {
    readonly manifest?: ProjectManifest;
    readonly external?: (request: Request) => Promise<Response>;
  } = {},
): Promise<{ readonly response: Response; readonly body: string }> {
  const { manifest = site.manifest, external } = options;
  const ctx = createExecutionContext();
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: dispatch,
    ...(external !== undefined && { fetchImpl: external }),
  });
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host: standaloneHost(env),
      pointer: {
        ...site.pointer,
        app: { ...site.pointer.app!, middlewareScriptName: MIDDLEWARE },
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
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body };
}

function withMiddleware(site: Site): ProjectManifest {
  return { ...site.manifest, middleware: { matchers: [{ sourceRegex: '^/.*$' }] } };
}

describe('a logical request custom log context', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'shares one trusted id between middleware and the application (resume: %s)',
    async (resume) => {
      const document = pprDocument();
      const site = await seedSite({ document });
      const request = navigation(resume ? '/' : '/api/start', {
        headers: { [LOG_CORRELATION_HEADER]: 'client-forgery' },
      });
      const forwarded: Request[] = [];
      const mint = vi.spyOn(crypto, 'randomUUID');
      const answer = await routed(
        site,
        request,
        (script, asked) => {
          forwarded.push(asked);
          if (script === MIDDLEWARE) {
            return Promise.resolve(
              new Response(null, {
                headers: {
                  ...(resume
                    ? { 'x-middleware-next': '1' }
                    : { 'x-middleware-rewrite': 'https://site.example/api/rewritten' }),
                  'x-middleware-override-headers': LOG_CORRELATION_HEADER,
                  [`x-middleware-request-${LOG_CORRELATION_HEADER}`]: 'middleware-forgery',
                  [LOG_CORRELATION_HEADER]: 'response-forgery',
                },
              }),
            );
          }
          return Promise.resolve(
            htmlResponse(resume ? document.suffix : 'application', {
              headers: { [LOG_CORRELATION_HEADER]: asked.headers.get(LOG_CORRELATION_HEADER)! },
            }),
          );
        },
        { manifest: withMiddleware(site) },
      );

      const ids = forwarded.map((asked) => asked.headers.get(LOG_CORRELATION_HEADER));

      expect(ids).toHaveLength(2);
      expect(isLogCorrelationId(ids[0])).toBe(true);
      expect(ids[1]).toBe(ids[0]);
      expect(mint).toHaveBeenCalledTimes(1);
      expect(forwarded[1]?.headers.get(NEXT_RESUME_HEADER)).toBe(resume ? '1' : null);
      expect(answer.body).toContain(resume ? 'Hello dynamic' : 'application');
      expect(answer.response.headers.has(LOG_CORRELATION_HEADER)).toBe(false);
      expect(request.headers.get(LOG_CORRELATION_HEADER)).toBe('client-forgery');
    },
  );

  it('keeps the same id when a failed middleware falls back to the application', async () => {
    const site = await seedSite({ document: pprDocument() });
    const ids: (string | null)[] = [];
    const mint = vi.spyOn(crypto, 'randomUUID');
    const answer = await routed(
      site,
      navigation('/api/fallback'),
      (script, request) => {
        ids.push(request.headers.get(LOG_CORRELATION_HEADER));
        return script === MIDDLEWARE
          ? Promise.reject(new Error('middleware failed'))
          : Promise.resolve(new Response('fallback'));
      },
      { manifest: withMiddleware(site) },
    );

    expect(answer.body).toBe('fallback');
    expect(ids).toHaveLength(2);
    expect(isLogCorrelationId(ids[0])).toBe(true);
    expect(ids[1]).toBe(ids[0]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('reuses the ingress owner across routing passes and isolates a second visitor', async () => {
    const site = await seedSite({ document: pprDocument() });
    const original = navigation('/api/rerouted');
    const ids: (string | null)[] = [];
    const dispatch: DispatchApp = (_script, request) => {
      ids.push(request.headers.get(LOG_CORRELATION_HEADER));
      return Promise.resolve(new Response('application'));
    };
    const mint = vi.spyOn(crypto, 'randomUUID');

    await routed(site, original, dispatch);
    await routed(site, original, dispatch);
    await routed(site, navigation('/api/rerouted'), dispatch);

    expect(ids).toHaveLength(3);
    expect(isLogCorrelationId(ids[0])).toBe(true);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('preserves the id when a split Worker sends the request to the correct function', async () => {
    const site = await seedSite({ document: pprDocument() });
    const ids: (string | null)[] = [];
    const scripts: string[] = [];
    const mint = vi.spyOn(crypto, 'randomUUID');
    const answer = await routed(
      {
        ...site,
        pointer: {
          ...site.pointer,
          app: { ...site.pointer.app!, functions: { 'app-2': 'site-app-2' } },
        },
      },
      navigation('/api/split'),
      (script, request) => {
        scripts.push(script);
        ids.push(request.headers.get(LOG_CORRELATION_HEADER));
        return Promise.resolve(
          script === 'site-app'
            ? new Response(null, {
                status: MISDIRECTED_STATUS,
                headers: { [FUNCTION_HEADER]: 'app-2' },
              })
            : new Response('correct function'),
        );
      },
    );

    expect(answer.body).toBe('correct function');
    expect(scripts).toStrictEqual(['site-app', 'site-app-2']);
    expect(isLogCorrelationId(ids[0])).toBe(true);
    expect(ids[1]).toBe(ids[0]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('sets the trusted value after passthrough instruction overlays', async () => {
    const original = navigation('/api/overlaid');
    const ids: (string | null)[] = [];
    const response = await handlePassthrough({
      request: original,
      forwarding: forwardingFor(original, 'example', 'site.example'),
      runtime: standaloneRuntime(env, {
        dispatchApp: (_script, request) => {
          ids.push(request.headers.get(LOG_CORRELATION_HEADER));
          return Promise.resolve(new Response('application'));
        },
      }),
      host: standaloneHost(env),
      app: { deploymentId: 'dpl_site', scriptName: 'site-app' },
      reason: 'api',
      headers: { [LOG_CORRELATION_HEADER]: 'instruction-forgery' },
    });

    await expect(response.text()).resolves.toBe('application');
    expect(ids).toHaveLength(1);
    expect(isLogCorrelationId(ids[0])).toBe(true);
  });

  it('mints nothing for a static answer or routing header evaluation', async () => {
    const site = await seedSite({
      document: pprDocument(),
      files: { '/robots.txt': 'User-agent: *' },
      headerRules: [
        {
          sourceRegex: '^/.*$',
          has: [{ type: 'header', key: LOG_CORRELATION_HEADER }],
          headers: { 'x-forged-condition': 'matched' },
        },
      ],
    });
    const request = navigation('/robots.txt', {
      headers: { [LOG_CORRELATION_HEADER]: 'client-forgery' },
    });
    const mint = vi.spyOn(crypto, 'randomUUID');
    const dispatch = vi.fn<DispatchApp>(() => Promise.resolve(new Response('unexpected')));
    const first = forwardingFor(request, 'example', 'site.example');
    const second = forwardingFor(request, 'example', 'site.example');

    expect(sanitizePassthroughHeaders(request.headers, first).has(LOG_CORRELATION_HEADER)).toBe(
      false,
    );
    expect(sanitizePassthroughHeaders(request.headers, second).has(LOG_CORRELATION_HEADER)).toBe(
      false,
    );

    const answer = await routed(site, request, dispatch);

    expect(answer.body).toBe('User-agent: *');
    expect(answer.response.headers.has('x-forged-condition')).toBe(false);
    expect(answer.response.headers.has(LOG_CORRELATION_HEADER)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it('removes the id from a middleware rewrite to another origin', async () => {
    const site = await seedSite({ document: pprDocument() });
    const seen: Request[] = [];
    const answer = await routed(
      site,
      navigation('/api/external'),
      () => {
        return Promise.resolve(
          new Response(null, {
            headers: {
              'x-middleware-rewrite': 'https://origin.example/rewritten',
              'x-middleware-override-headers': LOG_CORRELATION_HEADER,
              [`x-middleware-request-${LOG_CORRELATION_HEADER}`]: 'middleware-forgery',
            },
          }),
        );
      },
      {
        manifest: withMiddleware(site),
        external: (request) => {
          seen.push(request);
          return Promise.resolve(new Response('external'));
        },
      },
    );

    expect(answer.body).toBe('external');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.has(LOG_CORRELATION_HEADER)).toBe(false);
  });
});
