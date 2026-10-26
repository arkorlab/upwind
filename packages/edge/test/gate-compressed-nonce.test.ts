import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeGates } from '../src/edge-host.ts';
import { compressLive } from '../src/handlers/live-compression.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const ROUTE = '/posts/[slug]';
const PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const POLICY = 'content-security-policy';
const HTML = '<html><script nonce="kept">1</script><p>whole tail</p></html>';
const CODINGS = ['gzip', 'br'] as const;

/** Encoded HTML from the same streaming compressor available in the Workers runtime. */
function compressed(coding: (typeof CODINGS)[number]): ReadableStream<Uint8Array> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(HTML));
      controller.close();
    },
  });
  return compressLive(body, coding);
}

/** A terminal encoded gate response, preserved as the local transport hands it to the edge. */
async function routed(
  coding: (typeof CODINGS)[number],
  options: { nonce?: boolean; payload?: boolean; pass?: boolean; html?: boolean } = {},
) {
  const { pointer } = await seedSite({
    document: pprDocument(),
    pathname: ROUTE,
    dynamicRoutes: [{ sourceRegex: PATTERN, route: ROUTE, gated: ROUTE }],
    gates: { [ROUTE]: 'checker' },
    gatedPathnames: { [ROUTE]: ROUTE },
  });
  const asked: Headers[] = [];
  const downstream: string[] = [];
  const gates: EdgeGates = {
    answer: (_name, request) => {
      asked.push(new Headers(request.headers));
      const identity = request.headers.get('accept-encoding') === 'identity';
      const body = identity ? HTML : compressed(coding);
      const headers = new Headers({
        'content-type':
          options.payload === true && options.html !== true
            ? 'text/x-component'
            : 'text/html; charset=utf-8',
        [POLICY]: "script-src 'self' 'nonce-kept'",
      });
      if (!identity) headers.set('content-encoding', coding);
      if (options.pass === true) headers.set(GATE_ANSWER_HEADER, GATE_PASS);
      return Promise.resolve(
        new Response(body, {
          encodeBody: 'manual',
          headers,
        }),
      );
    },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_deployment, request) => {
      downstream.push(request.headers.get('accept-encoding') ?? '');
      return Promise.resolve(new Response('unexpected'));
    },
  });
  const headers = new Headers({ 'accept-encoding': 'gzip, br' });
  if (options.payload === true) headers.set('rsc', '1');
  if (options.pass === true) headers.set('range', 'bytes=0-20');
  const request = navigation('/posts/abc', { headers });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host: { ...standaloneHost(env), gates },
    pointer: { ...pointer, cspNonce: options.nonce !== false },
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, asked, downstream };
}

describe('nonce rewriting of compressed terminal gate documents', () => {
  it.each(CODINGS)('stamps the %s document with its response policy nonce', async (coding) => {
    const { response, body, asked, downstream } = await routed(coding);
    const nonce = /'nonce-([^']+)'/u.exec(response.headers.get(POLICY) ?? '')?.[1];

    expect(nonce).toBeDefined();
    expect(nonce).not.toBe('kept');
    expect(body).toContain(`nonce="${nonce ?? ''}"`);
    expect(body).toContain('<p>whole tail</p>');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.get('accept-encoding')).toBe('identity');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(downstream).toStrictEqual([]);
  });

  it.each(CODINGS)('stamps an HTML terminal answer to a %s payload request', async (coding) => {
    const { response, body, asked, downstream } = await routed(coding, {
      payload: true,
      html: true,
    });
    const nonce = /'nonce-([^']+)'/u.exec(response.headers.get(POLICY) ?? '')?.[1];

    expect(nonce).toBeDefined();
    expect(nonce).not.toBe('kept');
    expect(body).toContain(`nonce="${nonce ?? ''}"`);
    expect(body).toContain('<p>whole tail</p>');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.get('accept-encoding')).toBe('identity');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(downstream).toStrictEqual([]);
  });

  it.each(CODINGS)('retains %s negotiation when nonce mode is disabled', async (coding) => {
    const { response, asked, downstream } = await routed(coding, { nonce: false });

    expect(asked[0]?.get('accept-encoding')).toBe('gzip, br');
    expect(response.headers.get('content-encoding')).toBe(coding);
    expect(response.headers.get(POLICY)).toBe("script-src 'self' 'nonce-kept'");
    expect(downstream).toStrictEqual([]);
  });

  it.each(CODINGS)('requests identity before inspecting a %s payload answer', async (coding) => {
    const { response, asked, downstream } = await routed(coding, { payload: true });

    expect(asked[0]?.get('accept-encoding')).toBe('identity');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get(POLICY)).toBe("script-src 'self' 'nonce-kept'");
    expect(downstream).toStrictEqual([]);
  });

  it.each(CODINGS)(
    'keeps the original visitor negotiation after a %s gate passes',
    async (coding) => {
      const { downstream } = await routed(coding, { pass: true });

      expect(downstream).toStrictEqual(['gzip, br']);
    },
  );
});
