import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';

import type { Prerender } from '@stayingupwind/core/bundle';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { startNodeContainer } from '../src/node-container.ts';
import { serveRouteHandler } from '../src/outputs.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

// The route is answered from what the build recorded; nothing here reaches the Node bridge.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

const TOKEN = 'synthetic-node-control-token-with-32-bytes';
const CONFIGURATION = JSON.stringify({
  v: 1,
  deploymentId: 'synthetic-deployment',
  functionName: 'app',
  controlToken: TOKEN,
  capabilities: { services: {} },
});
const ROUTE = '/api/upstream';
const SMUGGLED = 'HTTP/1.1 200 OK\r\ncontent-length: 8\r\n\r\ninjected';
const HEX = 16;

/**
 * A decoded body whose prefix is exactly as long as its gzip encoding, so a reader that honours the
 * encoded length takes the prefix as the whole body and reads the rest as another answer.
 */
function smuggling(): { readonly decoded: Buffer; readonly encodedLength: number } {
  let prefix = '';
  for (let round = 0; round < 10; round += 1) {
    const length = gzipSync(prefix + SMUGGLED).byteLength;
    if (length === prefix.length) break;
    prefix = 'A'.repeat(length);
  }
  const decoded = Buffer.from(prefix + SMUGGLED);
  return { decoded, encodedLength: gzipSync(decoded).byteLength };
}

const { decoded, encodedLength } = smuggling();

/**
 * What `next build` records for a `force-static` route handler that answers with a `fetch` of a
 * gzip origin as it is: the bytes Node.js's Fetch decoded, under the headers they arrived with.
 */
const recorded: Prerender = {
  id: ROUTE,
  route: ROUTE,
  pathname: ROUTE,
  parentOutputId: ROUTE,
  groupId: 1,
  routeType: 'route',
  initialHeaders: {
    'content-type': 'text/plain; charset=utf-8',
    'content-encoding': 'gzip',
    'content-length': String(encodedLength),
    'x-kept': 'yes',
  },
  body: { sha256: 'b'.repeat(64), byteLength: decoded.byteLength, contentType: 'text/plain' },
};

const store = {
  manifest: {
    buildId: 'build-id',
    config: { basePath: '' },
    bypassToken: 'draft-token',
    entrypoints: [{ pathname: ROUTE, kind: 'app-route' }],
  },
  prerendersByPathname: new Map([[ROUTE, recorded]]),
  shellsByRoute: new Map(),
  readBlob: () => new Uint8Array(decoded),
} as unknown as Store;

const handler: NodeHandler = () => Promise.resolve();

function inputFor(request: Request): RoutedInput {
  return {
    app: { entries: { [ROUTE]: () => ({ handler }) } },
    edge: { entries: {} },
    request,
    initURL: request.url,
    run: (work) => work(),
    waitUntil: () => {
      // Nothing runs behind a build's own answer.
    },
  };
}

/** A request for `pathname` as the edge hands one to the Node.js server, the last closing it. */
function ask(pathname: string, last: boolean): string {
  return [
    `GET ${pathname} HTTP/1.1`,
    'host: fixture.test',
    `x-upwind-control-token: ${TOKEN}`,
    `x-upwind-request-url: https://fixture.test${pathname}`,
    ...(last ? ['connection: close'] : []),
    '\r\n',
  ].join('\r\n');
}

function answerRoute(request: Request): Promise<Response> {
  return serveRouteHandler(inputFor(request), store, { route: ROUTE, pathname: ROUTE, url: ROUTE });
}

/** Every answer in `wire`, each read by the framing it declares, as an HTTP/1.1 proxy reads them. */
function framedAnswers(wire: Buffer): { readonly head: string; readonly body: string }[] {
  const answers: { head: string; body: string }[] = [];
  let rest = wire;
  while (rest.byteLength > 0) {
    const end = rest.indexOf('\r\n\r\n');
    const head = rest.subarray(0, end === -1 ? rest.byteLength : end).toString();
    rest = end === -1 ? Buffer.alloc(0) : rest.subarray(end + 4);
    let body = '';
    if (/^transfer-encoding:\s*chunked$/imu.test(head)) {
      for (;;) {
        const line = rest.indexOf('\r\n');
        const size = Number.parseInt(rest.subarray(0, line).toString(), HEX);
        body += rest.subarray(line + 2, line + 2 + size).toString();
        rest = rest.subarray(line + 2 + size + 2);
        if (size === 0) break;
      }
    } else {
      const length = Number(/^content-length:\s*(\d+)$/imu.exec(head)?.[1] ?? 0);
      body = rest.subarray(0, length).toString();
      rest = rest.subarray(length);
    }
    answers.push({ head, body });
  }
  return answers;
}

describe("a route handler's recorded answer", () => {
  it('is answered without the coding and length the build recorded, its body whole', async () => {
    const response = await answerRoute(new Request(`https://fixture.test${ROUTE}`));

    expect({
      encoding: response.headers.get('content-encoding'),
      length: response.headers.get('content-length'),
      transfer: response.headers.get('transfer-encoding'),
      type: response.headers.get('content-type'),
      kept: response.headers.get('x-kept'),
      body: await response.text(),
    }).toStrictEqual({
      encoding: null,
      length: null,
      transfer: null,
      type: 'text/plain; charset=utf-8',
      kept: 'yes',
      body: decoded.toString(),
    });
  });

  describe('sent by the Node.js server on a kept connection', () => {
    let port: number;
    let close: () => Promise<boolean>;

    beforeAll(async () => {
      vi.stubEnv('ARKOR_NODE_RUNTIME', CONFIGURATION);
      const server = await startNodeContainer({
        port: 0,
        entry: {
          fetch: (request) => {
            return new URL(request.url).pathname === '/second'
              ? Promise.resolve(new Response('second'))
              : answerRoute(request);
          },
        },
      });
      port = server.port;
      close = server.close;
    });

    afterAll(async () => {
      await close();
      vi.unstubAllEnvs();
    });

    it('frames the body it writes, so the next request gets its own answer', async () => {
      const socket = connect(port, '127.0.0.1');
      const received: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
      });
      const closed = new Promise<void>((resolve) => {
        socket.once('close', () => {
          resolve();
        });
      });
      // Back to back on one connection, as a proxy that keeps it sends them.
      socket.write(ask(ROUTE, false) + ask('/second', true));
      await closed;

      const answers = framedAnswers(Buffer.concat(received));

      expect(answers.map((answer) => answer.body)).toStrictEqual([decoded.toString(), 'second']);
      expect(answers[0]?.head).not.toMatch(/^content-(?:encoding|length):/imu);
    });
  });
});
