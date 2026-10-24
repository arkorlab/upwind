// eslint-disable-next-line no-restricted-imports, import-x/no-nodejs-modules -- the Workers compatibility module creates and reads the gate's saved encoded fixture bytes.
import { brotliCompressSync, brotliDecompressSync, deflateSync, gzipSync } from 'node:zlib';

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
const LARGE_COPIES = 64;
const DENIED_STATUS = 403;
const UNAVAILABLE_STATUS = 503;

type Coding = 'br' | 'gzip' | 'deflate' | 'identity';

/** A terminal gate remains one gate request, with no application, blob or authority dispatch. */
async function routed(
  method: 'GET' | 'HEAD',
  gateAnswer: Response,
  settings: Partial<EdgePointer>,
) {
  const { pointer } = await seedSite({
    document: pprDocument(),
    pathname: POST,
    dynamicRoutes: [{ sourceRegex: POST_PATTERN, route: POST, gated: POST }],
    gates: { [POST]: GATE },
    gatedPathnames: { [POST]: POST },
  });
  const asked: string[] = [];
  const functionAsked: string[] = [];
  const otherAsked: string[] = [];
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
    fetchImpl: () => {
      otherAsked.push('fetch');
      return Promise.resolve(new Response('unexpected fetch'));
    },
    blobWorker: () => {
      otherAsked.push('blob');
      return Promise.resolve(new Response('unexpected blob request'));
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
    host: {
      ...standaloneHost(env),
      gates,
      currentRecord: () => {
        otherAsked.push('authority');
        return Promise.resolve(undefined);
      },
    },
    pointer: { ...pointer, ...settings },
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);

  expect(asked).toStrictEqual([method]);
  expect(functionAsked).toStrictEqual([]);
  expect(otherAsked).toStrictEqual([]);

  return { response, bytes };
}

function savedDocument(copies = 1): string {
  return `<html><script nonce="${KEPT_NONCE}">1</script></html>`.repeat(copies);
}

/** Codings are applied in header order, so a receiver removes them from right to left. */
function encoded(document: string, codings: readonly Coding[]): Uint8Array {
  let bytes: Uint8Array = new TextEncoder().encode(document);
  for (const coding of codings) {
    switch (coding) {
      case 'br': {
        bytes = Uint8Array.from(brotliCompressSync(bytes));
        break;
      }
      case 'gzip': {
        bytes = Uint8Array.from(gzipSync(bytes));
        break;
      }
      case 'deflate': {
        bytes = Uint8Array.from(deflateSync(bytes));
        break;
      }
      case 'identity': {
        break;
      }
    }
  }
  return bytes;
}

/** Both old encoded answers and the new decoded answers are read as a browser reads their coding. */
async function documentBytes(bytes: Uint8Array, header: string | null): Promise<string> {
  let decoded = bytes;
  const codings = header === null ? [] : header.split(',').toReversed();
  for (const coding of codings) {
    const name = coding.trim().toLowerCase();
    if (name === 'br') decoded = Uint8Array.from(brotliDecompressSync(decoded));
    else if (name === 'gzip' || name === 'deflate') {
      const source = new Response(decoded).body;
      if (source === null) throw new Error('the encoded fixture has no body');
      const stream = source.pipeThrough(new DecompressionStream(name));
      const buffer = await new Response(stream).arrayBuffer();
      decoded = new Uint8Array(buffer);
    }
  }
  return new TextDecoder().decode(decoded);
}

function policyNonce(response: Response, header = CSP): string | undefined {
  return /'nonce-([^']+)'/u.exec(response.headers.get(header) ?? '')?.[1];
}

/** One-byte input fragments exercise decoder state without waiting for the complete response. */
function fragments(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at === bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at = Math.min(at + size, bytes.byteLength);
    },
  });
}

function answer(body: BodyInit | null, encoding: string, type = 'text/html'): Response {
  return new Response(body, {
    encodeBody: 'manual',
    headers: {
      'content-type': type,
      'content-encoding': encoding,
      [CSP]: `script-src 'nonce-${KEPT_NONCE}'`,
      'cache-control': CACHE_CONTROL,
      etag: '"saved"',
    },
  });
}

const CASES = [
  { id: 'gzip/1', codings: ['gzip'], copies: 1 },
  { id: 'gzip/64', codings: ['gzip'], copies: LARGE_COPIES },
  { id: 'br/1', codings: ['br'], copies: 1 },
  { id: 'br/64', codings: ['br'], copies: LARGE_COPIES },
  { id: 'deflate/64', codings: ['deflate'], copies: LARGE_COPIES },
  { id: 'gzip then br', codings: ['gzip', 'br'], copies: LARGE_COPIES },
  { id: 'br then gzip', codings: ['br', 'gzip'], copies: LARGE_COPIES },
  { id: 'two br layers', codings: ['br', 'br'], copies: LARGE_COPIES },
  { id: 'fragmented br', codings: ['br'], copies: LARGE_COPIES, piece: 1 },
  { id: 'fragmented gzip', codings: ['gzip'], copies: LARGE_COPIES, piece: 1 },
] as const;

