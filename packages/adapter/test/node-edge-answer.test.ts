import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { edgeEntrySource } from '../src/edge.ts';
import { NODE_EDGE_ANSWER_SOURCE, NODE_EDGE_ANSWER_WRAPPER } from '../src/node-edge-answer.ts';

/**
 * An Edge entrypoint's answer as the Node.js server sends it: through the entry module the adapter
 * writes for that server, whose handlers are wrapped as they are loaded, and the server itself, read
 * on a kept connection as an HTTP/1.1 proxy in front of it reads one.
 */

const TOKEN = 'synthetic-node-control-token-with-32-bytes';
const CONFIGURATION = JSON.stringify({
  v: 1,
  deploymentId: 'synthetic-deployment',
  functionName: 'app',
  controlToken: TOKEN,
  capabilities: { services: {} },
});
const ENTRY_KEY = 'middleware_app/api/edge/route';
const HANDLER_GLOBAL = 'upwindTestEdgeHandler';
const SMUGGLED = 'HTTP/1.1 200 OK\r\ncontent-length: 8\r\n\r\ninjected';
const NO_BODY_STATUSES = new Set([204, 304]);
const HEX = 16;

type EdgeHandler = (request: Request, ctx: unknown) => Promise<Response>;

interface EdgeTable {
  readonly entries: Readonly<Record<string, () => { readonly handler: EdgeHandler }>>;
}

interface NodeContainerServer {
  readonly port: number;
  readonly close: () => Promise<boolean>;
}

/**
 * The part of the runtime's Node.js server this suite starts, loaded by its path as the build's
 * `server.mjs` loads it: the module's own types reach the runtime's workerd modules, which the
 * adapter's types do not declare.
 */
interface NodeContainerModule {
  readonly startNodeContainer: (options: {
    readonly port: number;
    readonly entry: {
      readonly fetch: (request: Request, env: unknown, context: unknown) => Promise<Response>;
    };
  }) => Promise<NodeContainerServer>;
}

const CONTAINER_MODULE = fileURLToPath(
  import.meta.resolve('@stayingupwind/runtime/node-container'),
);

/**
 * A decoded body whose prefix is exactly as long as its gzip encoding, so a reader that honours the
 * encoded length takes the prefix as the whole body and reads the rest as another answer.
 */
function smuggling(): { readonly decoded: Buffer; readonly encoded: Buffer } {
  let prefix = '';
  for (let round = 0; round < 10; round += 1) {
    const length = gzipSync(prefix + SMUGGLED).byteLength;
    if (length === prefix.length) break;
    prefix = 'A'.repeat(length);
  }
  const decoded = Buffer.from(prefix + SMUGGLED);
  return { decoded, encoded: gzipSync(decoded) };
}

interface WireAnswer {
  readonly status: string;
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly body: string;
}

/** One kept connection: each answer read by the framing it declares, and what follows as the next. */
class Connection {
  static async open(port: number): Promise<Connection> {
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new Connection(socket);
  }

