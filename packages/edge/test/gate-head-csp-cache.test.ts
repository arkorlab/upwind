import type { HeaderRule } from '@stayingupwind/core/manifest';
import type { EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeGates } from '../src/edge-host.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const POST = '/posts/[slug]';
const POST_PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const GATE = 'checker';
const CSP = 'content-security-policy';
const REPORT_ONLY = 'content-security-policy-report-only';
const KEPT_NONCE = 'a2VwdCBmb3IgZXZlcnlvbmU=';
const CACHE_CONTROL = 'private, max-age=60';

/** The real gate route, with no application dispatch needed for its terminal answer. */
async function routed(
  method: 'GET' | 'HEAD',
  gateAnswer: Response,
  settings: Partial<EdgePointer>,
  headerRules?: readonly HeaderRule[],
) {
  const document = pprDocument();
  const { pointer } = await seedSite({
    document,
    pathname: POST,
    dynamicRoutes: [{ sourceRegex: POST_PATTERN, route: POST, gated: POST }],
    gates: { [POST]: GATE },
    gatedPathnames: { [POST]: POST },
    ...(headerRules !== undefined && { headerRules }),
  });
  const asked: string[] = [];
  const functionAsked: string[] = [];
  const gates: EdgeGates = {
    answer: (_name, request) => {
      asked.push(request.method);
      return Promise.resolve(gateAnswer);
    },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_deployment, request) => {
      functionAsked.push(request.method);
      return Promise.resolve(new Response('unexpected application request'));
    },
  });
  const request = navigation('/posts/abc', { method });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host: { ...standaloneHost(env), gates },
    pointer: { ...pointer, ...settings },
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);

  expect(asked).toStrictEqual([method]);
  expect(functionAsked).toStrictEqual([]);

  return { response, body };
}

function answer(method: 'GET' | 'HEAD', policy: string, type = 'text/html'): Response {
  return new Response(
    method === 'HEAD' ? null : `<html><script nonce="${KEPT_NONCE}">1</script></html>`,
    {
      headers: {
        'content-type': type,
        [CSP]: policy,
        'cache-control': CACHE_CONTROL,
        etag: '"saved"',
        'last-modified': 'Fri, 16 Oct 2026 00:00:00 GMT',
      },
    },
  );
}

function policyNonce(response: Response, header: string): string | undefined {
  return /'nonce-([^']+)'/u.exec(response.headers.get(header) ?? '')?.[1];
}

const modes = [
  ['enforce', CSP],
  ['report-only', REPORT_ONLY],
] as const;

describe('a terminal gate HEAD whose policy gets a fresh nonce', () => {
  it.each(modes)('cannot refresh a cached GET policy under %s', async (mode, header) => {
    const settings = { cspNonce: true, cspNonceMode: mode } as const;
    const policy = `script-src 'self' 'nonce-${KEPT_NONCE}'`;
    const get = await routed('GET', answer('GET', policy), settings);
    const head = await routed('HEAD', answer('HEAD', policy), settings);
    const getNonce = policyNonce(get.response, header);
    const headNonce = policyNonce(head.response, header);

    expect(getNonce).toBeDefined();
    expect(get.body).toContain(`nonce="${getNonce ?? ''}"`);
    expect({ status: head.response.status, body: head.body }).toStrictEqual({
      status: 200,
      body: '',
    });
    expect(headNonce).toBeDefined();
    expect(headNonce).not.toBe(getNonce);
    expect(get.body).not.toContain(`nonce="${headNonce ?? ''}"`);
    expect(
      ['etag', 'last-modified', 'content-length'].filter((name) => head.response.headers.has(name)),
    ).toStrictEqual([]);
    expect(head.response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('overrides a configured browser freshness period for its fresh HEAD policy', async () => {
    const { response, body } = await routed(
      'HEAD',
      answer('HEAD', "script-src 'self'"),
      { cspNonce: true },
      [{ sourceRegex: POST_PATTERN, headers: { 'cache-control': 'public, max-age=120' } }],
    );

    expect(body).toBe('');
    expect(policyNonce(response, CSP)).toBeDefined();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it.each(modes)('keeps cacheable GET bytes and policy together under %s', async (mode, header) => {
    const { response, body } = await routed('GET', answer('GET', "script-src 'self'"), {
      cspNonce: true,
      cspNonceMode: mode,
    });
    const nonce = policyNonce(response, header);

    expect(nonce).toBeDefined();
    expect(body).toContain(`nonce="${nonce ?? ''}"`);
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
  });

  it.each([
    ['without nonce opt-in', {}, 'text/html', "script-src 'self'"],
    ['without a script policy', { cspNonce: true }, 'text/html', "img-src 'self'"],
    ['without HTML', { cspNonce: true }, 'text/x-component', "script-src 'self'"],
  ] as const)('keeps ordinary HEAD metadata %s', async (_name, settings, type, policy) => {
    const { response, body } = await routed('HEAD', answer('HEAD', policy, type), settings);

    expect(body).toBe('');
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL);
    expect(response.headers.get(CSP)).toBe(policy);
    expect(response.headers.get('etag')).toBe('"saved"');
  });

  it('does not attach an unrelated policy to a HEAD 304', async () => {
    const { response, body } = await routed(
      'HEAD',
      new Response(null, {
        status: 304,
        headers: {
          'content-type': 'text/html',
          [CSP]: "script-src 'self'",
          'cache-control': CACHE_CONTROL,
        },
      }),
      { cspNonce: true },
    );

    expect(response.status).toBe(304);
    expect(body).toBe('');
    expect(response.headers.has(CSP)).toBe(false);
    expect(response.headers.has(REPORT_ONLY)).toBe(false);
  });
});
