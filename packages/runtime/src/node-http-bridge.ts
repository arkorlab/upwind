import { randomUUID } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { NULL_BODY_STATUSES } from '@stayingupwind/core/request';

import type { InvokeInput, Run } from './node-bridge.ts';
import { messageHeaders } from './node-http.ts';

export type { FailureAnswer, InvokeInput, Run } from './node-bridge.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
const DISPATCH_HEADER = 'x-upwind-node-dispatch';
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_NO_CONTENT = 204;
const HANDLER_FAILED = 'Node handler failed';
const REPRESENTATION_HEADERS = [
  'content-length',
  'content-encoding',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'transfer-encoding',
];

export function changesSomething(method: string): boolean {
  return !SAFE_METHODS.has(method);
}

function singleRedirectLocation(response: ServerResponse): void {
  const append = response.appendHeader.bind(response);
  response.appendHeader = (name, value) => {
    if (name.toLowerCase() !== 'location') return append(name, value);
    const destination = typeof value === 'string' ? value : value.at(-1);
    if (destination !== undefined) response.setHeader(name, destination);
    return response;
  };
}

function discardRepresentation(response: ServerResponse): void {
  for (const header of REPRESENTATION_HEADERS) {
    if (response.hasHeader(header)) response.removeHeader(header);
  }
}

async function answerFailure(
  input: InvokeInput,
  request: IncomingMessage,
  response: ServerResponse,
  error: unknown,
): Promise<void> {
  if (!response.headersSent) discardRepresentation(response);
  const { onFailure } = input;
  if (onFailure !== undefined && !response.headersSent) {
    const run: Run = input.run ?? ((work) => work());
    try {
      await run(() => onFailure(request, response));
    } catch (error_) {
      // eslint-disable-next-line no-console -- Keep the same private failure observation as the Worker bridge.
      console.error('next-runtime: error page failed', error_);
    }
    if (response.writableEnded) return;
  }
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : new Error(HANDLER_FAILED));
    return;
  }
  discardRepresentation(response);
  response.statusCode = HTTP_INTERNAL_ERROR;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end('Internal Server Error');
}

async function invoke(
  input: InvokeInput,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const run: Run = input.run ?? ((work) => work());
  if (input.status !== undefined) response.statusCode = input.status;
  try {
    await run(() => {
      return input.handler(request, response, {
        waitUntil: input.waitUntil,
        requestMeta: input.requestMeta,
      });
    });
    if (input.expectNoResponse === true && !response.headersSent && !response.writableEnded) {
      response.statusCode = HTTP_NO_CONTENT;
      response.end();
    }
  } catch (error) {
    await answerFailure(input, request, response, error);
    // eslint-disable-next-line no-console -- The client receives only a generic failure; monitoring retains its cause.
    console.error('next-runtime: handler failed', error);
  }
}

function retainHandler(input: InvokeInput, response: ServerResponse, handled: Promise<void>): void {
  if (changesSomething(input.request.method) || response.writableEnded) {
    input.waitUntil(handled);
    return;
  }
  function forget(): void {
    response.off('finish', finished);
    response.off('close', forget);
  }
  function finished(): void {
    forget();
    input.waitUntil(handled);
  }
  response.once('finish', finished);
  response.once('close', forget);
  // eslint-disable-next-line unicorn/prefer-await -- Do not await completion before streaming the response.
  handled.then(forget).catch(forget);
}

interface Dispatch {
  readonly input: InvokeInput;
  readonly url: string;
}

function removeDispatchHeader(request: IncomingMessage): void {
  Reflect.deleteProperty(request.headers, DISPATCH_HEADER);
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index]?.toLowerCase() === DISPATCH_HEADER)
      request.rawHeaders.splice(index, 2);
  }
}

class NodeBridge {
  readonly #dispatches = new Map<string, Dispatch>();
  #server: Server | undefined;
  #port: Promise<number> | undefined;

