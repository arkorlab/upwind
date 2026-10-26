import type { AddressInfo } from 'node:net';

/**
 * The server's own address once it listens: the URL it says it serves on, and the port it bound
 * written back to `PORT`, as `next start` writes it (`server/lib/start-server.js`). Asked for port
 * `0`, as `upwind start --port 0` asks, the system picks one; and the application's code that reads
 * `process.env.PORT` to reach its own server — `http://localhost:${process.env.PORT}`, a common way to
 * fetch one's own route during a render — would otherwise read the `0` it was started with, and fetch
 * nothing. A port asked for by number is written back as it was.
 *
 * `__NEXT_PRIVATE_ORIGIN`, which `next start` writes beside it, is left alone: the one reader the
 * server runs, the Server Actions handler, falls back to the request's own `initURL`, which the runtime
 * gives every render as the client asked it; the loopback address in its place would send a forwarded
 * action past whatever origin the server is published at (`UPWIND_NODE_ORIGIN`).
 */
export function listeningOn(address: AddressInfo, env: Record<string, string | undefined>): string {
  env['PORT'] = String(address.port);
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}`;
}