describe('encoded terminal gate HTML nonce', () => {
  it.each(CASES)('stamps the policy nonce on $id', async (example) => {
    const saved = savedDocument(example.copies);
    const bytes = encoded(saved, example.codings);
    const body = 'piece' in example ? fragments(bytes, example.piece) : bytes;
    const { response, bytes: received } = await routed(
      'GET',
      answer(body, example.codings.join(', ')),
      { cspNonce: true },
    );
    const nonce = policyNonce(response);
    const document = await documentBytes(received, response.headers.get('content-encoding'));

    expect(response.status).toBe(200);
    expect(nonce).toBeDefined();
    expect(nonce).not.toBe(KEPT_NONCE);
    expect(document).toContain(`nonce="${nonce ?? ''}"`);
    expect(document).not.toContain(`nonce="${KEPT_NONCE}"`);
  });

  it('decodes a denied document and report-only policy without changing the denial', async () => {
    const gateAnswer = answer(encoded(savedDocument(), ['br']), 'br');
    const denied = new Response(gateAnswer.body, {
      status: DENIED_STATUS,
      headers: gateAnswer.headers,
      encodeBody: 'manual',
    });
    const { response, bytes } = await routed('GET', denied, {
      cspNonce: true,
      cspNonceMode: 'report-only',
    });
    const nonce = policyNonce(response, REPORT_ONLY);
    const document = await documentBytes(bytes, response.headers.get('content-encoding'));

    expect(response.status).toBe(DENIED_STATUS);
    expect(nonce).toBeDefined();
    expect(nonce).not.toBe(KEPT_NONCE);
    expect(document).toContain(`nonce="${nonce ?? ''}"`);
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.has('etag')).toBe(false);
  });

  it.each(['gzip', 'br'] as const)(
    'keeps encoded bytes and policy under nonce opt-out for %s',
    async (coding) => {
      const saved = savedDocument();
      const bytes = encoded(saved, [coding]);
      const { response, bytes: received } = await routed('GET', answer(bytes, coding), {});

      expect(received).toStrictEqual(bytes);
      expect(response.headers.get('content-encoding')).toBe(coding);
      expect(policyNonce(response)).toBe(KEPT_NONCE);
      expect(response.headers.get('etag')).toBe('"saved"');
    },
  );

  it.each([
    { id: 'without a script policy', type: 'text/html', policy: "img-src 'self'" },
    { id: 'without HTML', type: 'text/plain', policy: `script-src 'nonce-${KEPT_NONCE}'` },
  ])('keeps encoded bytes $id', async ({ type, policy }) => {
    const bytes = encoded(savedDocument(), ['gzip']);
    const gateAnswer = answer(bytes, 'gzip', type);
    gateAnswer.headers.set(CSP, policy);
    const { response, bytes: received } = await routed('GET', gateAnswer, { cspNonce: true });

    expect(received).toStrictEqual(bytes);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('etag')).toBe('"saved"');
  });

  it('keeps a bodyless HEAD fresh without decoded-body representation headers', async () => {
    const { response, bytes } = await routed('HEAD', answer(null, 'br'), { cspNonce: true });

    expect(bytes).toHaveLength(0);
    expect(policyNonce(response)).toBeDefined();
    expect(policyNonce(response)).not.toBe(KEPT_NONCE);
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.has('etag')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it.each(['zstd', 'gzip, unknown', 'gzip,'])(
    'refuses unsupported coding %s without falling through or retaining its body',
    async (coding) => {
      let sent = false;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.close();
          else {
            sent = true;
            controller.enqueue(new TextEncoder().encode(savedDocument()));
          }
        },
        cancel() {
          cancelled = true;
        },
      });
      const { response } = await routed('GET', answer(body, coding), { cspNonce: true });

      expect(response.status).toBe(UNAVAILABLE_STATUS);
      expect(response.headers.has('content-encoding')).toBe(false);
      expect(response.headers.has(CSP)).toBe(false);
      expect(cancelled).toBe(true);
    },
  );

  it('keeps unsupported coding opaque when nonce handling is off', async () => {
    const bytes = new TextEncoder().encode(savedDocument());
    const { response, bytes: received } = await routed('GET', answer(bytes, 'zstd'), {});

    expect(received).toStrictEqual(bytes);
    expect(response.headers.get('content-encoding')).toBe('zstd');
    expect(policyNonce(response)).toBe(KEPT_NONCE);
  });
});
