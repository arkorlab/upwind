/** Cookie header helpers (no dependency on any runtime cookie API). */

export interface CookiePair {
  readonly name: string;
  readonly value: string;
}

/** Parse a `Cookie` request header into name/value pairs (values are not decoded). */
export function parseCookieHeader(header: string | null): CookiePair[] {
  if (header === null || header.trim() === '') {
    return [];
  }
  const pairs: CookiePair[] = [];
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      pairs.push({ name: trimmed, value: '' });
      continue;
    }
    pairs.push({ name: trimmed.slice(0, separator).trim(), value: trimmed.slice(separator + 1) });
  }
  return pairs;
}

/** Serialize cookie pairs back into a `Cookie` header value. */
export function serializeCookieHeader(pairs: readonly CookiePair[]): string {
  return pairs.map((pair) => `${pair.name}=${pair.value}`).join('; ');
}

/** Remove the named cookies from a `Cookie` header value; returns `null` when nothing is left. */
export function stripCookies(header: string | null, names: readonly string[]): string | null {
  const remaining = parseCookieHeader(header).filter((pair) => !names.includes(pair.name));
  return remaining.length === 0 ? null : serializeCookieHeader(remaining);
}

/** Look up one cookie value. */
export function getCookieValue(header: string | null, name: string): string | undefined {
  return parseCookieHeader(header).find((pair) => pair.name === name)?.value;
}

const DOMAIN_ATTRIBUTE_RE = /;\s*domain=([^;]*)/giu;

/** The host a response is answered on, and the apex a host's preview hostnames sit under. */
export interface CookieHostContext {
  /** Hostname the client used: a preview host, or a customer's own hostname. */
  readonly previewHost: string;
  /** The apex every preview host is under. */
  readonly previewDomain: string;
}

/** Whether `host` is `domain` itself or under it, as a cookie's `Domain=` scopes it. */
function hostWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Whether a `Domain=` the origin set stays on the cookie: only on a customer's own hostname, and
 * only when that hostname is in the domain. One it is not in would have the browser drop the
 * cookie; and on a preview host any at all is dropped, since previews share one apex and a cookie
 * scoped to it would be sent to every other project's preview.
 */
function keepsDomain(domain: string, ctx: CookieHostContext): boolean {
  const host = ctx.previewHost.toLowerCase();
  if (hostWithin(host, ctx.previewDomain.toLowerCase())) {
    return false;
  }
  const scope = domain.trim().replace(/^\./u, '').toLowerCase();
  return scope !== '' && hostWithin(host, scope);
}

/**
 * Rewrite a `Set-Cookie` value for the host the client used. The origin's `Domain=` attribute
 * is kept when it scopes the cookie to that host and its siblings — a customer's own hostname,
 * sharing a session with the rest of its domain as the application meant — and dropped when it
 * would make the cookie unusable there, or when the host is a preview host, so that the cookie
 * becomes host-only.
 */
export function rewriteSetCookieForPreview(value: string, ctx: CookieHostContext): string {
  return value.replaceAll(DOMAIN_ATTRIBUTE_RE, (attribute: string, domain: string) =>
    keepsDomain(domain, ctx) ? attribute : '',
  );
}
