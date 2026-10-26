import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInThisContext } from 'node:vm';
import { brotliCompressSync, gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { EDGE_ANSWER_SOURCE, EDGE_ANSWER_WRAPPER } from '../src/native/edge-answer.ts';
import { NATIVE_EDGE_WEB_BINDING } from '../src/native/edge-web.ts';

type Context = Readonly<Record<string, unknown>>;
type Handler = (request: Request, ctx: Context) => Promise<unknown>;

/** The codings Node.js's Fetch decodes, of those the tests send (`edge-web.ts` lists them all). */
const CODINGS: ReadonlySet<string> = new Set(['br', 'gzip']);

/**
 * The bodies the Edge bundle's `fetch` noted as decoded (`edge-web.ts`): the test's to say, in place
 * of the object the bundle injects.
 */
const decoded = new WeakSet<ReadableStream>();

/** The wrapper as the native Edge bundle's entry module defines it. */
function edgeAnswer(handler: unknown): Handler {
  // eslint-disable-next-line sonarjs/code-eval -- This evaluates the adapter's own entry-module source, as the native Edge bundle runs it.
  const wrap = runInThisContext(
    `((${NATIVE_EDGE_WEB_BINDING}) => {\n${EDGE_ANSWER_SOURCE}\nreturn ${EDGE_ANSWER_WRAPPER};\n})`,
  ) as (web: unknown) => (handler: unknown) => Handler;
  return wrap({
    decodedBody: (body: ReadableStream | null) => body !== null && decoded.has(body),
    // As Node.js's Fetch decodes: the codings `edge-web.ts` lists, all of them or none.
    fetchDecodes: (header: string | null) => {
      const codings = header?.split(',') ?? [];
      return codings.length > 0 && codings.every((coding) => CODINGS.has(coding.trim()));
    },
  })(handler);
}

const REQUEST = new Request('http://localhost/api/proxy');
const BODY = 'decoded by fetch';

describe("the native Edge bundle's answers", () => {
  it('answers with a fetch passed on as it is, its body as Fetch decoded it', async () => {
    const encoded = brotliCompressSync(BODY);
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'br',
        'content-length': String(encoded.length),
      });
      response.end(encoded);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as AddressInfo;
      const handler = edgeAnswer(() => fetch(`http://127.0.0.1:${String(port)}/`));

      const answer = (await handler(REQUEST, {})) as Response;

      expect(answer.headers.get('content-encoding')).toBeNull();
      expect(answer.headers.get('content-length')).toBeNull();
      expect(answer.headers.get('content-type')).toBe('text/plain');
      await expect(answer.text()).resolves.toBe(BODY);
    } finally {
      server.close();
    }
  });

  it('keeps the coding of a fetch passed on as it is where Fetch does not decode it (Codex)', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'compress' });
      response.end(BODY);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as AddressInfo;
      const handler = edgeAnswer(() => fetch(`http://127.0.0.1:${String(port)}/`));

      const answer = (await handler(REQUEST, {})) as Response;

      expect(answer.headers.get('content-encoding')).toBe('compress');
      await expect(answer.text()).resolves.toBe(BODY);
    } finally {
      server.close();
    }
  });

  it('drops the coding of an answer made again of a body Fetch decoded', async () => {
    const fetched = new Response(BODY, { headers: { 'content-encoding': 'gzip' } });
    decoded.add(fetched.body!);
    const handler = edgeAnswer(() =>
      Promise.resolve(new Response(fetched.body, { status: 200, headers: fetched.headers })),
    );

    const answer = (await handler(REQUEST, {})) as Response;

    expect(answer.headers.has('content-encoding')).toBe(false);
    await expect(answer.text()).resolves.toBe(BODY);
  });

  it('drops how the body traveled, and keeps the rest', async () => {
    const handler = edgeAnswer(() => {
      return Promise.resolve(
        new Response(BODY, {
          status: 203,
          statusText: 'Non-Authoritative Information',
          headers: {
            'content-encoding': 'br',
            'content-length': '7',
            'transfer-encoding': 'chunked',
            'content-type': 'text/plain',
            'x-kept': 'yes',
          },
        }),
      );
    });

    const answer = (await handler(REQUEST, {})) as Response;

    expect(answer.status).toBe(203);
    expect(answer.statusText).toBe('Non-Authoritative Information');
    // The coding is the route's own, of bytes it made: it stays.
    expect([...answer.headers]).toStrictEqual([
      ['content-encoding', 'br'],
      ['content-type', 'text/plain'],
      ['x-kept', 'yes'],
    ]);
    await expect(answer.text()).resolves.toBe(BODY);
  });

  it('hands the usual answer on as it is', async () => {
    const plain = new Response(BODY, { headers: { 'content-type': 'text/plain' } });
    const handler = edgeAnswer(() => Promise.resolve(plain));

    await expect(handler(REQUEST, {})).resolves.toBe(plain);
  });

  it('keeps the coding of a body the route compressed itself, as it arrives deployed (Sentry)', async () => {
    const compressed = gzipSync(BODY);
    const handler = edgeAnswer(() => {
      return Promise.resolve(
        new Response(compressed, {
          headers: { 'content-encoding': 'gzip', 'content-length': String(compressed.length) },
        }),
      );
    });

    const answer = (await handler(REQUEST, {})) as Response;
    const bytes = new Uint8Array(await answer.arrayBuffer());

    expect(answer.headers.get('content-encoding')).toBe('gzip');
    expect(answer.headers.has('content-length')).toBe(false);
    expect(gunzipSync(bytes).toString()).toBe(BODY);
  });

  it('passes on what is not a response, and an export that is not a handler', async () => {
    const result = { response: new Response(BODY), waitUntil: Promise.resolve() };
    const handler = edgeAnswer(() => Promise.resolve(result));

    await expect(handler(REQUEST, {})).resolves.toBe(result);
    expect(edgeAnswer(undefined)).toBeUndefined();
  });

  it('hands the handler the request and context it was given', async () => {
    const ctx = { requestMeta: { probe: true } };
    const seen: unknown[] = [];
    const handler = edgeAnswer((request: Request, given: Context) => {
      seen.push(request, given);
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const answer = (await handler(REQUEST, ctx)) as Response;

    expect(seen).toStrictEqual([REQUEST, ctx]);
    expect(answer.status).toBe(204);
  });
});
