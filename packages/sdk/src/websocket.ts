/// <reference types="node" preserve="true" />
/* eslint-disable no-restricted-imports -- This isolated compatibility entry point deliberately uses Node primitives. */

import { Buffer } from 'node:buffer';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Duplex, type Writable } from 'node:stream';

/** The Node upgrade callback accepted by `ws` and Engine.IO's `handleUpgrade`. */
export type NodeWebSocketUpgrade = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>;

const HANDSHAKE_MS = 10_000;
const MAX_HEADERS = 16_384;
const MAX_MESSAGE = 33_554_432;
const MAX_FRAME_OVERHEAD = 14;
const MASK_BYTES = 4;
const MIN_HTTP_STATUS = 200;
const MAX_HTTP_STATUS = 599;
const CLOSE_NORMAL = 1000;
const CLOSE_NO_STATUS = 1005;
const CLOSE_ABNORMAL = 1006;
const CLOSE_FAILURE = 1011;
const CLOSE_OPCODE = 8;
const SOCKET_CLOSED = 3;
const HEADER_END = '\r\n\r\n';

interface NativeSocket {
  binaryType: string;
  readonly readyState: number;
  accept(options?: { allowHalfOpen?: boolean }): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface FrameCodecs {
  readonly Receiver: new (options: {
    isServer: boolean;
    binaryType: string;
    maxPayload: number;
    maxFragments: number;
    maxBufferedChunks: number;
  }) => Writable;
  readonly Sender: {
    frame(
      data: Buffer,
      options: {
        fin: boolean;
        opcode: number;
        mask: boolean;
        readOnly: boolean;
        rsv1: boolean;
        maskBuffer: Buffer;
      },
    ): Buffer[];
  };
}

/** `ws` exports these codecs, although its third-party declarations do not describe them. */
async function loadCodecs(): Promise<FrameCodecs> {
  const loaded: unknown = await import('ws');
  if (
    typeof loaded !== 'object' ||
    loaded === null ||
    !('Receiver' in loaded) ||
    typeof loaded.Receiver !== 'function' ||
    !('Sender' in loaded) ||
    typeof loaded.Sender !== 'function' ||
    !('frame' in loaded.Sender) ||
    typeof loaded.Sender.frame !== 'function'
  ) {
    throw new Error('handleNodeWebSocket requires ws >=8.22.0 <9 with Receiver and Sender exports');
  }
  return loaded as FrameCodecs;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function nativePair(): { readonly 0: NativeSocket; readonly 1: NativeSocket } {
  const platform: unknown = globalThis;
  if (
    typeof platform !== 'object' ||
    platform === null ||
    !('WebSocketPair' in platform) ||
    typeof platform.WebSocketPair !== 'function'
  ) {
    throw new Error('handleNodeWebSocket requires a Workers runtime or upwind dev');
  }
  const Pair = platform.WebSocketPair as new () => {
    readonly 0: NativeSocket;
    readonly 1: NativeSocket;
  };
  return new Pair();
}

function upgradeResponse(socket: NativeSocket, headers: Headers): Response {
  // Cloudflare extends ResponseInit with webSocket; keep those platform types out of consumers.
  const init = { status: 101, headers, webSocket: socket };
  return new Response(null, init);
}

function hasToken(value: string | null, token: string): boolean {
  return value?.split(',').some((part) => part.trim().toLowerCase() === token) === true;
}

/** A bounded bridge between Node's framed Duplex and Workers' message-oriented sockets. */
class UpgradeSocket extends Duplex {
  readonly #codecs: FrameCodecs;
  readonly #receiver: Writable;
  readonly #resolve: (response: Response) => void;
  readonly #reject: (reason: Error) => void;
  readonly #signal: AbortSignal;
  readonly #timeout: ReturnType<typeof setTimeout>;
  #pending = true;
  #headers = Buffer.alloc(0);
  #rejection: { status: number; headers: Headers; chunks: Buffer[]; bytes: number } | undefined;
  #native: NativeSocket | undefined;
  #accepted = false;
  #nativeClosed = false;
  #frameError: Error | undefined;
  #onAbort = (): void => {
    this.destroy(errorOf(this.#signal.reason ?? new Error('WebSocket request aborted')));
  };

  #onMessage: EventListener = (event): void => {
    try {
      const { data } = event as MessageEvent<unknown>;
      const text = typeof data === 'string';
      if (!text && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
        throw new Error('WebSocket binary messages must contain bytes');
      }
      let payload: Buffer;
      if (typeof data === 'string') payload = Buffer.from(data, 'utf8');
      else if (data instanceof ArrayBuffer) payload = Buffer.from(data);
      else payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (payload.length > MAX_MESSAGE) throw new Error('WebSocket message exceeds 32 MiB');
      this.#pushFrame(payload, text ? 1 : 2);
    } catch (error) {
      this.destroy(errorOf(error));
    }
  };

  #onClose: EventListener = (event): void => {
    if (this.#nativeClosed || this.destroyed) return;
    this.#nativeClosed = true;
    const { code, reason } = event as CloseEvent;
    try {
      if (code !== CLOSE_ABNORMAL) {
        const text = Buffer.from(reason, 'utf8');
        const payload = Buffer.alloc(code === CLOSE_NO_STATUS ? 0 : 2 + text.length);
        if (code !== CLOSE_NO_STATUS) {
          payload.writeUInt16BE(code);
          text.copy(payload, 2);
        }
        this.#pushFrame(payload, CLOSE_OPCODE);
      }
      this.push(null);
    } catch (error) {
      this.destroy(errorOf(error));
    }
  };

  #onError: EventListener = (): void => {
    this.destroy(new Error('WebSocket transport failed'));
  };
  readonly response: Promise<Response>;
  readonly encrypted: boolean;
  readonly remoteAddress: string;

  constructor(request: Request, codecs: FrameCodecs) {
    super();
    this.#codecs = codecs;
    this.encrypted = new URL(request.url).protocol === 'https:';
    this.remoteAddress = request.headers.get('cf-connecting-ip') ?? '127.0.0.1';
    const deferred = Promise.withResolvers<Response>();
    this.response = deferred.promise;
    this.#resolve = deferred.resolve;
    this.#reject = deferred.reject;
    this.#signal = request.signal;
    this.#timeout = setTimeout(() => {
      this.destroy(new Error('WebSocket handshake timed out after 10 seconds'));
    }, HANDSHAKE_MS);
    this.#signal.addEventListener('abort', this.#onAbort, { once: true });
    this.#receiver = new codecs.Receiver({
      isServer: false,
      binaryType: 'nodebuffer',
      maxPayload: MAX_MESSAGE,
      maxFragments: 16_384,
      maxBufferedChunks: 16_384,
    });
    this.#receiver.on('message', (data: Buffer, binary: boolean) => {
      if (this.#frameError !== undefined) return;
      try {
        this.#native?.send(binary ? data : data.toString('utf8'));
      } catch (error) {
        this.destroy(errorOf(error));
      }
    });
    this.#receiver.on('conclude', (code: number, reason: Buffer) => {
      try {
        this.#native?.close(code === CLOSE_NO_STATUS ? undefined : code, reason.toString('utf8'));
      } catch (error) {
        this.destroy(errorOf(error));
      }
    });
    const unsupportedControl = (): void => {
      this.#frameError = new Error(
        'Workers cannot forward Node WebSocket protocol ping/pong frames',
      );
    };
    this.#receiver.on('ping', unsupportedControl);
    this.#receiver.on('pong', unsupportedControl);
    this.#receiver.on('error', (error: Error) => this.destroy(error));
    // A callback may destroy the socket before installing its own error listener.
    this.on('error', () => {
      // The response promise and the Node library receive failures through their own channels.
    });
    if (request.signal.aborted) this.#onAbort();
  }

  #settle(response: Response): void {
    if (!this.#pending) return;
    this.#pending = false;
    clearTimeout(this.#timeout);
    this.#signal.removeEventListener('abort', this.#onAbort);
    this.#resolve(response);
  }

  #accept(statusLine: string, headers: Headers): void {
    if (!/^HTTP\/1\.[01] 101(?: |$)/u.test(statusLine)) {
      const status = Number(/^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(statusLine)?.[1]);
      if (!Number.isSafeInteger(status) || status < MIN_HTTP_STATUS || status > MAX_HTTP_STATUS) {
        throw new Error('Node WebSocket handler wrote an invalid HTTP status');
      }
      this.#rejection = { status, headers, chunks: [], bytes: 0 };
      return;
    }
    if (
      !hasToken(headers.get('upgrade'), 'websocket') ||
      !hasToken(headers.get('connection'), 'upgrade')
    ) {
      throw new Error('Node WebSocket handler wrote an invalid upgrade handshake');
    }
    if (headers.has('sec-websocket-extensions')) {
      throw new Error('Node WebSocket extensions are unsupported; set perMessageDeflate: false');
    }
    const pair = nativePair();
    const server = pair[1];
    server.binaryType = 'arraybuffer';
    server.addEventListener('message', this.#onMessage);
    server.addEventListener('close', this.#onClose);
    server.addEventListener('error', this.#onError);
    this.#native = server;
    server.accept({ allowHalfOpen: true });
    const response = upgradeResponse(pair[0], headers);
    this.#accepted = true;
    this.#settle(response);
  }

  #pushFrame(payload: Buffer, opcode: number): void {
    const chunks = this.#codecs.Sender.frame(payload, {
      fin: true,
      opcode,
      mask: true,
      readOnly: true,
      rsv1: false,
      maskBuffer: Buffer.alloc(MASK_BYTES),
    });
    const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (this.readableLength + bytes > MAX_MESSAGE + MAX_FRAME_OVERHEAD) {
      throw new Error('WebSocket incoming queue exceeds 32 MiB');
    }
    for (const chunk of chunks) this.push(chunk);
  }

  #handshakeChunk(chunk: Buffer): Buffer | undefined {
    const combined = Buffer.concat([this.#headers, chunk]);
    const boundary = combined.indexOf(HEADER_END);
    const headerLength = boundary === -1 ? combined.length : boundary + HEADER_END.length;
    if (headerLength > MAX_HEADERS) throw new Error('WebSocket handshake headers exceed 16 KiB');
    if (boundary === -1) {
      this.#headers = combined;
      return undefined;
    }
    const [statusLine = '', ...lines] = combined
      .subarray(0, boundary)
      .toString('latin1')
      .split('\r\n');
    const headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error('Node WebSocket handler wrote an invalid HTTP header');
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    this.#headers = Buffer.alloc(0);
    this.#accept(statusLine, headers);
    return combined.subarray(boundary + HEADER_END.length);
  }

  override _read(): void {
    // Native WebSocket events push incoming bytes; there is no pull API on that transport.
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const payload =
        !this.#accepted && this.#rejection === undefined ? this.#handshakeChunk(chunk) : chunk;
      if (payload === undefined) {
        callback();
        return;
      }
      const rejection = this.#rejection;
      if (rejection !== undefined) {
        rejection.bytes += payload.length;
        if (rejection.bytes > MAX_MESSAGE)
          throw new Error('WebSocket rejection body exceeds 32 MiB');
        if (payload.length > 0) rejection.chunks.push(Buffer.from(payload));
        callback();
      } else if (payload.length > 0) {
        this.#receiver.write(payload, (error?: Error | null) => {
          const failure = error ?? this.#frameError;
          this.#frameError = undefined;
          callback(failure);
        });
      } else {
        callback();
      }
    } catch (error) {
      callback(errorOf(error));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      const rejection = this.#rejection;
      if (rejection !== undefined) {
        const body = rejection.bytes === 0 ? null : Buffer.concat(rejection.chunks);
        this.#settle(new Response(body, { status: rejection.status, headers: rejection.headers }));
        this.push(null);
      } else if (!this.#accepted) {
        throw new Error('Node WebSocket handler ended without a complete handshake');
      } else if (!this.#nativeClosed) {
        this.#native?.close();
      }
      callback();
    } catch (error) {
      callback(errorOf(error));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.#timeout);
    this.#signal.removeEventListener('abort', this.#onAbort);
    if (this.#pending) {
      this.#pending = false;
      this.#reject(
        error ?? new Error('Node WebSocket handler closed before accepting the connection'),
      );
    }
    const server = this.#native;
    if (server !== undefined) {
      server.removeEventListener('message', this.#onMessage);
      server.removeEventListener('close', this.#onClose);
      server.removeEventListener('error', this.#onError);
      if (server.readyState < SOCKET_CLOSED) {
        try {
          server.close(
            error === null ? CLOSE_NORMAL : CLOSE_FAILURE,
            error === null ? '' : 'WebSocket bridge failed',
          );
        } catch {
          // A transport already being torn down needs no second close attempt.
        }
      }
    }
    this.#receiver.destroy();
    this.#headers = Buffer.alloc(0);
    this.#rejection = undefined;
    callback(error);
  }
}

function nodeRequest(request: Request, socket: UpgradeSocket): IncomingMessage {
  // Construct the real Node class; the unconnected socket performs no I/O. Its public socket is
  // replaced below because workerd's fetch-backed constructor does not assign that argument.
  const incoming = new IncomingMessage(new Socket());
  // workerd's IncomingMessage is fetch-backed and does not assign its constructor's socket.
  Object.defineProperties(incoming, {
    socket: { value: socket, configurable: true, writable: true },
    connection: { value: socket, configurable: true, writable: true },
  });
  // workerd's fetch-backed IncomingMessage cancels its body when destroyed, but has no native
  // socket to close. Explicit rejection must also settle this upgrade, as it does on Node.
  const destroy = incoming._destroy.bind(incoming);
  incoming._destroy = (error, callback): void => {
    if (error !== null || !incoming.readableEnded) socket.destroy(error ?? undefined);
    destroy(error, callback);
  };
  incoming.on('error', () => {
    // The socket observes rejection too; a verifier need not install a request error listener.
  });
  const url = new URL(request.url);
  incoming.url = `${url.pathname}${url.search}`;
  incoming.method = request.method;
  incoming.headers = Object.fromEntries(request.headers);
  incoming.rawHeaders = [...request.headers].flatMap(([name, value]) => [name, value]);
  incoming.complete = true;
  return incoming;
}

/**
 * Accept a WebSocket from an App Route through an existing `ws` or Engine.IO upgrade callback.
 * Requires the optional `ws >=8.22.0 <9` peer. Compression and protocol ping/pong are unsupported.
 */
export async function handleNodeWebSocket(
  request: Request,
  upgrade: NodeWebSocketUpgrade,
): Promise<Response> {
  if (request.method !== 'GET' || !hasToken(request.headers.get('upgrade'), 'websocket')) {
    return new Response('Expected a WebSocket upgrade', {
      status: 426,
      headers: { upgrade: 'websocket' },
    });
  }
  if (
    request.headers.get('sec-websocket-version') !== '13' ||
    !/^[+/0-9A-Za-z]{22}==$/u.test(request.headers.get('sec-websocket-key') ?? '')
  ) {
    return new Response('Invalid WebSocket handshake', { status: 400 });
  }
  const codecs = await loadCodecs();
  const socket = new UpgradeSocket(request, codecs);
  if (!socket.destroyed) {
    try {
      const pending = upgrade(nodeRequest(request, socket), socket, Buffer.alloc(0));
      if (pending !== undefined) {
        void Promise.resolve(pending).catch((error: unknown) => socket.destroy(errorOf(error)));
      }
    } catch (error) {
      socket.destroy(errorOf(error));
    }
  }
  return socket.response;
}