  readonly #socket: Socket;
  #received = Buffer.alloc(0);
  #closed = false;
  #wake: (() => void) | undefined;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.#received = Buffer.concat([this.#received, chunk]);
      this.#wake?.();
    });
    socket.on('close', () => {
      this.#closed = true;
      this.#wake?.();
    });
  }

  async #until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.#closed) throw new Error('connection closed before the answer was whole');
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  async #take(length: number): Promise<string> {
    await this.#until(() => this.#received.byteLength >= length);
    const taken = this.#received.subarray(0, length).toString();
    this.#received = this.#received.subarray(length);
    return taken;
  }

  async #through(delimiter: string): Promise<string> {
    await this.#until(() => this.#received.includes(delimiter));
    const end = this.#received.indexOf(delimiter);
    const taken = await this.#take(end + delimiter.length);
    return taken.slice(0, end);
  }

  async #chunked(): Promise<string> {
    let body = '';
    for (;;) {
      const size = Number.parseInt(await this.#through('\r\n'), HEX);
      if (size === 0) {
        await this.#through('\r\n');
        return body;
      }
      body += await this.#take(size);
      await this.#through('\r\n');
    }
  }

  /** Requests written back to back, the last asking the server to close after its answer. */
  send(requests: readonly (readonly [method: string, path: string])[]): void {
    const wire = requests.map(([method, pathname], index) => {
      const close = index === requests.length - 1 ? 'connection: close\r\n' : '';
      return [
        `${method} ${pathname} HTTP/1.1`,
        'host: framing.test',
        `x-upwind-control-token: ${TOKEN}`,
        `x-upwind-request-url: https://framing.test${pathname}`,
        `${close}\r\n`,
      ].join('\r\n');
    });
    this.#socket.write(wire.join(''));
  }

  async answer(method: string): Promise<WireAnswer> {
    const head = (await this.#through('\r\n\r\n')).split('\r\n');
    const headers = new Map<string, string[]>();
    for (const line of head.slice(1)) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon).toLowerCase();
      headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
    }
    const status = head[0] ?? '';
    const code = Number(status.split(' ', 2)[1]);
    let body = '';
    if (method !== 'HEAD' && !NO_BODY_STATUSES.has(code)) {
      body =
        headers.get('transfer-encoding')?.includes('chunked') === true
          ? await this.#chunked()
          : await this.#take(Number(headers.get('content-length')?.[0] ?? 0));
    }
    return { status, headers, body };
  }

  /** What the server wrote after the last answer, once it closed the connection. */
  async rest(): Promise<string> {
    await this.#until(() => this.#closed);
    return this.#received.toString();
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

/** What the Edge entrypoint answers, which each case sets: whatever Edge code would hand back. */
const edge: { answer: (request: Request) => Promise<Response> } = {
  answer: () => Promise.reject(new Error('no case set an answer')),
};

function second(): Promise<Response> {
  return Promise.resolve(new Response('second', { headers: { 'x-answer': 'second' } }));
}

/** The case's answer for any path but `/second`, which answers on its own. */
function answering(first: (request: Request) => Promise<Response>): void {
  edge.answer = (request) =>
    new URL(request.url).pathname === '/second' ? second() : first(request);
}

describe('an Edge entrypoint answering through the Node.js server', () => {
  let dir: string;
  let container: NodeContainerServer;
  const connections: Connection[] = [];
  const upstreams: Server[] = [];

  beforeAll(async () => {
    vi.stubEnv('ARKOR_NODE_RUNTIME', CONFIGURATION);
    dir = await mkdtemp(path.join(tmpdir(), 'adapter-node-edge-'));
    // A chunk as Turbopack writes one: it registers the entry, whose handler is the case's.
    const chunk = path.join(dir, 'route.js');
    await writeFile(
      chunk,
      `(globalThis._ENTRIES ||= {})[${JSON.stringify(ENTRY_KEY)}] = { handler: (request, ctx) => globalThis.${HANDLER_GLOBAL}(request, ctx) };\n`,
    );
    const module = path.join(dir, 'edge.cjs');
    const entry = {
      id: '/api/edge',
      entryKey: ENTRY_KEY,
      handlerExport: 'handler',
      files: [chunk],
      wasm: [],
      inlineAssets: [],
      env: {},
    };
    await writeFile(
      module,
      edgeEntrySource([entry], dir, path.join(dir, '.next'), {
        wrapper: { source: NODE_EDGE_ANSWER_SOURCE, name: NODE_EDGE_ANSWER_WRAPPER },
      }),
    );
    Reflect.set(globalThis, HANDLER_GLOBAL, (request: Request) => edge.answer(request));
    const { handler } = (createRequire(module)(module) as EdgeTable).entries['/api/edge']!();
    const { startNodeContainer } = (await import(CONTAINER_MODULE)) as NodeContainerModule;
    container = await startNodeContainer({
      port: 0,
      entry: { fetch: (request, _env, context) => handler(request, context) },
    });
  });

  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.destroy();
    await Promise.all(
      upstreams.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => {
          server.close(resolve);
        });
      }),
    );
  });

  afterAll(async () => {
    await container.close();
    await rm(dir, { recursive: true, force: true });
    Reflect.deleteProperty(globalThis, HANDLER_GLOBAL);
    Reflect.deleteProperty(globalThis, '_ENTRIES');
    vi.unstubAllEnvs();
  });

  async function open(): Promise<Connection> {
    const connection = await Connection.open(container.port);
    connections.push(connection);
    return connection;
  }

  it('frames a fetched gzip answer by the decoded body it writes, so the next request gets its own', async () => {
    const { decoded, encoded } = smuggling();
    // An origin that compresses its answer and names its encoded length, as one should.
    const upstream = createServer((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': String(encoded.byteLength),
      });
      response.end(encoded);
    });
    upstreams.push(upstream);
    upstream.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => {
      upstream.once('listening', resolve);
    });
    const { port } = upstream.address() as AddressInfo;
    // Node's Fetch decodes the body and keeps the headers it arrived with, encoded length included.
    answering(() => fetch(`http://127.0.0.1:${String(port)}/`));
    const connection = await open();
    connection.send([
      ['GET', '/proxy'],
      ['GET', '/second'],
    ]);

    const proxied = await connection.answer('GET');
    const next = await connection.answer('GET');

    expect({
      status: proxied.status,
      encoding: proxied.headers.get('content-encoding'),
      length: proxied.headers.get('content-length'),
      body: proxied.body,
    }).toStrictEqual({
      status: 'HTTP/1.1 200 OK',
      encoding: undefined,
      length: undefined,
      body: decoded.toString(),
    });
    expect({ answer: next.headers.get('x-answer'), body: next.body }).toStrictEqual({
      answer: ['second'],
      body: 'second',
    });
    await expect(connection.rest()).resolves.toBe('');
  });

  it('keeps cookies and ordinary headers while leaving the framing to Node', async () => {
    answering(() => {
      const headers = new Headers({
        'content-encoding': 'gzip',
        'content-length': '2',
        'x-kept': 'yes',
      });
      headers.append('set-cookie', 'one=1; Path=/');
      headers.append('set-cookie', 'two=2; Path=/');
      return Promise.resolve(new Response('decoded body', { status: 201, headers }));
    });
    const connection = await open();
    connection.send([
      ['GET', '/cookies'],
      ['GET', '/second'],
    ]);

    const answered = await connection.answer('GET');
    const next = await connection.answer('GET');

    expect({
      status: answered.status,
      kept: answered.headers.get('x-kept'),
      cookies: answered.headers.get('set-cookie'),
      encoding: answered.headers.get('content-encoding'),
      length: answered.headers.get('content-length'),
      body: answered.body,
    }).toStrictEqual({
      status: 'HTTP/1.1 201 Created',
      kept: ['yes'],
      cookies: ['one=1; Path=/', 'two=2; Path=/'],
      encoding: undefined,
      length: undefined,
      body: 'decoded body',
    });
    expect(next.body).toBe('second');
    await expect(connection.rest()).resolves.toBe('');
  });

  it('ends a bodyless answer that names a length without waiting on bytes that never come', async () => {
    answering(() => {
      return Promise.resolve(
        new Response(null, { headers: { 'content-encoding': 'gzip', 'content-length': '5' } }),
      );
    });
    const connection = await open();
    connection.send([
      ['GET', '/empty'],
      ['GET', '/second'],
    ]);

    const empty = await connection.answer('GET');
    const next = await connection.answer('GET');

    expect({ length: empty.headers.get('content-length'), body: empty.body }).toStrictEqual({
      length: undefined,
      body: '',
    });
    expect({ status: next.status, body: next.body }).toStrictEqual({
      status: 'HTTP/1.1 200 OK',
      body: 'second',
    });
    await expect(connection.rest()).resolves.toBe('');
  });

  it.each([
    ['no body', null],
    ['a body', 'never sent'],
  ])('answers HEAD carrying %s with headers alone, and keeps the connection', async (_, body) => {
    answering(() => {
      return Promise.resolve(
        new Response(body, {
          headers: { 'content-encoding': 'gzip', 'content-length': '123', 'x-kept': 'yes' },
        }),
      );
    });
    const connection = await open();
    connection.send([
      ['HEAD', '/head'],
      ['GET', '/second'],
    ]);

    const head = await connection.answer('HEAD');
    const next = await connection.answer('GET');

    expect({
      status: head.status,
      kept: head.headers.get('x-kept'),
      encoding: head.headers.get('content-encoding'),
      length: head.headers.get('content-length'),
    }).toStrictEqual({
      status: 'HTTP/1.1 200 OK',
      kept: ['yes'],
      encoding: undefined,
      length: undefined,
    });
    expect(next.body).toBe('second');
    await expect(connection.rest()).resolves.toBe('');
  });

  it('streams a body as it is written, before the stream ends', async () => {
    const release = Promise.withResolvers<undefined>();
    answering(() => {
      const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          controller.enqueue(new TextEncoder().encode('first'));
          await release.promise;
          controller.enqueue(new TextEncoder().encode('last'));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { 'content-encoding': 'gzip', 'content-length': '3' } }),
      );
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(container.port)}/stream`, {
        headers: {
          'x-upwind-control-token': TOKEN,
          'x-upwind-request-url': 'https://framing.test/stream',
        },
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      release.resolve(undefined);
      const rest: string[] = [];
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        rest.push(new TextDecoder().decode(read.value));
      }

      expect(new TextDecoder().decode(first.value)).toBe('first');
      expect(rest.join('')).toBe('last');
    } finally {
      release.resolve(undefined);
    }
  });

  it('hands on as it is an answer that carries none of the three', async () => {
    const plain = new Response('plain', { headers: { 'x-kept': 'yes' } });
    answering(() => Promise.resolve(plain));
    const module = path.join(dir, 'edge.cjs');
    const { handler } = (createRequire(module)(module) as EdgeTable).entries['/api/edge']!();

    await expect(handler(new Request('https://framing.test/plain'), {})).resolves.toBe(plain);
  });
});