  readonly #receive = (request: IncomingMessage, response: ServerResponse): void => {
    const token = request.headers[DISPATCH_HEADER];
    const dispatch = typeof token === 'string' ? this.#dispatches.get(token) : undefined;
    if (dispatch === undefined) {
      response.writeHead(HTTP_FORBIDDEN).end();
      return;
    }
    this.#dispatches.delete(token as string);
    removeDispatchHeader(request);
    request.url = dispatch.url;
    singleRedirectLocation(response);
    const handled = invoke(dispatch.input, request, response);
    retainHandler(dispatch.input, response, handled);
    // eslint-disable-next-line unicorn/prefer-await -- The handler owns the streaming response independently.
    handled.catch(() => {
      response.destroy(new Error(HANDLER_FAILED));
    });
  };

  #listen(): Promise<number> {
    this.#port ??= new Promise((resolve, reject) => {
      const server = createServer(this.#receive);
      this.#server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (typeof address !== 'object' || address === null) {
          reject(new Error('Node bridge did not listen'));
          return;
        }
        resolve(address.port);
      });
    });
    return this.#port;
  }

  async invoke(input: InvokeInput): Promise<Response> {
    const port = await this.#listen();
    const source = new URL(input.request.url);
    const token = randomUUID();
    this.#dispatches.set(token, { input, url: input.url ?? `${source.pathname}${source.search}` });
    const headers = Object.fromEntries(input.request.headers);
    headers[DISPATCH_HEADER] = token;
    headers['host'] = input.request.headers.get('host') ?? source.host;
    if (input.request.body !== null) {
      Reflect.deleteProperty(headers, 'content-length');
      headers['transfer-encoding'] = 'chunked';
    }
    try {
      return await new Promise<Response>((resolve, reject) => {
        const outgoing = httpRequest({
          hostname: '127.0.0.1',
          port,
          path: '/',
          method: input.request.method,
          headers,
          ...(!changesSomething(input.request.method) && { signal: input.request.signal }),
        });
        outgoing.once('error', reject);
        outgoing.once('response', (incoming) => {
          try {
            const status = incoming.statusCode ?? HTTP_INTERNAL_ERROR;
            const body =
              NULL_BODY_STATUSES.has(status) || input.request.method === 'HEAD'
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
            if (body === null) incoming.resume();
            resolve(new Response(body, { status, headers: messageHeaders(incoming) }));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(HANDLER_FAILED, { cause: error }));
            incoming.destroy();
            outgoing.destroy();
          }
        });
        if (input.request.body === null) {
          outgoing.end();
        } else {
          const bodyTask = pipeline(
            Readable.fromWeb(input.request.body as unknown as NodeReadableStream<Uint8Array>),
            outgoing,
          );
          // eslint-disable-next-line unicorn/prefer-await -- Headers may arrive before a streamed request body ends.
          bodyTask.catch(() => {
            outgoing.destroy(new Error('Node request body failed'));
          });
        }
      });
    } finally {
      this.#dispatches.delete(token);
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
      server.closeAllConnections();
    });
    this.#server = undefined;
    this.#port = undefined;
  }
}

interface SharedBridge {
  readonly version: 1;
  readonly invoke: (input: InvokeInput) => Promise<Response>;
  readonly close: () => Promise<void>;
}

const BRIDGE_KEY = Symbol.for('upwind.node-http-bridge.v1');

function isSharedBridge(value: unknown): value is SharedBridge {
  if (value === null || typeof value !== 'object') return false;
  return (
    'version' in value &&
    value.version === 1 &&
    'invoke' in value &&
    typeof value.invoke === 'function' &&
    'close' in value &&
    typeof value.close === 'function' &&
    Object.isFrozen(value)
  );
}

function sharedBridge(): SharedBridge {
  const existing = Object.getOwnPropertyDescriptor(globalThis, BRIDGE_KEY);
  if (existing !== undefined) {
    const value: unknown = existing.value;
    if (existing.configurable !== false || existing.writable !== false || !isSharedBridge(value)) {
      throw new Error('Conflicting Node HTTP bridge registry');
    }
    return value;
  }
  const instance = new NodeBridge();
  const made: SharedBridge = Object.freeze({
    version: 1,
    invoke: instance.invoke.bind(instance),
    close: instance.close.bind(instance),
  });
  Object.defineProperty(globalThis, BRIDGE_KEY, {
    value: made,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return made;
}

// server.mjs and function.mjs are separate bundles in one Node process. Their independently
// evaluated module copies must own the same loopback server, including its shutdown hook.
const bridge = sharedBridge();

/** Real IncomingMessage/ServerResponse, preserving native streaming and the caller's ALS runner. */
export function invokeNodeHandler(input: InvokeInput): Promise<Response> {
  return bridge.invoke(input);
}

export function closeNodeHttpBridge(): Promise<void> {
  return bridge.close();
}
