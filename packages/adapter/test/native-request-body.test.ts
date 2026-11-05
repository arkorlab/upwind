import { once } from 'node:events';
import {
  Agent,
  type ClientRequest,
  createServer,
  request as httpRequest,
  type Server,
} from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { nativeRequest, writeNativeResponse } from '../src/native/http.ts';

const KIB = 1024;
const LATE_READ = "Can't read from request stream after response has been sent.";

interface Exchange {
  readonly status: number;
  readonly text: string;
  readonly socket: Socket;
}

const servers: Server[] = [];
const agents: Agent[] = [];

/** A native boundary whose application answers what `answer` makes of the request. */
async function boundary(
  answer: (request: Request) => Promise<string> | string = (request) =>
    `answered ${request.method}`,
): Promise<string> {
  const server = createServer((req, res) => {
    const request = nativeRequest(req, res);
    const respond = async (): Promise<void> => {
      await writeNativeResponse(req, res, new Response(await answer(request)));
    };
    void respond().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : undefined);
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no listener');
  return `http://127.0.0.1:${String(address.port)}`;
}

/** One connection at most, kept between requests. */
function keptAgent(): Agent {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  agents.push(agent);
  return agent;
}

const PIECE = 8 * KIB;
const PIECE_GAP_MS = 10;

/**
 * Write `bytes` in pieces a little apart, then end the request: each comes in a read of its own, so
 * a server that stops reading once the request's buffer fills leaves the later ones on the socket.
 */
function sendInPieces(client: ClientRequest, bytes: number): void {
  const piece = Math.min(PIECE, bytes);
  if (bytes === piece) {
    client.end(Buffer.alloc(piece));
    return;
  }
  client.write(Buffer.alloc(piece));
  setTimeout(() => {
    sendInPieces(client, bytes - piece);
  }, PIECE_GAP_MS);
}

/**
 * Send `sent` bytes of a body declared `declared` bytes long, take the answer, then send `after`
 * more bytes, if any, and end the request.
 */
async function exchange(
  url: string,
  agent: Agent,
  body?: { declared: number; sent: number; after?: number },
): Promise<Exchange> {
  return new Promise<Exchange>((resolve, reject) => {
    const client = httpRequest(url, {
      agent,
      method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && { headers: { 'content-length': String(body.declared) } }),
    });
    // A connection the server closes may fail the request after its answer has come: past then,
    // that is the outcome under test, not a failure of the exchange.
    client.on('error', reject);
    let connection: Socket | undefined;
    client.once('socket', (socket) => {
      connection = socket;
      socket.on('error', () => {
        // Reported to the request above.
      });
    });
    client.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.once('end', () => {
        if (connection === undefined) {
          reject(new Error('answered before a connection was assigned'));
          return;
        }
        if (body?.after !== undefined) sendInPieces(client, body.after);
        resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString(),
          socket: connection,
        });
      });
    });
    if (body === undefined) client.end();
    else if (body.after === undefined && body.sent === body.declared)
      client.end(Buffer.alloc(body.sent));
    else client.write(Buffer.alloc(body.sent));
  });
}

/** A boundary whose application answers first, and reads its body 50 ms later. */
async function readingLate(): Promise<{ url: string; late: Promise<unknown> }> {
  const late = Promise.withResolvers<unknown>();
  const url = await boundary((request) => {
    if (request.body === null) return 'answered GET';
    const readLate = async (): Promise<void> => {
      await delay(50);
      late.resolve(await request.text());
    };
    void readLate().catch((error: unknown) => {
      late.resolve(error);
    });
    return 'answered first';
  });
  return { url, late: late.promise };
}

/**
 * Resolves once the connection is closed, at once if it already is. Not `once(socket, 'close')`,
 * which rejects on the `EPIPE` of a body still being sent as the server closes the connection.
 */
async function closedOf(socket: Socket): Promise<void> {
  if (socket.closed) return;
  await new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
  });
}

