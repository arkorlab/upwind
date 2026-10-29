import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import type { Miniflare, WebSocket as WorkerSocket } from 'miniflare';
import WebSocket, { type RawData } from 'ws';

import { functionWorker } from './function-worker.ts';
import { workerApp } from './worker-function.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TIMEOUT_MS = 30_000;
const STARTUP_MS = 120_000;
const SHUTDOWN_MS = 5000;
const STARTUP_LOG_CHARACTERS = 4000;
const FAILURE_LOG_CHARACTERS = 6000;
const MAX_SOCKETIO_PACKETS = 20;
const HTTP_SWITCHING_PROTOCOLS = 101;
const HTTP_FORBIDDEN = 403;
const NORMAL_CLOSURE = 1000;
const MAX_BYTE = 255;
const BINARY_SENTINEL = 17;
const DO_REGISTRATION = '[{"name":"CHAT","module":"chat.js","className":"Chat"}]';
const DEV_BASE_PATH = '/base';
const DEV_ASSET_PREFIX = '/assets';
// dispatchFetch invokes the in-process Miniflare Worker without a TLS endpoint.
const WORKER_ORIGIN = 'http://websocket.test';

/** Queue messages before accepting: Engine.IO sends its handshake immediately on acceptance. */
class Messages {
  readonly #values: unknown[] = [];
  readonly #waiting: ((value: unknown) => void)[] = [];

  push(value: unknown): void {
    const waiting = this.#waiting.shift();
    if (waiting) waiting(value);
    else this.#values.push(value);
  }

