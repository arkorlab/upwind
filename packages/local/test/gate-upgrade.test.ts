import { once } from 'node:events';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { gzipSync } from 'node:zlib';

import { GATE_ANSWER_HEADER, GATE_PASS, GATE_URL_HEADER } from '@stayingupwind/host/bindings';
import { describe, expect, it } from 'vitest';

import { gateForwarder, gateServices } from '../src/gates.ts';
import { type LocalWorker, runWorkers } from '../src/miniflare.ts';
import { GATE_UNREACHABLE_HEADER } from '../src/workers/protocol.ts';

/** A gate that authorizes an upgrade without upgrading its own authorization connection. */
async function startGate(answer: RequestListener) {
  const server = createServer(answer);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${String(port)}/gate`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

/** The connection the gate is next asked on, closed when its answer is let go of. */
async function closedConnection(server: Server): Promise<void> {
  const socket = await new Promise<Socket>((resolve) => {
    server.once('connection', resolve);
  });
  await once(socket, 'close');
}

/** The visitor's WebSocket handshake, which remains the application's to finish after a pass. */
function upgrade(signal?: AbortSignal): Request {
  return new Request('https://site.example/gated', {
    headers: { upgrade: 'websocket', connection: 'Upgrade', cookie: 'theme=dark' },
    ...(signal !== undefined && { signal }),
  });
}

describe('a local gate authorizing a WebSocket request', () => {
  it.each([
    ['passes', 200, { [GATE_ANSWER_HEADER]: GATE_PASS }, ''],
    ['refuses', 403, { 'x-refused': 'yes' }, 'denied'],
  ] as const)('forwards the handshake when the gate %s', async (_, status, headers, body) => {
    const gate = await startGate((request, response) => {
      expect({
        upgrade: request.headers.upgrade,
        connection: request.headers.connection,
        cookie: request.headers.cookie,
        url: request.headers[GATE_URL_HEADER],
      }).toStrictEqual({
        upgrade: 'websocket',
        connection: 'Upgrade',
        cookie: 'theme=dark',
        url: 'https://site.example/gated',
      });

      response.writeHead(status, { ...headers, 'set-cookie': ['a=1', 'b=2'] });
      response.end(body);
    });
    try {
      const answer = await gateForwarder({ url: gate.url })(upgrade());

      expect(answer.status).toBe(status);
      expect(answer.headers.getSetCookie()).toStrictEqual(['a=1', 'b=2']);
      expect(answer.headers.has(GATE_UNREACHABLE_HEADER)).toBe(false);
      expect(answer.headers.get(GATE_ANSWER_HEADER)).toBe(
        new Headers(headers).get(GATE_ANSWER_HEADER),
      );
      await expect(answer.text()).resolves.toBe(body);
    } finally {
      await gate.close();
    }
  });

  it.each([undefined, 'keep-alive'])(
    'restores the connection header stripped by the loopback transport: %s',
    async (connection) => {
      const seen: (string | undefined)[] = [];
      const gate = await startGate((request, response) => {
        seen.push(request.headers.connection);
        const allowed = request.headers.connection?.toLowerCase() === 'upgrade';
        response.writeHead(allowed ? 200 : 403, {
          [GATE_ANSWER_HEADER]: allowed ? GATE_PASS : 'denied',
        });
        response.end();
      });
      try {
        const headers = new Headers({ upgrade: 'websocket' });
        if (connection !== undefined) headers.set('connection', connection);
        const request = new Request('https://site.example/gated', { headers });
        const answer = await gateForwarder({ url: gate.url })(request);

        expect(answer.status).toBe(200);
        expect(answer.headers.get(GATE_ANSWER_HEADER)).toBe(GATE_PASS);
        expect(seen).toStrictEqual(['Upgrade']);
      } finally {
        await gate.close();
      }
    },
  );

  it.each(['reader', 'signal'])(
    'streams the unfinished answer and cancels it by %s',
    async (by) => {
      const gate = await startGate((_request, response) => {
        response.writeHead(403);
        response.write('denied');
      });
      const controller = new AbortController();
      try {
        const closed = closedConnection(gate.server);
        const answer = await gateForwarder({ url: gate.url })(upgrade(controller.signal));
        const reader = answer.body?.getReader();

        expect(answer.status).toBe(403);

        const first = await reader?.read();

        expect(new TextDecoder().decode(first?.value)).toBe('denied');

        if (by === 'reader') {
          await reader?.cancel();
        } else {
          controller.abort();
        }
        await closed;
      } finally {
        await gate.close();
      }
    },
  );

  it('keeps the coding of a raw compressed answer beside its unchanged bytes', async () => {
    const bytes = gzipSync('denied');
    const gate = await startGate((_request, response) => {
      response.writeHead(403, { 'content-encoding': 'gzip' });
      response.end(bytes);
    });
    try {
      const answer = await gateForwarder({ url: gate.url })(upgrade());

      expect(answer.status).toBe(403);
      expect(answer.headers.get('content-encoding')).toBe('gzip');
      expect(Buffer.from(await answer.arrayBuffer())).toStrictEqual(bytes);
    } finally {
      await gate.close();
    }
  });

  it('cancels its request when the edge lets go before the gate answers', async () => {
    const gate = await startGate(() => {
      // The gate remains silent until its caller lets go of it.
    });
    const controller = new AbortController();
    try {
      const requested = new Promise<ServerResponse>((resolve) => {
        gate.server.once('request', (_request, response) => {
          resolve(response);
        });
      });
      const answering = gateForwarder({ url: gate.url })(upgrade(controller.signal));
      const response = await requested;
      const closed = once(response, 'close');
      controller.abort();
      const answer = await answering;

      expect(answer.status).toBe(502);
      expect(answer.headers.has(GATE_UNREACHABLE_HEADER)).toBe(true);

      await closed;
    } finally {
      controller.abort();
      await gate.close();
    }
  });

  it('fails closed when the gate upgrades its authorization connection', async () => {
    const gate = await startGate(() => {
      // An upgrade listener answers the handshake instead.
    });
    gate.server.on('upgrade', (_request, socket) => {
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    });
    try {
      const answer = await gateForwarder({ url: gate.url })(upgrade());

      expect(answer.status).toBe(502);
      expect(answer.headers.has(GATE_UNREACHABLE_HEADER)).toBe(true);
    } finally {
      await gate.close();
    }
  });
});

/** A passing gate is decided at its headers, even where its body has not produced one byte. */
describe('a gate pass forwarded through the local service', () => {
  it('reaches the Worker before an unfinished gate body', async () => {
    const gate = await startGate((_request, response) => {
      response.writeHead(200, { [GATE_ANSWER_HEADER]: GATE_PASS });
      response.flushHeaders();
    });
    const worker: LocalWorker = {
      name: 'gate-pass-reader',
      modules: [
        {
          name: 'index.mjs',
          type: 'ESModule',
          contents: `
export default {
  async fetch(_request, env) {
    const answer = await env.GATE__CHECKER.fetch('https://site.example/gated');
    void answer.body?.cancel().catch(() => undefined);
    return new Response(answer.headers.get('${GATE_ANSWER_HEADER}'));
  },
};
`,
        },
      ],
      compatibilityDate: '2026-09-15',
      handlers: gateServices({ checker: { url: gate.url } }),
      socket: {},
    };
    try {
      const running = await runWorkers([worker], () => {
        // No Worker log is needed to observe the passing header.
      });
      try {
        const answer = await fetch(await running.url('gate-pass-reader'), {
          signal: AbortSignal.timeout(5000),
        });

        await expect(answer.text()).resolves.toBe(GATE_PASS);
      } finally {
        await running.dispose();
      }
    } finally {
      await gate.close();
    }
  }, 60_000);
});
