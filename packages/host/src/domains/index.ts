/** Whether `hostname` is `domain` itself or a name beneath it. Both are already lower-cased. */
function isAtOrUnder(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Whether the hostname is one of `domains` or a name beneath one.
 *
 * One function for every place that asks, so that a hostname the edge will not fetch from and a
 * hostname a host keeps for itself are judged exactly one way.
 */
export function isUnderAnyDomain(hostname: string, domains: readonly string[]): boolean {
  const lowered = hostname.toLowerCase();
  return domains.some((domain) => isAtOrUnder(lowered, domain.toLowerCase()));
}