  async next(): Promise<unknown> {
    if (this.#values.length > 0) return this.#values.shift();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<unknown>((resolve) => {
          this.#waiting.push(resolve);
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('WebSocket message timed out'));
          }, TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

interface Peer {
  readonly messages: Messages;
  readonly headers: Headers;
  send(value: string | Uint8Array): void;
  close(): void;
}

type Open = (pathname: string, protocol?: string) => Promise<Peer>;

async function exchanges(open: Open): Promise<void> {
  const native = await open('/api/native/room', 'echo');
  try {
    assert.equal(native.headers.get('x-upgrade-visits'), '1', 'middleware must run once');
    const cookies = native.headers.getSetCookie().join(';');
    assert.match(cookies, /route-cookie=kept/u);
    assert.match(cookies, /response-cookie=kept/u);
    native.send('native');
    assert.equal(await native.messages.next(), 'room:native');
    const binary = new Uint8Array([0, MAX_BYTE, BINARY_SENTINEL]);
    native.send(binary);
    const received = await native.messages.next();
    assert.ok(typeof received !== 'string', `expected binary, received ${String(received)}`);
    const bytes = received instanceof Blob ? await received.arrayBuffer() : received;
    assert.ok(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes), 'expected binary bytes');
    const receivedBytes =
      bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.deepEqual(receivedBytes, binary);
  } finally {
    native.close();
  }
  for (const [pathname, sent, expected] of [
    ['/alias', 'rewrite', 'rewritten:rewrite'],
    ['/api/ws', 'node', 'node'],
    ['/api/object', 'binding', 'object:binding'],
  ] as const) {
    const peer = await open(pathname, pathname === '/alias' ? 'echo' : undefined);
    try {
      peer.send(sent);
      assert.equal(await peer.messages.next(), expected, pathname);
    } finally {
      peer.close();
    }
  }
  const socketio = await open('/api/socketio?EIO=4&transport=websocket');
  try {
    assert.match(String(await socketio.messages.next()), /^0\{/u, 'Engine.IO handshake');
    socketio.send('40');
    let connected = false;
    let heartbeat = false;
    let echoed = false;
    for (
      let index = 0;
      index < MAX_SOCKETIO_PACKETS && !(connected && heartbeat && echoed);
      index += 1
    ) {
      const message = String(await socketio.messages.next());
      if (message === '2') {
        socketio.send('3');
        heartbeat = true;
      } else if (message.startsWith('40')) {
        connected = true;
        socketio.send('42["echo","socket.io"]');
      } else if (message === '42["echo","socket.io"]') echoed = true;
    }
    assert.ok(
      connected && heartbeat && echoed,
      'Socket.IO connection, echo and application heartbeat',
    );
  } finally {
    socketio.close();
  }
}

function workerOpen(runtime: Miniflare): Open {
  return async (pathname, protocol) => {
    const response = await runtime.dispatchFetch(`${WORKER_ORIGIN}${pathname}`, {
      headers: {
        upgrade: 'websocket',
        ...(protocol !== undefined && protocol !== '' && { 'sec-websocket-protocol': protocol }),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    assert.equal(
      response.status,
      HTTP_SWITCHING_PROTOCOLS,
      `${pathname}: ${await response.text()}`,
    );
    const socket: WorkerSocket | null = response.webSocket;
    assert.ok(socket, 'native response retains the socket');
    const messages = new Messages();
    socket.addEventListener('message', (event) => {
      messages.push(event.data);
    });
    socket.accept();
    return {
      messages,
      headers: new Headers([...response.headers]),
      send: (value) => {
        socket.send(typeof value === 'string' ? value : Uint8Array.from(value));
      },
      close: () => {
        socket.close(NORMAL_CLOSURE, 'check finished');
      },
    };
  };
}

/** ws can deliver a complete buffer, an ArrayBuffer, or its fragment buffers. */
function nodeBytes(value: RawData): Buffer {
  if (Array.isArray(value)) return Buffer.concat(value);
  return value instanceof ArrayBuffer ? Buffer.from(value) : value;
}

function networkOpen(origin: string): Open {
  return async (pathname, protocol) => {
    const socket = new WebSocket(
      `${origin.replace('http:', 'ws:')}${pathname}`,
      protocol === undefined || protocol === '' ? [] : [protocol],
      {
        handshakeTimeout: TIMEOUT_MS,
        perMessageDeflate: false,
      },
    );
    const messages = new Messages();
    const headers = new Headers();
    socket.on('upgrade', (response) => {
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.append(name, value);
      }
    });
    socket.on('message', (value, binary) => {
      const bytes = nodeBytes(value);
      messages.push(binary ? bytes : bytes.toString('utf8'));
    });
    await once(socket, 'open', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return {
      messages,
      headers,
      send: (value) => {
        socket.send(value);
      },
      close: () => {
        socket.close(NORMAL_CLOSURE, 'check finished');
      },
    };
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return port;
}

/** Ask the installed router which HMR path it owns: the name changed after Next.js 16.2. */
async function hmrSurvives(app: string, origin: string): Promise<void> {
  const router = await readFile(
    path.join(app, 'node_modules/next/dist/server/lib/router-server.js'),
    'utf8',
  );
  const paths = new Set(router.match(/\/_next\/(?:webpack-hmr|hmr)/gu));
  assert.equal(paths.size, 1, 'the installed Next.js router must identify one HMR endpoint');
  const [hmr] = paths;
  assert.ok(hmr !== undefined && hmr !== '');
  // Next.js lets assetPrefix replace basePath for HMR. Connecting through /base here would mask
  // a regression where the bridge routes the real /assets endpoint into application handling.
  const pathname = `${DEV_ASSET_PREFIX}${hmr}`;
  const peer = await networkOpen(origin)(pathname);
  peer.close();
  await hmrRejectsCrossOrigin(origin, pathname);
}

/** Next.js may reject a raw upgrade socket without serializing an ordinary HTTP response. */
async function hmrRejectsCrossOrigin(origin: string, pathname: string): Promise<void> {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${pathname}`, {
    origin: 'https://evil.invalid',
    handshakeTimeout: TIMEOUT_MS,
    perMessageDeflate: false,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Cross-origin HMR rejection timed out'));
      }, TIMEOUT_MS);
      socket.once('open', () => {
        reject(new Error('HMR accepted an origin outside allowedDevOrigins'));
      });
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve();
      });
      // Retained through terminate(): Node emits an error when an unfinished upgrade is aborted.
      socket.on('error', () => {
        resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    socket.terminate();
  }
}

async function development(app: string, upwind: boolean): Promise<void> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const next = path.join(app, 'node_modules/next/dist/bin/next');
  const cli = path.join(ROOT, 'packages/upwind/dist/cli.js');
  const preload = path.join(ROOT, 'packages/upwind/dist/websocket-dev.js');
  const child = spawn(
    process.execPath,
    [upwind ? cli : next, 'dev', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        UPWIND_WEBSOCKET_BASE_PATH: DEV_BASE_PATH,
        UPWIND_WEBSOCKET_ASSET_PREFIX: DEV_ASSET_PREFIX,
        UPWIND_DURABLE_OBJECTS: DO_REGISTRATION,
        NEXT_ADAPTER_PATH: path.join(ROOT, 'packages/adapter/dist/index.js'),
        ...(!upwind && {
          NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import=${preload}`.trim(),
        }),
      },
    },
  );
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`dev startup timed out: ${output.slice(-STARTUP_LOG_CHARACTERS)}`));
      }, STARTUP_MS);
      const exited = (code: number | null): void => {
        clearTimeout(timer);
        reject(new Error(`dev exited ${String(code)}: ${output.slice(-STARTUP_LOG_CHARACTERS)}`));
      };
      child.once('exit', exited);
      const read = (chunk: Buffer): void => {
        output += chunk.toString();
        if (/\bready(?: in|\s|$)/iu.test(output)) {
          clearTimeout(timer);
          child.off('exit', exited);
          resolve();
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.once('error', reject);
    });
    // Deliberately no HTTP readiness probe: the first client request is a WebSocket handshake.
    const applicationOrigin = `${origin}${DEV_BASE_PATH}`;
    await exchanges(networkOpen(applicationOrigin));
    await hmrSurvives(app, origin);
    assert.equal((await fetch(`${applicationOrigin}/api/denied`)).status, HTTP_FORBIDDEN);
    assert.match(await (await fetch(applicationOrigin)).text(), /websocket-http-page/u);
  } catch (error) {
    throw new Error(
      `${upwind ? 'upwind dev' : 'next dev preload'}: ${String(error)}\n${output.slice(-FAILURE_LOG_CHARACTERS)}`,
      { cause: error },
    );
  } finally {
    if (child.pid !== undefined && child.exitCode === null) {
      const exited = once(child, 'exit');
      process.kill(-child.pid, 'SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (child.pid !== undefined && child.exitCode === null)
              process.kill(-child.pid, 'SIGKILL');
            resolve();
          }, SHUTDOWN_MS);
        }),
      ]);
      clearTimeout(timer);
    }
  }
}

