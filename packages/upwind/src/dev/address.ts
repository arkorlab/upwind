import type { Bound } from './listen.ts';

/**
 * The two addresses a run needs. They are not the same address, and neither is the hostname it was
 * asked to bind.
 *
 * What a developer is told to open is a *name*: the one they asked for, or `localhost` when they asked
 * for every interface, since "every interface" is not somewhere a browser can be sent. What the
 * adapter is given is an address this machine reaches itself on, and that one is derived from the
 * socket rather than from the request — a server told nothing binds `::` where there is an IPv6 stack
 * and `0.0.0.0` where there is not, and only the socket knows which happened.
 */

/** Addresses that mean "every interface", which is not somewhere anything can be sent. */
const ANY_INTERFACE: ReadonlySet<string> = new Set(['', '0.0.0.0', '::', '[::]']);

/** An IPv6 literal needs brackets inside a URL; a name or an IPv4 literal must not have them. */
function inUrl(host: string): string {
  if (!host.includes(':') || host.startsWith('[')) {
    return host;
  }
  return `[${host}]`;
}

/**
 * A socket on every interface is reached at loopback; any other, at itself.
 *
 * IPv4 loopback for either wildcard, including `::`, which is a dual-stack socket everywhere this
 * runs — and which therefore answers on `127.0.0.1` as well. It has to be the IPv4 spelling for the
 * reason `internalAddress` gives.
 */
function loopbackFor(address: string): string {
  return ANY_INTERFACE.has(address) ? '127.0.0.1' : address;
}

/** Where to tell a developer to go: the hostname asked for, or `localhost` when any would do. */
export function displayAddress(hostname: string | undefined, port: number): string {
  const host = hostname === undefined || ANY_INTERFACE.has(hostname) ? 'localhost' : hostname;
  return `http://${inUrl(host)}:${port}`;
}

/**
 * The host to reach the socket by: the name that was asked for, when there is one that can be written
 * into a rewrite, and otherwise the address the socket is on.
 *
 * A name is preferred because it is the one thing known to be right: a `--hostname dev.local` that
 * resolves to IPv6 binds an address no rewrite can carry, while the name itself carries perfectly well —
 * and whether it reaches this socket is something the caller goes on to ask.
 */
function internalHost(bound: Bound, hostname: string | undefined): string | undefined {
  if (hostname !== undefined && hostname !== '' && !ANY_INTERFACE.has(hostname)) {
    return inUrl(hostname);
  }
  return bound.address === undefined ? undefined : inUrl(loopbackFor(bound.address));
}

/**
 * Where this machine reaches the socket: what `UPWIND_DEV_ADDRESS` carries, so the adapter's
 * reservation names a destination the dev server can open a connection to.
 *
 * Loopback rather than `localhost` for a socket on every interface, since `localhost` resolves to
 * whichever of `127.0.0.1` and `::1` the resolver prefers, and a server bound to `0.0.0.0` answers only
 * on the first.
 *
 * Nothing, for an address this cannot hand over. An IPv6 one is such an address: Next.js compiles a
 * rewrite's destination with path-to-regexp, which reads `:` as the start of a parameter name, so
 * `http://[::1]:3000` fails to compile and takes the dev server's whole route resolution down with it.
 * A zone identifier (`fe80::1%eth0`) is not a thing a URL can hold at all. The reservation is then left
 * unmade — the front door answers the prefix either way — which is the lesser of the two.
 */
export function internalAddress(bound: Bound, hostname: string | undefined): string | undefined {
  const host = internalHost(bound, hostname);
  if (host === undefined || host.includes(':')) {
    return undefined;
  }
  const candidate = `http://${host}:${bound.port}`;
  return URL.canParse(candidate) ? candidate : undefined;
}
