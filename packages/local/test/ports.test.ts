import net from 'node:net';

import { describe, expect, it } from 'vitest';

import { loopbackFor } from '../src/ports.ts';

describe('where a stack serves its site', () => {
  it('is one port free on every loopback address the machine has', async () => {
    const loopback = await loopbackFor(undefined);

    expect(loopback.hosts[0]).toBe('127.0.0.1');
    expect(loopback.port).toBeGreaterThan(0);
  });

  it('is any free port where port 0 is asked for, as where none is', async () => {
    const loopback = await loopbackFor(0);

    expect(loopback.port).toBeGreaterThan(0);
  });

  it('is refused where what is asked for is no port', async () => {
    await expect(loopbackFor(NaN)).rejects.toThrow(
      'a port is a whole number from 0 to 65535, not NaN',
    );
    await expect(loopbackFor(70_000)).rejects.toThrow('not 70000');
  });

  it('is refused where the port asked for is taken', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => {
      taken.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const { port } = taken.address() as net.AddressInfo;

    await expect(loopbackFor(port)).rejects.toThrow(`cannot serve on 127.0.0.1:${String(port)}`);

    await new Promise<void>((resolve) => {
      taken.close(() => {
        resolve();
      });
    });
  });
});
