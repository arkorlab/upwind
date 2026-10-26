import { once } from 'node:events';
import { type AddressInfo, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { accepting } from './local-server.ts';

/** How long anything the readiness check sent would take to arrive, were it to send any. */
const ARRIVAL_MS = 300;
/** How long the check is given on a port nothing takes. */
const CLOSED_MS = 1500;

/**
 * The readiness check of a server of this machine's (`local-server.ts`), against one that counts what
 * it is sent: it waits for a connection the server takes and sends nothing over it, so the first
 * request an application sees is one of the suite's — a `GET /` of the check's ran the root layout and
 * the middleware ahead of the tests (greptile) — and it gives up on a port nothing takes.
 */
export async function readinessScenario(
  holds: (message: string, condition: boolean) => void,
): Promise<void> {
  let connections = 0;
  let received = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      // Answered, so that a check that does ask something gets through and is told it asked, rather
      // than waiting on a server that says nothing.
      socket.end('HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  try {
    await accepting(url, Date.now() + CLOSED_MS);
    await sleep(ARRIVAL_MS);
    holds(
      'the readiness check of a local server waits for a connection it takes',
      connections === 1,
    );
    holds('and sends the application nothing over it', received === 0);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  let refused = false;
  try {
    await accepting(url, Date.now() + CLOSED_MS);
  } catch {
    refused = true;
  }
  holds('and gives up on a port nothing takes', refused);
}
