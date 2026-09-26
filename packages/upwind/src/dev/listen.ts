import type { Server } from 'node:http';

/**
 * Bind the port the developer asked for, or the next one free.
 *
 * `next dev` moves up to ten ports when one is taken rather than refusing to start, and a developer
 * who has run two of these at once expects that. What it settled on is returned rather than read back
 * off the server by every caller, because everything else — the banner, the address the adapter is
 * given, the `port` Next.js is constructed with — has to name the same one.
 */
const PORT_RETRIES = 10;

/** The last port there is. A candidate past it is not a port, and `listen` refuses it as a range error. */
export const MAX_PORT = 65_535;

export interface Bound {
  /** The port the socket is on: what was asked for, or what the kernel gave a `--port 0` run. */
  readonly port: number;
  /**
   * The address the socket is on, as the socket reports it — `::` or `0.0.0.0` for a server that
   * took every interface. Not the hostname that was asked for: that one may be a name, and on a host
   * with no IPv4 stack "unspecified" is an IPv6 socket, which nothing at `127.0.0.1` can reach.
   */
  readonly address: string | undefined;
}

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

/** Where the socket ended up, as the socket says it. */
function boundOf(server: Server, asked: number): Bound {
  const address = server.address();
  if (typeof address === 'object' && address !== null) {
    return { port: address.port, address: address.address };
  }
  return { port: asked, address: undefined };
}

export async function listen(
  server: Server,
  port: number,
  hostname: string | undefined,
): Promise<Bound> {
  let candidate = port;
  let retries = 0;
  for (;;) {
    try {
      await listenOnce(server, candidate, hostname);
      return boundOf(server, candidate);
    } catch (error) {
      // Past the last port there is nothing to move up to, and the port being in use is the truer
      // thing to say than the range error the next attempt would raise.
      if (retries >= PORT_RETRIES || candidate >= MAX_PORT || !isAddressInUse(error)) {
        throw error;
      }
      retries += 1;
      console.warn(`upwind: port ${candidate} is in use, trying ${candidate + 1} instead`);
      candidate += 1;
    }
  }
}
