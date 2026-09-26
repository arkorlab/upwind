import type { Server } from 'node:http';

/**
 * Bind the port the developer asked for, or the next one free.
 *
 * `next dev` moves up to ten ports when one is taken rather than refusing to start, and a developer
 * who has run two of these at once expects that. The port it settled on is returned rather than read
 * back off the server afterwards, because everything else — the banner, the address the adapter is
 * given — has to name the same one.
 */
const PORT_RETRIES = 10;

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE'
  );
}

/** One attempt: resolves when the server is listening, rejects with why it could not. */
async function listenOnce(
  server: Server,
  port: number,
  hostname: string | undefined,
): Promise<void> {
  const { promise, resolve, reject }: PromiseWithResolvers<void> = Promise.withResolvers();
  const failed = (error: Error): void => {
    reject(error);
  };
  // Only this attempt's failure: the handler goes away as soon as the attempt succeeds, so a later
  // error on a listening server is not reported as a failure to start.
  server.once('error', failed);
  server.listen(port, hostname, () => {
    server.off('error', failed);
    resolve();
  });
  return promise;
}

/**
 * The port the socket actually got.
 *
 * `--port 0` asks the kernel to pick one, and everything downstream — the banner, the address the
 * adapter is given, the `port` Next.js is constructed with — has to name the one it picked rather
 * than the zero it was asked for.
 */
function boundPort(server: Server, asked: number): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : asked;
}

export async function listen(
  server: Server,
  port: number,
  hostname: string | undefined,
): Promise<number> {
  let candidate = port;
  let retries = 0;
  for (;;) {
    try {
      await listenOnce(server, candidate, hostname);
      return boundPort(server, candidate);
    } catch (error) {
      if (retries >= PORT_RETRIES || !isAddressInUse(error)) {
        throw error;
      }
      retries += 1;
      console.warn(`upwind: port ${candidate} is in use, trying ${candidate + 1} instead`);
      candidate += 1;
    }
  }
}
