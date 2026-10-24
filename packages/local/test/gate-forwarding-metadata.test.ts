import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

import { GATE_URL_HEADER } from '@stayingupwind/host/bindings';
import { describe, expect, it } from 'vitest';

import { gateForwarder } from '../src/gates.ts';
import { GATE_UNREACHABLE_HEADER } from '../src/workers/protocol.ts';

/** A real gate endpoint, closed with all of the transport's connections. */
async function gate(answer: RequestListener) {
  const server = createServer(answer);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/gate`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

/** The navigation metadata the visitor supplied, unchanged by the local authority transport. */
function navigation(method = 'GET'): Request {
  return new Request('https://site.example/board?tab=open', {
    method,
    headers: {
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-dest': 'document',
    },
  });
}

describe('the ordinary local gate transport', () => {
  it.each(['GET', 'HEAD'])(
    'keeps the visitor Fetch Metadata at the real gate endpoint for %s',
    async (method) => {
      const seen: unknown[] = [];
      const remote = await gate((request, response) => {
        seen.push({
          dest: request.headers['sec-fetch-dest'],
          mode: request.headers['sec-fetch-mode'],
          site: request.headers['sec-fetch-site'],
          url: request.headers[GATE_URL_HEADER],
        });
        response.end();
      });
      try {
        const response = await gateForwarder({ url: remote.url })(navigation(method));
        await response.arrayBuffer();

        expect(response.status).toBe(200);
        expect(seen).toStrictEqual([
          {
            dest: 'document',
            mode: 'navigate',
            site: 'same-origin',
            url: 'https://site.example/board?tab=open',
          },
        ]);
      } finally {
        await remote.close();
      }
    },
  );

  it.each([200, 403, 503])(
    'keeps a real remote %s response distinct from a local unreachable marker',
    async (status) => {
      const remote = await gate((request, response) => {
        response.writeHead(status, {
          [GATE_UNREACHABLE_HEADER]: request.headers[GATE_UNREACHABLE_HEADER] ?? 'remote value',
          'x-remote': 'answered',
        });
        response.end('the remote answered');
      });
      try {
        const request = navigation();
        request.headers.set(GATE_UNREACHABLE_HEADER, 'reflected visitor value');
        const response = await gateForwarder({ url: remote.url })(request);
        const body = await response.text();

        expect(response.status).toBe(status);
        expect(response.headers.has(GATE_UNREACHABLE_HEADER)).toBe(false);
        expect(response.headers.get('x-remote')).toBe('answered');
        expect(body).toBe('the remote answered');
      } finally {
        await remote.close();
      }
    },
  );

  it('retains an ordinary redirect and repeated cookies without following it', async () => {
    const remote = await gate((_request, response) => {
      response.writeHead(307, {
        location: '/next',
        'set-cookie': ['first=1; Path=/', 'second=2; Path=/'],
      });
      response.end('redirect');
    });
    try {
      const response = await gateForwarder({ url: remote.url })(navigation());
      const body = await response.text();

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('/next');
      expect(response.headers.getSetCookie()).toStrictEqual([
        'first=1; Path=/',
        'second=2; Path=/',
      ]);
      expect(body).toBe('redirect');
    } finally {
      await remote.close();
    }
  });
});
