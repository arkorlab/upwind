/** Whether `hostname` is `domain` itself or a name beneath it. Both are already spelled alike. */
function isAtOrUnder(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * A name as DNS compares it: in lower case, and without the root's dot that a fully qualified
 * spelling ends in, which a URL's hostname keeps (`https://example.com./` is `example.com.`).
 */
function spelledAlike(name: string): string {
  return name.toLowerCase().replace(/\.$/u, '');
}

/**
 * Whether the hostname is one of `domains` or a name beneath one.
 *
 * One function for every place that asks, so that a hostname the edge will not fetch from and a
 * hostname a host keeps for itself are judged exactly one way, however either is spelled.
 */
export function isUnderAnyDomain(hostname: string, domains: readonly string[]): boolean {
  const spelled = spelledAlike(hostname);
  return domains.some((domain) => isAtOrUnder(spelled, spelledAlike(domain)));
}
