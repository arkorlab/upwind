import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import type { EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeGates } from '../src/edge-host.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const ROUTE = '/posts/[slug]';
const GATE = 'checker';
const CSP = 'content-security-policy';
const REPORT_ONLY = 'content-security-policy-report-only';
const KEPT_NONCE = 'a';
const PART = `<html><script nonce="${KEPT_NONCE}">1</script></html>`;
const TAIL = '<p>whole document tail</p>';
const WHOLE = PART + TAIL;
const PART_BYTES = new TextEncoder().encode(PART).byteLength;
const WHOLE_BYTES = new TextEncoder().encode(WHOLE).byteLength;
const RANGE = `bytes=0-${PART_BYTES - 1}`;
const CONTENT_RANGE = `bytes 0-${PART_BYTES - 1}/${WHOLE_BYTES}`;
const ETAG = '"kept"';

interface Scenario {
  readonly method?: 'GET' | 'HEAD';
  readonly settings: Partial<EdgePointer>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly pass?: boolean;
}

/** A gate honoring a valid range of its saved bytes, asked through the actual edge route. */
async function routed(test: Scenario) {
  const { pointer } = await seedSite({
    document: pprDocument(),
    pathname: ROUTE,
    dynamicRoutes: [{ sourceRegex: '^/posts/(?<slug>[^/]+?)(?:/)?$', route: ROUTE, gated: ROUTE }],
    gates: { [ROUTE]: GATE },
    gatedPathnames: { [ROUTE]: ROUTE },
  });
  const asked: Headers[] = [];
  const downstream: Headers[] = [];
  const gates: EdgeGates = {
    answer: (_name, request) => {
      asked.push(new Headers(request.headers));
      if (test.pass === true)
        return Promise.resolve(
          new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } }),
        );
      const partial = request.method === 'GET' && request.headers.get('range') === RANGE;
      const rsc = request.headers.get('rsc') === '1';
      const selected = partial ? PART : WHOLE;
      const body = request.method === 'HEAD' ? null : selected;
      return Promise.resolve(
        new Response(body, {
          status: partial ? 206 : 200,
          headers: {
            'content-type': rsc ? 'text/x-component' : 'text/html',
            [CSP]: `script-src 'self' 'nonce-${KEPT_NONCE}'`,
            'cache-control': 'private, max-age=60',
            'content-length': String(partial ? PART_BYTES : WHOLE_BYTES),
            etag: ETAG,
            ...(partial && { 'content-range': CONTENT_RANGE }),
          },
        }),
      );
    },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_deployment, request) => {
      downstream.push(new Headers(request.headers));
      return Promise.resolve(
        new Response('downstream', { headers: { 'content-type': 'text/plain' } }),
      );
    },
  });
  const request = navigation('/posts/abc', {
    method: test.method ?? 'GET',
    headers: test.headers ?? {},
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host: { ...standaloneHost(env), gates },
    pointer: { ...pointer, ...test.settings },
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, asked, downstream };
}

const modes = [
  ['enforce', CSP],
  ['report-only', REPORT_ONLY],
] as const;

describe('nonce-bearing terminal gate ranges', () => {
  it.each(modes)('asks for a whole document under %s', async (mode, policy) => {
    const { response, body, asked, downstream } = await routed({
      settings: { cspNonce: true, cspNonceMode: mode },
      headers: { range: RANGE, 'if-range': ETAG, 'if-none-match': ETAG },
    });
    const nonce = /'nonce-([^']+)'/u.exec(response.headers.get(policy) ?? '')?.[1];

    expect(response.status).toBe(200);
    expect([
      response.headers.has('content-range'),
      response.headers.has('content-length'),
    ]).toStrictEqual([false, false]);
    expect(asked).toHaveLength(1);
    expect(downstream).toStrictEqual([]);
    expect(['range', 'if-range', 'if-none-match'].map((name) => asked[0]?.get(name))).toStrictEqual(
      [null, null, null],
    );
    expect(nonce).toBeDefined();
    expect(body).toContain(`nonce="${nonce ?? ''}"`);
    expect(body).toContain(TAIL);
  });

  it('treats RSC values other than one as documents', async () => {
    const { response, body, asked } = await routed({
      settings: { cspNonce: true },
      headers: { range: RANGE, 'if-range': ETAG, rsc: '0' },
    });

    expect(response.status).toBe(200);
    expect(asked[0]?.get('range')).toBeNull();
    expect(asked[0]?.get('if-range')).toBeNull();
    expect(body).toContain(TAIL);
  });

  it('preserves an ordinary gate range without nonce opt-in', async () => {
    const { response, body, asked } = await routed({
      settings: {},
      headers: { range: RANGE, 'if-range': ETAG },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(CONTENT_RANGE);
    expect(body).toBe(PART);
    expect(asked[0]?.get('range')).toBe(RANGE);
    expect(asked[0]?.get('if-range')).toBe(ETAG);
  });

  it('preserves a payload gate range under nonce opt-in', async () => {
    const { response, body, asked } = await routed({
      settings: { cspNonce: true },
      headers: { range: RANGE, 'if-range': ETAG, rsc: '1' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(CONTENT_RANGE);
    expect(body).toBe(PART);
    expect(asked[0]?.get('range')).toBe(RANGE);
    expect(asked[0]?.get('if-range')).toBe(ETAG);
  });

  it('keeps an ordinary full nonce GET complete', async () => {
    const { response, body, asked } = await routed({ settings: { cspNonce: true } });

    expect(response.status).toBe(200);
    expect(response.headers.has('content-range')).toBe(false);
    expect(body).toContain(TAIL);
    expect(asked).toHaveLength(1);
  });

  it('keeps nonce HEAD empty and uncacheable', async () => {
    const { response, body, asked } = await routed({
      method: 'HEAD',
      settings: { cspNonce: true },
      headers: { range: RANGE, 'if-range': ETAG },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body).toBe('');
    expect(asked).toHaveLength(1);
  });

  it('keeps the visitor range after a gate passes', async () => {
    const { response, body, asked, downstream } = await routed({
      settings: { cspNonce: true },
      headers: { range: RANGE, 'if-range': ETAG },
      pass: true,
    });

    expect(response.status).toBe(200);
    expect(body).toBe('downstream');
    expect(asked).toHaveLength(1);
    expect(downstream).toHaveLength(1);
    expect(downstream[0]?.get('range')).toBe(RANGE);
    expect(downstream[0]?.get('if-range')).toBe(ETAG);
  });
});
