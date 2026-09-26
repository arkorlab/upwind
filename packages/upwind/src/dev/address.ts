/**
 * The two addresses a run needs, from the one hostname it was asked to bind.
 *
 * They differ, and have to: a server told to bind every interface has no single name a browser should
 * be sent to, and the loopback address the adapter puts in a rewrite destination must be one the
 * machine can reach itself on.
 */

/** Hostnames that mean "every interface", which is not an address anything can be sent to. */
const ANY_INTERFACE: ReadonlySet<string> = new Set(['', '0.0.0.0', '::', '[::]']);
/** Of those, the ones that bind IPv6, whose loopback is not `127.0.0.1`. */
const ANY_INTERFACE_IPV6: ReadonlySet<string> = new Set(['::', '[::]']);

/** An IPv6 literal needs brackets inside a URL; a name or an IPv4 literal must not have them. */
function inUrl(host: string): string {
  if (!host.includes(':') || host.startsWith('[')) {
    return host;
  }
  return `[${host}]`;
}

/** Where to tell a developer to go: the hostname asked for, or `localhost` when any would do. */
export function displayAddress(hostname: string | undefined, port: number): string {
  const host = hostname === undefined || ANY_INTERFACE.has(hostname) ? 'localhost' : hostname;
  return `http://${inUrl(host)}:${port}`;
}

/**
 * Where this machine reaches itself: what `UPWIND_DEV_ADDRESS` carries, so the adapter's reservation
 * names a destination the dev server can actually open a connection to.
 *
 * A wildcard becomes loopback rather than `localhost`, which resolves to whichever of `127.0.0.1` and
 * `::1` the resolver prefers — and a server bound to `0.0.0.0` answers only on the first.
 */
export function loopbackAddress(hostname: string | undefined, port: number): string {
  if (hostname === undefined || ANY_INTERFACE.has(hostname)) {
    const loopback =
      hostname !== undefined && ANY_INTERFACE_IPV6.has(hostname) ? '[::1]' : '127.0.0.1';
    return `http://${loopback}:${port}`;
  }
  return `http://${inUrl(hostname)}:${port}`;
}
