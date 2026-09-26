import { connect } from 'node:net';

/**
 * Is this address one this machine reaches the server on?
 *
 * Asked rather than assumed, because the answer depends on the host. A socket bound to `::` is
 * dual-stack nearly everywhere, and IPv4 loopback reaches it — but not on a host with no IPv4 stack, nor
 * on one where `bindv6only` is set. The address the adapter is given has to be one that works, and the
 * cheapest way to know is to open a connection to it and see.
 *
 * Reaching a socket this process is itself listening on is immediate or never, so the wait is short and
 * a failure is an answer rather than a delay.
 */
const PROBE_TIMEOUT_MS = 500;

export async function reachable(address: string): Promise<boolean> {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  let settled = false;
  const settle = (answer: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    socket.destroy();
    resolve(answer);
  };
  socket.setTimeout(PROBE_TIMEOUT_MS, () => {
    settle(false);
  });
  socket.once('connect', () => {
    settle(true);
  });
  socket.once('error', () => {
    settle(false);
  });
  return promise;
}
