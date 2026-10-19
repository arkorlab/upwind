import net from 'node:net';

/**
 * Where a stack serves its site: both loopback addresses where the machine has both, on one port,
 * since `localhost` — the name it is served as — resolves to either as the machine chooses. A
 * client that resolves it to the one address that is not bound would find nothing there.
 */
export interface Loopback {
  readonly hosts: readonly string[];
  readonly port: number;
}

const IPV4_LOOPBACK = '127.0.0.1';
const IPV6_LOOPBACK = '::1';
/** How many ports the system hands out are tried before one free on both addresses is given up. */
const ATTEMPTS = 20;
/** The highest port a socket listens on. */
const MAX_PORT = 65_535;
/** What a machine without the IPv6 loopback answers a listen on it with. */
const NO_SUCH_ADDRESS: ReadonlySet<string> = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

type Listened =
  | { readonly kind: 'listening'; readonly server: net.Server }
  | { readonly kind: 'refused'; readonly error: NodeJS.ErrnoException };

/** A server listening at `host:port`, or why it could not. */
function listenOn(host: string, port: number): Promise<Listened> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ kind: 'refused', error });
    });
    server.listen({ host, port, exclusive: true }, () => {
      resolve({ kind: 'listening', server });
    });
  });
}

function closed(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/**
 * A port free on both loopback addresses — the one asked for, or one the system hands out — and the
 * addresses to bind it on. Probed and let go before the stack binds it, so another process could
 * take it in between; a stack that then fails to start says so.
 */
/** What is asked for, refused where it is no port: as what it is, not as a listen on it throws. */
function assertPort(asked: number): void {
  if (!(Number.isSafeInteger(asked) && asked >= 0 && asked <= MAX_PORT)) {
    throw new Error(`a port is a whole number from 0 to ${MAX_PORT}, not ${String(asked)}`);
  }
}

export async function loopbackFor(asked: number | undefined): Promise<Loopback> {
  if (asked !== undefined) {
    assertPort(asked);
  }
  // Port 0 asks for any, which another is tried for, as where none is named.
  const named = asked !== undefined && asked !== 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const v4 = await listenOn(IPV4_LOOPBACK, asked ?? 0);
    if (v4.kind === 'refused') {
      throw new Error(
        `cannot serve on ${IPV4_LOOPBACK}:${String(asked ?? 0)}: ${v4.error.message}`,
      );
    }
    const address = v4.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const v6 = await listenOn(IPV6_LOOPBACK, port);
    await closed(v4.server);
    if (v6.kind === 'listening') {
      await closed(v6.server);
      return { hosts: [IPV4_LOOPBACK, IPV6_LOOPBACK], port };
    }
    if (NO_SUCH_ADDRESS.has(v6.error.code ?? '')) {
      return { hosts: [IPV4_LOOPBACK], port };
    }
    if (named) {
      throw new Error(`cannot serve on [${IPV6_LOOPBACK}]:${String(port)}: ${v6.error.message}`);
    }
  }
  throw new Error(`no port was free on both ${IPV4_LOOPBACK} and ${IPV6_LOOPBACK}`);
}
