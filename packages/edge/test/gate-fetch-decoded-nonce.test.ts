import { gateBinding } from '@stayingupwind/host/bindings';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeGates } from '../src/edge-host.ts';
import { compressLive } from '../src/handlers/live-compression.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { isFetcher } from '../src/standalone/runtime.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const ROUTE = '/posts/[slug]';
const PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const GATE = 'checker';
const POLICY = 'content-security-policy';
const HTML = '<html><script nonce="kept">1</script><p>whole tail</p></html>';
const OK_STATUS = 200;

interface Case {
  readonly name: string;
  readonly coding: 'gzip' | 'br' | 'deflate' | 'gzip, br' | 'identity';
  readonly transport: 'fetch' | 'raw';
  readonly runtimeDecoded: boolean;
}

const CASES: readonly Case[] = [
  {
    name: 'a fetched gzip gate document is stamped after runtime decoding',
    coding: 'gzip',
    transport: 'fetch',
    runtimeDecoded: true,
  },
  {
    name: 'a fetched brotli gate document is stamped after runtime decoding',
    coding: 'br',
    transport: 'fetch',
    runtimeDecoded: true,
  },
  {
    name: 'a fetched deflate gate document keeps explicit decoding',
    coding: 'deflate',
    transport: 'fetch',
    runtimeDecoded: false,
  },
  {
    name: 'a fetched stacked coding keeps explicit decoding',
    coding: 'gzip, br',
    transport: 'fetch',
    runtimeDecoded: false,
  },
  {
    name: 'an injected raw gzip document keeps explicit decoding',
    coding: 'gzip',
    transport: 'raw',
    runtimeDecoded: false,
  },
  {
    name: 'an injected raw brotli document keeps explicit decoding',
    coding: 'br',
    transport: 'raw',
    runtimeDecoded: false,
  },
  {
    name: 'a fetched identity gate document keeps its plaintext body',
    coding: 'identity',
    transport: 'fetch',
    runtimeDecoded: true,
  },
];

/** The constructed-response boundary deliberately preserves its supplied compressed bytes. */
function rawAnswer(coding: Case['coding']): Response {
  if (coding !== 'gzip' && coding !== 'br') throw new Error('a raw control needs gzip or br');
  const body = new Response(HTML).body;
  if (body === null) throw new Error('the saved document has no body');
  return new Response(compressLive(body as ReadableStream<Uint8Array>, coding), {
    encodeBody: 'manual',
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': coding,
      [POLICY]: "script-src 'self' 'nonce-kept'",
      etag: '"saved"',
    },
  });
}

/** The default binding reaches a real auxiliary Worker; raw controls alone bypass that boundary. */
async function routed(row: Case) {
  const binding: unknown = Reflect.get(env, 'GATE_NONCE_FETCH');
  if (!isFetcher(binding)) throw new Error('the real gate fixture binding is missing');
  const probe =
    row.transport === 'fetch'
      ? await binding.fetch(
          new Request('https://gate.example/probe', {
            headers: { 'x-test-gate-coding': row.coding, 'accept-encoding': 'identity' },
          }),
        )
      : rawAnswer(row.coding);
  const native = {
    encoding: probe.headers.get('content-encoding'),
    bodyIsPlainHtml: (await probe.text()) === HTML,
  };
  const { pointer } = await seedSite({
    document: pprDocument(),
    pathname: ROUTE,
    dynamicRoutes: [{ sourceRegex: PATTERN, route: ROUTE, gated: ROUTE }],
    gates: { [ROUTE]: GATE },
    gatedPathnames: { [ROUTE]: ROUTE },
  });
  const downstream: string[] = [];
  const site = { ...env, [gateBinding(GATE)]: binding };
  const bound = standaloneHost(site);
  const raw: EdgeGates = { answer: () => Promise.resolve(rawAnswer(row.coding)) };
  const host = row.transport === 'fetch' ? bound : { ...bound, gates: raw };
  const runtime = standaloneRuntime(site, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_deployment, request) => {
      downstream.push(request.url);
      return Promise.resolve(new Response('unexpected downstream request'));
    },
  });
  const request = navigation('/posts/abc', {
    headers: { 'x-test-gate-coding': row.coding, 'accept-encoding': 'gzip, br' },
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env: site,
    ctx,
    runtime,
    host,
    pointer: { ...pointer, cspNonce: true },
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  let body: string | undefined;
  let readError: string | undefined;
  try {
    body = await response.text();
  } catch (error) {
    readError = String(error);
  }
  await waitOnExecutionContext(ctx);
  return { response, native, body, readError, downstream };
}

describe('gate nonce rewriting across the real Workers fetch boundary', () => {
  it.each(CASES)('$name', async (row) => {
    const { response, native, body, readError, downstream } = await routed(row);
    const nonce = /'nonce-([^']+)'/u.exec(response.headers.get(POLICY) ?? '')?.[1];

    expect(native).toStrictEqual({
      encoding: row.coding === 'identity' ? null : row.coding,
      bodyIsPlainHtml: row.runtimeDecoded,
    });
    expect(readError).toBeUndefined();
    expect({
      status: response.status,
      noncePresent: nonce !== undefined,
      retainedNonce: nonce === 'kept',
    }).toStrictEqual({
      status: OK_STATUS,
      noncePresent: true,
      retainedNonce: false,
    });
    expect(body).toContain(`nonce="${nonce ?? ''}"`);
    expect(body).toContain('<p>whole tail</p>');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.has('etag')).toBe(false);
    expect(downstream).toStrictEqual([]);
  });
});
