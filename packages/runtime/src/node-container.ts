import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { nodeFunctionEnv, nodeRuntimeConfiguration } from './node-bindings.ts';
import { changesSomething, closeNodeHttpBridge } from './node-http-bridge.ts';
import {
  messageHeaders,
  messageRequest,
  removeNodeControlHeaders,
  sendWebResponse,
} from './node-http.ts';
import { NodeLifetime, type NodeTaskSnapshot } from './node-lifetime.ts';

const CONTROL_HEADER = 'x-upwind-control-token';
const URL_HEADER = 'x-upwind-request-url';
const CONTAINER_PORT = 8080;
const DRAIN_MS = 30_000;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_UNAVAILABLE = 503;

export interface NodeContainerEntry {
  fetch(
    request: Request,
    env: unknown,
    // v1 explicitly refuses native resource bindings and their private resourceWarm invocations.
    // There is no client-controlled props envelope to silently reinterpret or discard.
    context: {
      readonly waitUntil: (promise: Promise<unknown>) => void;
      readonly props?: undefined;
    },
  ): Promise<Response>;
}

export interface NodeContainerServer {
  readonly port: number;
  readonly snapshot: () => NodeTaskSnapshot;
  readonly close: () => Promise<boolean>;
}

function authorized(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function publicUrl(raw: string | string[] | undefined): URL | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function control(
  request: IncomingMessage,
  response: ServerResponse,
  lifetime: NodeLifetime,
): Promise<void> {
  if (request.method === 'GET' && request.url === '/__upwind/ready') {
    json(response, HTTP_OK, { v: 1, ready: true });
  } else if (request.method === 'GET' && request.url === '/__upwind/tasks') {
    json(response, HTTP_OK, { v: 1, ...lifetime.snapshot() });
  } else if (request.method === 'POST' && request.url === '/__upwind/drain') {
    const drained = await lifetime.drain(DRAIN_MS);
    json(response, drained ? HTTP_OK : HTTP_UNAVAILABLE, { v: 1, drained, ...lifetime.snapshot() });
  } else {
    response.writeHead(HTTP_NOT_FOUND).end();
  }
}

async function application(
  entry: NodeContainerEntry,
  request: IncomingMessage,
  response: ServerResponse,
  lifetime: NodeLifetime,
): Promise<void> {
  const url = publicUrl(request.headers[URL_HEADER]);
  if (url === undefined) {
    response.writeHead(HTTP_BAD_REQUEST).end();
    return;
  }
  if (lifetime.snapshot().draining) {
    response.writeHead(HTTP_UNAVAILABLE).end();
    return;
  }
  const end = lifetime.beginRequest();
  const abort = new AbortController();
  const disconnected = (): void => {
    if (
      !response.writableFinished &&
      (!changesSomething(request.method ?? 'GET') || !request.complete)
    ) {
      abort.abort();
    }
  };
  response.once('close', disconnected);
  request.once('aborted', disconnected);
  try {
    const headers = messageHeaders(request);
    removeNodeControlHeaders(headers);
    headers.set('host', url.host);
    const incoming = messageRequest(request, url.href, headers, abort.signal);
    const answer = await entry.fetch(incoming, nodeFunctionEnv(), {
      waitUntil: lifetime.waitUntil,
    });
    await sendWebResponse(answer, response);
  } finally {
    response.off('close', disconnected);
    request.off('aborted', disconnected);
    end();
  }
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

function exitAfterSignal(code: number): never {
  // eslint-disable-next-line unicorn/no-process-exit -- Only the Container's process-owned signal path exits; ordinary library close remains non-exiting.
  process.exit(code);
}

/** Import this module before importing the bundled Function, so broker fetch is native Node fetch. */
export async function startNodeContainer(
  options: (
    | { readonly entry: NodeContainerEntry }
    | { readonly loadEntry: () => Promise<NodeContainerEntry> }
  ) & { readonly port?: number },
): Promise<NodeContainerServer> {
  const config = nodeRuntimeConfiguration();
  // Consume private bootstrap environment before a Function or its hooks can evaluate.
  const entry = 'loadEntry' in options ? await options.loadEntry() : options.entry;
  const lifetime = new NodeLifetime();
  const server = createServer((request, response) => {
    if (!authorized(request.headers[CONTROL_HEADER], config.controlToken)) {
      response.writeHead(HTTP_FORBIDDEN).end();
      return;
    }
    // A public URL, even one spelling a control path, always belongs to the application.
    const work =
      request.headers[URL_HEADER] === undefined
        ? control(request, response, lifetime)
        : application(entry, request, response, lifetime);
    // eslint-disable-next-line unicorn/prefer-await -- node:http owns the response stream's lifetime.
    work.catch(() => {
      if (response.headersSent) response.destroy();
      else response.writeHead(HTTP_INTERNAL_ERROR).end('Internal Server Error');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? CONTAINER_PORT, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  let closing: Promise<boolean> | undefined;
  const close = (): Promise<boolean> => {
    closing ??= (async (): Promise<boolean> => {
      lifetime.startDraining();
      const drained = await lifetime.drain(DRAIN_MS);
      await closeHttpServer(server);
      await closeNodeHttpBridge();
      process.off('SIGTERM', terminate);
      process.off('SIGINT', terminate);
      return drained;
    })();
    return closing;
  };
  let terminating = false;
  function terminate(): void {
    if (terminating) return;
    terminating = true;
    // A foreign interval or native handle must not outlive the host's bounded shutdown.
    const deadline = setTimeout(() => {
      exitAfterSignal(1);
    }, DRAIN_MS);
    async function finish(): Promise<never> {
      let drained = false;
      try {
        drained = await close();
      } catch {
        // A failed owned cleanup must still terminate the signal-owned process unsuccessfully.
      }
      clearTimeout(deadline);
      return exitAfterSignal(drained ? 0 : 1);
    }
    // eslint-disable-next-line unicorn/prefer-await -- Signal handlers cannot return a shutdown promise to Node.
    finish().catch(() => exitAfterSignal(1));
  }
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  const address = server.address();
  if (typeof address !== 'object' || address === null)
    throw new Error('Node container did not listen');
  return { port: address.port, snapshot: () => lifetime.snapshot(), close };
}
