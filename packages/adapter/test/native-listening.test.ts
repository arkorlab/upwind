import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { listeningOn } from '../src/native/listening.ts';

/** A server listening as the native server listens: on the port asked for, on the given address. */
async function listened(
  port: number,
  hostname: string,
): Promise<{ server: Server; address: AddressInfo }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return { server, address };
}

async function closed(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe('the native server once it listens', () => {
  it('writes the port the system picked for port 0 back to PORT, as next start does', async () => {
    const env: Record<string, string | undefined> = { PORT: '0' };
    const { server, address } = await listened(0, '127.0.0.1');
    try {
      const url = listeningOn(address, env);

      expect(address.port).toBeGreaterThan(0);
      expect(env['PORT']).toBe(String(address.port));
      expect(url).toBe(`http://127.0.0.1:${String(address.port)}`);
    } finally {
      await closed(server);
    }
  });

  it('keeps a port asked for by number, and brackets an IPv6 address', () => {
    const env: Record<string, string | undefined> = { PORT: '3000' };

    expect(listeningOn({ address: '::1', family: 'IPv6', port: 3000 }, env)).toBe(
      'http://[::1]:3000',
    );
    expect(env['PORT']).toBe('3000');
  });
});
