import { isIP } from 'node:net';

/**
 * Which `Host` a request for `/__upwind` may carry.
 *
 * A dev server on every interface is reachable under any name that resolves to the machine, and the
 * browser's notion of an origin is the name that was typed. So a page served from `evil.test:3000`
 * — a name whose DNS points at loopback — is *same-origin* with these endpoints, and the same-origin
 * policy that otherwise keeps their answers private stops keeping them private. That is a rebinding
 * attack, and what it would read here is where the project is on disk.
 *
 * The rule is the one Vite settled on: a name has to be one that cannot be pointed somewhere else. An
 * address literal is such a name, since DNS has no part in it. `localhost` and anything under it are
 * reserved for loopback (RFC 6761). And a name the developer asked this server to bind is theirs to
 * have asked for.
 *
 * Only these endpoints are held to it. The application is Next.js's to answer, under whatever name a
 * developer has put in front of it, and Next.js has its own say about a cross-site dev request.
 */

/** The hostname a `Host` header carries, without the port, and without an IPv6 literal's brackets. */
function hostnameOf(header: string): string | undefined {
  const trimmed = header.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? undefined : trimmed.slice(1, close);
  }
  const [name] = trimmed.split(':', 1);
  return name === undefined || name === '' ? undefined : name;
}

export function isTrustedHost(header: string | undefined, bound: string | undefined): boolean {
  if (header === undefined) {
    // Nothing to spoof: a browser always sends one, so this is a client speaking HTTP/1.0 to a port it
    // already knows.
    return true;
  }
  const host = hostnameOf(header);
  if (host === undefined) {
    return false;
  }
  if (isIP(host) !== 0) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  return host === bound?.trim().toLowerCase();
}
