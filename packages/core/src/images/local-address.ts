/* eslint-disable @typescript-eslint/no-magic-numbers, no-bitwise, sonarjs/no-hardcoded-ip -- the tables are the registries' own addresses and prefix lengths, and an address is parsed by its bits. */
/**
 * Whether a source's host is an address the optimizer keeps its hands off unless
 * `images.dangerouslyAllowLocalIP` says otherwise: anything but a global unicast address, as
 * Next.js's `isPrivateIp` decides it with `ipaddr.js` — loopback, link-local and private ranges,
 * multicast, the documentation and benchmarking prefixes, and the rest of the special-purpose
 * registries, the tables below being that library's — plus `localhost`, which is loopback by
 * definition (RFC 6761), and the deprecated IPv4-compatible `::/96` prefix (RFC 4291).
 *
 * Only a literal address is judged; a hostname is not resolved. Next.js looks its sources up
 * before fetching them, and a Worker cannot — nor needs to: the platform refuses a request to a
 * bare address, and has no route into private space. What this keeps is the optimizer's own
 * refusal, in its own words, for what it would have refused.
 */

const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
const HEXTET = /^[\da-f]{1,4}$/iu;
const OCTET_BITS = 8n;
const OCTET_MAX = 255;
const HEXTET_BITS = 16n;
const HEXTET_MASK = 0xff_ffn;
const HEXTETS = 8;
const IPV4_BITS = 32;
const IPV6_BITS = 128;
const HEX = 16;

interface Range {
  readonly address: bigint;
  readonly bits: number;
}

function ipv4(text: string): bigint | undefined {
  const match = DOTTED_QUAD.exec(text);
  if (match === null) {
    return undefined;
  }
  let value = 0n;
  for (const octet of match.slice(1)) {
    const n = Number(octet);
    if (n > OCTET_MAX) {
      return undefined;
    }
    value = (value << OCTET_BITS) | BigInt(n);
  }
  return value;
}

function hextetsOf(text: string): string[] {
  return text === '' ? [] : text.split(':');
}

/** The address as `new URL` writes one: lower-case, compressed, without brackets. */
function ipv6(text: string): bigint | undefined {
  const halves = text.split('::');
  const [first = '', second] = halves;
  if (halves.length > 2) {
    return undefined;
  }
  const head = hextetsOf(first);
  const tail = second === undefined ? [] : hextetsOf(second);
  // A dotted quad may end the address (`::ffff:127.0.0.1`); it stands for the last two hextets.
  const ending = tail.length > 0 ? tail : head;
  const trailing: string[] = [];
  if (ending.at(-1)?.includes('.') === true) {
    const embedded = ipv4(ending.pop() ?? '');
    if (embedded === undefined) {
      return undefined;
    }
    trailing.push((embedded >> HEXTET_BITS).toString(HEX), (embedded & HEXTET_MASK).toString(HEX));
  }
  const explicit = head.length + tail.length + trailing.length;
  const elided = second === undefined ? 0 : HEXTETS - explicit;
  if (elided < 0 || head.length + elided + tail.length + trailing.length !== HEXTETS) {
    return undefined;
  }
  const hextets = [...head, ...Array.from({ length: elided }, () => '0'), ...tail, ...trailing];
  let value = 0n;
  for (const hextet of hextets) {
    if (!HEXTET.test(hextet)) {
      return undefined;
    }
    value = (value << HEXTET_BITS) | BigInt(Number.parseInt(hextet, HEX));
  }
  return value;
}

function range(address: string, bits: number): Range {
  const parsed = address.includes(':') ? ipv6(address) : ipv4(address);
  if (parsed === undefined) {
    throw new Error(`not an address: ${address}`);
  }
  return { address: parsed, bits };
}

function within(value: bigint, { address, bits }: Range, width: number): boolean {
  const shift = BigInt(width - bits);
  return value >> shift === address >> shift;
}

/** Everything `ipaddr.js` ranges as other than `unicast`, for IPv4. */
const IPV4_SPECIAL: readonly Range[] = [
  range('0.0.0.0', 8),
  range('255.255.255.255', 32),
  range('224.0.0.0', 4),
  range('169.254.0.0', 16),
  range('127.0.0.0', 8),
  range('100.64.0.0', 10),
  range('10.0.0.0', 8),
  range('172.16.0.0', 12),
  range('192.168.0.0', 16),
  range('192.0.0.0', 24),
  range('192.0.2.0', 24),
  range('192.88.99.0', 24),
  range('198.18.0.0', 15),
  range('198.51.100.0', 24),
  range('203.0.113.0', 24),
  range('240.0.0.0', 4),
  range('192.175.48.0', 24),
  range('192.31.196.0', 24),
  range('192.52.193.0', 24),
];

/** Non-unicast IPv6 ranges, plus deprecated IPv4 compatibility; mapped IPv4 is judged as IPv4. */
const IPV6_SPECIAL: readonly Range[] = [
  // Includes unspecified, loopback and the deprecated IPv4-compatible form (RFC 4291 §2.5.5.1).
  range('::', 96),
  range('fe80::', 10),
  range('ff00::', 8),
  range('fc00::', 7),
  range('100::', 64),
  range('::ffff:0:0:0', 96),
  range('64:ff9b::', 96),
  range('2002::', 16),
  range('2001::', 23),
  range('2001::', 32),
  range('2001:2::', 48),
  range('2001:3::', 32),
  range('2001:4:112::', 48),
  range('2620:4f:8000::', 48),
  range('2001:10::', 28),
  range('2001:20::', 28),
  range('2001:30::', 28),
  range('2001:db8::', 32),
];
const IPV4_MAPPED = range('::ffff:0:0', 96);
const IPV4_MASK = (1n << BigInt(IPV4_BITS)) - 1n;

function ipv4IsLocal(value: bigint): boolean {
  return IPV4_SPECIAL.some((special) => within(value, special, IPV4_BITS));
}

function ipv6IsLocal(value: bigint): boolean {
  if (within(value, IPV4_MAPPED, IPV6_BITS)) {
    return ipv4IsLocal(value & IPV4_MASK);
  }
  return IPV6_SPECIAL.some((special) => within(value, special, IPV6_BITS));
}

/**
 * Whether `hostname`, as a URL carries it (an IPv6 address in brackets), names an address the
 * optimizer refuses without `dangerouslyAllowLocalIP` — or `localhost`, written with or without
 * the root's own trailing dot, which a URL keeps on a name and which names the same host.
 */
export function isLocalAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const value = ipv6(host.slice(1, -1));
    return value !== undefined && ipv6IsLocal(value);
  }
  const value = ipv4(host);
  return value !== undefined && ipv4IsLocal(value);
}
