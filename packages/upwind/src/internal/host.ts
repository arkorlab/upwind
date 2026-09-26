import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

/**
 * Which host a request for `/__upwind` may claim.
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
 * have asked for — compared as a browser would send it, since a name outside ASCII travels as its
 * `xn--` form and would otherwise never equal the one that was typed.
 *
 * *Every* name a request claims has to pass, not only the one in `Host`. The adapter's reservation sends
 * an internally rewritten `/__upwind` back here over HTTP, and Next.js's proxy replaces `Host` with this
 * server's own address and puts the name the client used in `x-forwarded-host` — so reading `Host`
 * alone would have this door trust a request it made to itself on behalf of somebody it should not.
 *
 * Only these endpoints are held to any of it. The application is Next.js's to answer, under whatever
 * name a developer has put in front of it, and Next.js has its own say about a cross-site dev request.
 */

/** A name without the dot that says "from the root": `localhost.` is `localhost`, typed precisely. */
function withoutRootDot(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

/** The hostname a host header carries, without the port, and without an IPv6 literal's brackets. */
function hostnameOf(header: string): string | undefined {
  const trimmed = header.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? undefined : trimmed.slice(1, close);
  }
  // The dot goes after the port is off, not before: `localhost.:3000` ends in a digit, and it is the
  // name in front of the colon that was written from the root.
  const [name = ''] = trimmed.split(':', 1);
  const host = withoutRootDot(name);
  return host === '' ? undefined : host;
}

/** A name as a browser sends it: the ASCII form, or the name itself where there is no other. */
function canonical(name: string): string {
  const trimmed = withoutRootDot(name.trim().toLowerCase());
  return domainToASCII(trimmed) || trimmed;
}

/** One claimed name, against what this run answers for. */
function isTrustedName(header: string, bound: string | undefined): boolean {
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
  return bound !== undefined && canonical(host) === canonical(bound);
}

/** The names an `x-forwarded-host` carries: one per proxy, however they were folded together. */
function forwardedNames(forwarded: string | readonly string[] | undefined): string[] {
  if (forwarded === undefined) {
    return [];
  }
  const values = typeof forwarded === 'string' ? [forwarded] : forwarded;
  return values.flatMap((value) => value.split(',')).filter((value) => value.trim() !== '');
}

export function isTrustedHost(
  host: string | undefined,
  forwarded: string | readonly string[] | undefined,
  bound: string | undefined,
): boolean {
  if (host === undefined) {
    // A request with no `Host` is not one HTTP/1.1 allows, and a name that was never given is not one
    // this can recognise. Nothing a browser sends arrives this way.
    return false;
  }
  return (
    isTrustedName(host, bound) &&
    forwardedNames(forwarded).every((name) => isTrustedName(name, bound))
  );
}
