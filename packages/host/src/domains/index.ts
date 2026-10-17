/** Whether `hostname` is `domain` itself or a name beneath it. Both are already spelled alike. */
function isAtOrUnder(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Anything past ASCII: a name written with it has an ASCII spelling of its own, IDNA's. */
const PAST_ASCII = /\P{ASCII}/u;
/**
 * What a name cannot hold and still be a name alone: white space, an escape, and what ends a URL's
 * host or writes an address literal. The parser would spell the part on one side of it alone, and
 * that is another name: `ü@example.com` would be `example.com`.
 */
const NOT_A_NAME = /[\s#%/:<>?@[\\\]^|]/u;

/**
 * A name in the ASCII spelling a URL's hostname holds: `münich.example` is `xn--mnich-kva.example`
 * there, as IDNA spells it. Spelled by the URL parser, the one a request's hostname went through;
 * a name in ASCII already is not handed to it, nor one it would read as more than a name, and one
 * it refuses keeps the spelling it was given.
 */
function inAscii(name: string): string {
  if (!PAST_ASCII.test(name) || NOT_A_NAME.test(name)) {
    return name;
  }
  try {
    return new URL(`http://${name}`).hostname;
  } catch {
    return name;
  }
}

/**
 * A name as DNS compares it: in the ASCII spelling a URL's hostname holds (`inAscii`), in lower
 * case, and without the root's dot that a fully qualified spelling ends in, which a URL's hostname
 * keeps (`https://example.com./` is `example.com.`).
 */
export function dnsSpelling(name: string): string {
  return inAscii(name).toLowerCase().replace(/\.$/u, '');
}

/**
 * Whether the hostname is one of `domains` or a name beneath one.
 *
 * One function for every place that asks, so that a hostname the edge will not fetch from and a
 * hostname a host keeps for itself are judged exactly one way, however either is spelled.
 */
export function isUnderAnyDomain(hostname: string, domains: readonly string[]): boolean {
  const spelled = dnsSpelling(hostname);
  return domains.some((domain) => isAtOrUnder(spelled, dnsSpelling(domain)));
}
