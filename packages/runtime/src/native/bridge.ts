import { randomBytes } from 'node:crypto';
import {
  Agent,
  type ClientRequest,
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { changesSomething, type InvokeInput, type Run } from '../invocation.ts';
import { responseHeaders, restoreRequest, singleRedirectLocation } from './headers.ts';
import { TaskGroup } from './lifetime.ts';

/** The token is a one-use reference, not a serialization of callback-bearing request metadata. */
const DISPATCH_HEADER = 'x-upwind-native-dispatch';
const HTTP_NO_CONTENT = 204;
const HTTP_RESET_CONTENT = 205;
const HTTP_NOT_MODIFIED = 304;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const EMPTY_STATUSES: ReadonlySet<number> = new Set([
  HTTP_NO_CONTENT,
  HTTP_NOT_MODIFIED,
  HTTP_RESET_CONTENT,
]);
const DEFAULT_MAX_IN_FLIGHT = 256;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const KIB = 1024;
const STREAM_BUFFER_KIB = 64;
const STREAM_BUFFER_BYTES = STREAM_BUFFER_KIB * KIB;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DISPATCH_TOKEN_BYTES = 32;
const MAX_IDLE_SOCKETS = 16;
const FAILED_REPRESENTATION_HEADERS = [
  'content-length',
  'content-encoding',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'location',
] as const;

export type NodeBridgeErrorCode = 'capacity' | 'headers-timeout' | 'closing';

/** Expected admission/deadline failures a native host can map to HTTP 503 or 504. */
export class NodeBridgeError extends Error {
  override readonly name = 'NodeBridgeError';
  readonly code: NodeBridgeErrorCode;

  constructor(code: NodeBridgeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface NodeBridgeOptions {
  readonly maxInFlight?: number | undefined;
  /** Bounds time to response headers, not the lifetime of a streaming response. */
  readonly headersTimeoutMs?: number | undefined;
  readonly onError?: ((error: unknown) => unknown) | undefined;
}

export interface NodeBridge {
  invokeNodeHandler(input: InvokeInput): Promise<Response>;
  /** Stop accepting invocations. False means handlers or streams exceeded the drain deadline. */
  close(timeoutMs?: number): Promise<boolean>;
  /** Counts handlers that have ended their response but have not finished their work, too. */
  readonly activeInvocations: number;
}

interface Invocation {
  readonly input: InvokeInput;
  readonly url: string;
  accepted: boolean;
  handlerFinished: boolean;
  transportFinished: boolean;
}

function boundedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be a positive bounded integer`);
  }
  return value;
}

function assertBodyAvailable(request: Request): void {
  if (request.bodyUsed || request.body?.locked === true) {
    throw new TypeError('native invocation requires an unused request body');
  }
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error('native invocation failed', { cause: error });
}

function defaultReport(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error('next-runtime: native handler failed', error);
}

async function reportSafely(report: (error: unknown) => unknown, error: unknown): Promise<void> {
  try {
    await report(error);
  } catch {
    // A reporter cannot turn a handled transport failure into an unhandled rejection.
  }
}

class NativeBridge implements NodeBridge {
  readonly #limit: number;
  readonly #headersTimeoutMs: number;
  readonly #report: (error: unknown) => void;
  readonly #tasks: TaskGroup;
  readonly #agent: Agent;
  readonly #active = new Map<string, Invocation>();
  readonly #clients = new Set<ClientRequest>();
  #server: Server | undefined;
  #starting: Promise<number> | undefined;
  #closing: Promise<boolean> | undefined;
  #stopping = false;

  constructor(options: NodeBridgeOptions) {
    this.#limit = boundedInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, 'maxInFlight');
    this.#headersTimeoutMs = boundedInteger(
      options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
      'headersTimeoutMs',
    );
    const report = options.onError ?? defaultReport;
    this.#report = (error) => {
      // eslint-disable-next-line unicorn/prefer-await, promise/no-promise-in-callback -- Logging must not delay the exchange or escape its event callback.
      reportSafely(report, error).catch(() => {
        // reportSafely contains reporter failures; this guards its observer as well.
      });
    };
    this.#tasks = new TaskGroup(this.#report);
    // The admission bound is also the connection bound, so the Agent cannot grow an unbounded
    // pending queue. Idle connections belong to this bridge alone, never to application's HTTP.
    this.#agent = new Agent({
      keepAlive: true,
      maxSockets: this.#limit,
      maxTotalSockets: this.#limit,
      maxFreeSockets: Math.min(MAX_IDLE_SOCKETS, this.#limit),
      scheduling: 'lifo',
    });
  }

  #assertOpen(): void {
    if (this.#stopping) throw new NodeBridgeError('closing', 'native bridge is closing');
  }

  #release(id: string, invocation: Invocation): void {
    if (invocation.transportFinished && (!invocation.accepted || invocation.handlerFinished)) {
      this.#active.delete(id);
    }
  }

  #start(): Promise<number> {
    this.#starting ??= new Promise((resolve, reject) => {
      const server = createServer({ requestTimeout: 0 }, (req, res) => {
        this.#dispatch(req, res);
      });
      this.#server = server;
      server.on('error', reject);
      // Upgrades and tunnels have no representation in the Request/Response invocation contract.
      server.on('upgrade', (_req, socket) => socket.destroy());
      server.on('connect', (_req, socket) => socket.destroy());
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('native bridge did not acquire an address'));
          return;
        }
        resolve(address.port);
      });
    });
    return this.#starting;
  }

  #exchange(port: number, id: string, invocation: Invocation): Promise<Response> {
    const { input } = invocation;
    return new Promise<Response>((resolve, reject) => {
      const client = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/',
        method: input.request.method,
        agent: this.#agent,
        // Application headers stay in the dispatch record. Connection framing belongs here.
        headers: { [DISPATCH_HEADER]: id },
      });
      this.#clients.add(client);
      let upload: Readable | undefined;
      let answered = false;
      const timer = setTimeout(() => {
        client.destroy(
          new NodeBridgeError(
            'headers-timeout',
            'native handler did not send headers before its deadline',
          ),
        );
      }, this.#headersTimeoutMs);
      const abort = (): void => {
        client.destroy(errorOf(input.request.signal.reason));
      };
      input.request.signal.addEventListener('abort', abort, { once: true });
      client.on('error', (error) => {
        if (!answered) reject(error);
      });
      client.once('close', () => {
        if (!answered) reject(new Error('native transport closed before response headers'));
        clearTimeout(timer);
        input.request.signal.removeEventListener('abort', abort);
        this.#clients.delete(client);
        // A server may finish its answer before consuming an upload. A pooled socket must never
        // retain that producer, nor be handed to the next call with unfinished request framing.
        if (upload !== undefined && !upload.readableEnded) upload.destroy();
        invocation.transportFinished = true;
        this.#release(id, invocation);
      });
      client.once('upgrade', (_response, socket) => {
        const error = new Error('native invocation does not support HTTP upgrades');
        reject(error);
        socket.destroy();
        client.destroy(error);
      });
      client.once('response', (response) => {
        response.on('error', () => {
          // Readable.toWeb forwards the same failure to its consumer.
        });
        response.once('end', () => {
          if (upload !== undefined && !upload.readableEnded) {
            upload.destroy();
            client.destroy();
          }
        });
        clearTimeout(timer);
        try {
          const status = response.statusCode ?? HTTP_INTERNAL_ERROR;
          const bodyless = input.request.method === 'HEAD' || EMPTY_STATUSES.has(status);
          const body = bodyless
            ? null
            : (Readable.toWeb(response, {
                strategy: {
                  highWaterMark: STREAM_BUFFER_BYTES,
                  size: (chunk: Uint8Array) => chunk.byteLength,
                },
              }) as ReadableStream<Uint8Array>);
          const result = new Response(body, {
            status,
            headers: responseHeaders(response.rawHeaders),
            statusText: response.statusMessage ?? '',
          });
          if (bodyless) response.resume();
          answered = true;
          resolve(result);
        } catch (error) {
          response.destroy(errorOf(error));
          reject(errorOf(error));
        }
      });
      if (input.request.signal.aborted) {
        abort();
        return;
      }
      if (input.request.body === null) {
        client.end();
      } else {
        // The pipeline owns backpressure and cancellation. No request body is buffered whole.
        // DOM's stream declarations omit Node's iterator methods; the native stream is the same.
        upload = Readable.fromWeb(input.request.body as NodeReadableStream<Uint8Array>, {
          highWaterMark: STREAM_BUFFER_BYTES,
        });
        void pipeline(upload, client).catch((error: unknown) => {
          if (!answered) reject(errorOf(error));
        });
      }
    });
  }

  #dispatch(req: IncomingMessage, res: ServerResponse): void {
    const id = req.headers[DISPATCH_HEADER];
    const invocation = typeof id === 'string' ? this.#active.get(id) : undefined;
    if (typeof id !== 'string' || invocation === undefined || invocation.accepted) {
      res.writeHead(HTTP_NOT_FOUND, { connection: 'close' });
      res.end();
      return;
    }
    // A second request carrying the same token cannot invoke application code again.
    invocation.accepted = true;
    req.on('error', () => {
      // The transport's pipeline owns request stream failures.
    });
    res.on('error', () => {
      // The client-side response stream owns response failures.
    });
    restoreRequest(req, invocation.input.request, invocation.url);
    singleRedirectLocation(res);
    const handled = this.#handle(id, invocation, req, res);
    this.#tasks.waitUntil(handled);
    this.#retain(invocation.input, res, handled);
  }

  async #handle(
    id: string,
    invocation: Invocation,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      await this.#invoke(invocation.input, req, res);
    } catch (error) {
      // Even a failure while composing the fallback must end the exchange, not only its task.
      this.#report(error);
      res.destroy(errorOf(error));
    } finally {
      invocation.handlerFinished = true;
      this.#release(id, invocation);
    }
  }

  #retain(input: InvokeInput, res: ServerResponse, handled: Promise<void>): void {
    const retain = (): void => {
      try {
        const waitUntil: (promise: Promise<unknown>) => unknown = input.waitUntil;
        const retained = waitUntil(handled);
        void Promise.resolve(retained).catch(this.#report);
      } catch (error) {
        this.#report(error);
      }
    };
    if (changesSomething(input.request.method) || res.writableEnded) {
      retain();
      return;
    }
    function forget(): void {
      res.off('finish', finished);
      res.off('close', forget);
    }
    function finished(): void {
      forget();
      retain();
    }
    res.once('finish', finished);
    res.once('close', forget);
    void handled.then(forget).catch(forget);
  }

  async #invoke(input: InvokeInput, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const run: Run = input.run ?? ((work) => work());
    if (input.status !== undefined) res.statusCode = input.status;
    try {
      await run(() =>
        input.handler(req, res, { waitUntil: input.waitUntil, requestMeta: input.requestMeta }),
      );
      if (input.expectNoResponse === true && !res.headersSent && !res.writableEnded) {
        res.writeHead(HTTP_NO_CONTENT);
        res.end();
      }
    } catch (error) {
      await this.#answerFailure(input, req, res, error);
    }
  }

  async #answerFailure(
    input: InvokeInput,
    req: IncomingMessage,
    res: ServerResponse,
    error: unknown,
  ): Promise<void> {
    this.#report(error);
    // Neither an error page nor the generic answer may inherit a failed representation's
    // length or encoding. Cookies deliberately survive, as they do on Next.js error pages.
    if (!res.headersSent) {
      for (const name of FAILED_REPRESENTATION_HEADERS) res.removeHeader(name);
      res.setHeader('cache-control', 'private, no-store');
    }
    const run: Run = input.run ?? ((work) => work());
    const { onFailure } = input;
    if (onFailure !== undefined && !res.headersSent) {
      try {
        await run(() => onFailure(req, res));
      } catch (error_) {
        this.#report(error_);
      }
      if (res.writableEnded) return;
    }
    if (res.headersSent) {
      res.destroy(errorOf(error));
    } else {
      // The failed render may have prepared metadata for a different body. In particular, a
      // stale Content-Length can hang its reader and a stale encoding corrupts the fallback.
      for (const name of FAILED_REPRESENTATION_HEADERS) res.removeHeader(name);
      res.writeHead(HTTP_INTERNAL_ERROR, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'private, no-store',
      });
      res.end('Internal Server Error');
    }
  }

  async #close(timeoutMs: number): Promise<boolean> {
    if (this.#starting === undefined) {
      this.#agent.destroy();
      return true;
    }
    try {
      await this.#starting;
    } catch {
      this.#agent.destroy();
      return this.#active.size === 0;
    }
    const server = this.#server;
    if (server === undefined) return this.#active.size === 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        for (const client of this.#clients)
          client.destroy(new Error('native bridge drain expired'));
        server.closeAllConnections();
        resolve(false);
      }, timeoutMs);
    });
    const stopped = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    try {
      // eslint-disable-next-line unicorn/prefer-await -- Both drains race the common deadline.
      const drained = Promise.all([stopped, this.#tasks.drain(timeoutMs)]).then(
        ([, complete]) => complete,
      );
      return await Promise.race([drained, expired]);
    } finally {
      clearTimeout(timer);
      this.#agent.destroy();
    }
  }

  get activeInvocations(): number {
    return this.#active.size;
  }

  async invokeNodeHandler(input: InvokeInput): Promise<Response> {
    this.#assertOpen();
    input.request.signal.throwIfAborted();
    assertBodyAvailable(input.request);
    if (this.#active.size >= this.#limit)
      throw new NodeBridgeError('capacity', 'native bridge capacity exceeded');
    const target = new URL(input.request.url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new TypeError('native invocation requires an HTTP URL');
    }
    // eslint-disable-next-line unicorn/prefer-uint8array-hex -- Buffer.toString is supported by the package's Node 24 floor.
    const id = randomBytes(DISPATCH_TOKEN_BYTES).toString('hex');
    const invocation: Invocation = {
      input,
      url: input.url ?? `${target.pathname}${target.search}`,
      accepted: false,
      handlerFinished: false,
      transportFinished: false,
    };
    // Reserve before awaiting listen: simultaneous cold requests share one bounded startup.
    this.#active.set(id, invocation);
    try {
      const port = await this.#start();
      this.#assertOpen();
      input.request.signal.throwIfAborted();
      // Another invocation may have acquired this same body while both awaited cold startup.
      assertBodyAvailable(input.request);
      return await this.#exchange(port, id, invocation);
    } catch (error) {
      invocation.transportFinished = true;
      this.#release(id, invocation);
      throw error;
    }
  }

  close(timeoutMs = 10_000): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
      return Promise.reject(new RangeError('native bridge close timeout is out of range'));
    }
    this.#stopping = true;
    this.#closing ??= this.#close(timeoutMs);
    return this.#closing;
  }
}

/**
 * A private loopback transport made only from Node built-ins. Neither fetch's decompression nor
 * its redirect handling is suitable here: a compressed response must keep exactly its bytes and
 * headers. The bridge does not load Next.js, install the workerd scheduler, or open a public port.
 */
export function createNodeBridge(options: NodeBridgeOptions = {}): NodeBridge {
  return new NativeBridge(options);
}