/** Real Next.js routes, first in workerd and optionally through both development launchers. */
export async function websocketHolds(
  bundle: DeploymentBundle,
  _dependencies: unknown,
  out: string,
): Promise<string[]> {
  const { Miniflare } = await import('miniflare');
  const app = path.dirname(out);
  const runtime = new Miniflare({
    workers: [
      await functionWorker('websocket-app', workerApp(bundle), out, {
        CHAT: { type: 'durable-object', worker: 'chat', exportName: 'Chat' },
        ARKOR_RESOURCES: {
          type: 'text',
          value: JSON.stringify([{ name: 'CHAT', type: 'durable_object_namespace' }]),
        },
      }),
      {
        config: {
          name: 'chat',
          compatibilityDate: '2026-09-15',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'chat.js',
            modules: {
              'chat.js': {
                type: 'esm',
                contents: await readFile(path.join(app, 'chat.js'), 'utf8'),
              },
            },
          },
          exports: { Chat: { type: 'durable-object', storage: 'sqlite' } },
        },
      },
    ],
  });
  try {
    await exchanges(workerOpen(runtime));
    const denied = await runtime.dispatchFetch(`${WORKER_ORIGIN}/api/denied`, {
      headers: { upgrade: 'websocket' },
    });
    assert.equal(denied.status, HTTP_FORBIDDEN);
    if (process.env['UPWIND_WEBSOCKET_DEV_CHECK'] === '1') {
      await development(app, false);
      await development(app, true);
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  } finally {
    await runtime.dispose();
  }
}