describe('a request body its answer leaves unread', () => {
  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.destroy();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('keeps the connection of a body read to its end', async () => {
    const url = await boundary(async (request) => `read ${String((await request.text()).length)}`);
    const agent = keptAgent();

    const first = await exchange(url, agent, { declared: 256 * KIB, sent: 256 * KIB });
    const next = await exchange(url, agent);

    expect(first).toMatchObject({ status: 200, text: `read ${String(256 * KIB)}` });
    expect(next).toMatchObject({ status: 200 });
    expect(next.socket).toBe(first.socket);
  });

  it('reads the rest within the grace, and the connection carries the next request', async () => {
    const url = await boundary();
    const agent = keptAgent();

    // The answer goes out with 48 KiB of the body still to come: the client sends it after.
    const first = await exchange(url, agent, {
      declared: 64 * KIB,
      sent: 16 * KIB,
      after: 48 * KIB,
    });
    // Asked while the body is still being sent, it waits for the connection, which the agent hands
    // it without counting it reused (`reusedSocket` is set only for an idle one), so it is compared.
    const next = await exchange(url, agent);

    expect(first).toMatchObject({ status: 200, text: 'answered POST' });
    expect(next).toMatchObject({ status: 200, text: 'answered GET' });
    expect(next.socket).toBe(first.socket);
  });

  it('closes the connection after its answer when more than the grace is left', async () => {
    const url = await boundary();
    const agent = keptAgent();
    const started = performance.now();

    const first = await exchange(url, agent, { declared: 4096 * KIB, sent: 4096 * KIB });

    expect(first).toMatchObject({ status: 200, text: 'answered POST' });

    await closedOf(first.socket);

    // Not after a timeout: closed once its answer is out, and a moment for the client to read it.
    expect(performance.now() - started).toBeLessThan(3000);

    const next = await exchange(url, agent);

    expect(next).toMatchObject({ status: 200, text: 'answered GET' });
    expect(next.socket).not.toBe(first.socket);
  });

  it('closes the connection when the rest does not come within the grace', async () => {
    const url = await boundary();
    const started = performance.now();

    // The client sends 8 KiB of 64 KiB, and no more.
    const stalled = await exchange(url, keptAgent(), { declared: 64 * KIB, sent: 8 * KIB });

    expect(stalled).toMatchObject({ status: 200, text: 'answered POST' });

    await closedOf(stalled.socket);

    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('answers on the connection when the application cancels the body', async () => {
    const url = await boundary(async (request) => {
      await request.body?.cancel('unused');
      return 'answered without the body';
    });
    const agent = keptAgent();
    const started = performance.now();

    await expect(
      exchange(url, agent, { declared: 4096 * KIB, sent: 4096 * KIB }),
    ).resolves.toMatchObject({ status: 200, text: 'answered without the body' });
    await expect(exchange(url, agent)).resolves.toMatchObject({
      status: 200,
      text: 'answered without the body',
    });
    // Not after a timeout: the unread body's connection is closed once its answer is out.
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('fails a read of the body begun after its answer has gone out', async () => {
    const { url, late } = await readingLate();

    await expect(
      exchange(url, keptAgent(), { declared: 64 * KIB, sent: 8 * KIB, after: 56 * KIB }),
    ).resolves.toMatchObject({ status: 200, text: 'answered first' });
    await expect(late).resolves.toStrictEqual(new TypeError(LATE_READ));
  });

  it('fails a late read of a body received whole, and keeps its connection', async () => {
    const { url, late } = await readingLate();
    const agent = keptAgent();

    const first = await exchange(url, agent, { declared: 2 * KIB, sent: 2 * KIB });
    const next = await exchange(url, agent);

    expect(first).toMatchObject({ status: 200, text: 'answered first' });
    await expect(late).resolves.toStrictEqual(new TypeError(LATE_READ));
    expect(next).toMatchObject({ status: 200, text: 'answered GET' });
    expect(next.socket).toBe(first.socket);
  });
});
