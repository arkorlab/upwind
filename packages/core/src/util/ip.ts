/* eslint-disable no-bitwise -- a prefix is a number of bits, and matching one is masking them. */
/**
 * IP addresses and CIDR ranges, for deciding whether a caller is inside a published range.
 *
 * Parsing is strict on purpose: an allowlist is only as good as its refusal to read a malformed
 * address as something. A leading zero (`010`), a zone id (`fe80::1%eth0`) and a second `::` are
 * all rejected rather than guessed at. Host bits below the prefix are ignored, so `10.0.0.1/8`
 * names the same range as `10.0.0.0/8`.
 *
 * `images/local-address.ts` reads addresses too, and stays separate on purpose: what it answers
 * is what `ipaddr.js` would answer for Next.js's `isPrivateIp`, down to that library's tables and
 * its leniency about a hostname a URL has already normalised. Its verdict must not start moving
 * with an allowlist's strictness, and it never has a range in text to read.
 */

import { concatBytes } from './bytes.ts';

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const BITS_PER_BYTE = 8;
const BYTE_MAX = 255;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

/** A decimal with no leading zero, so `010` is not read as `10` — or as octal `8`. */
const DECIMAL_RE = /^(?:0|[1-9]\d{0,2})$/u;
const IPV6_GROUP_RE = /^[0-9a-f]{1,4}$/iu;

/** Dotted quad, or `undefined` for anything else. */
function parseIpv4(text: string): Uint8Array | undefined {
  const parts = text.split('.');
  if (parts.length !== IPV4_BYTES) {
    return undefined;
  }
  const bytes = new Uint8Array(IPV4_BYTES);
  for (const [index, part] of parts.entries()) {
    if (!DECIMAL_RE.test(part)) {
      return undefined;
    }
    const value = Number.parseInt(part, DECIMAL_RADIX);
    if (value > BYTE_MAX) {
      return undefined;
    }
    bytes[index] = value;
  }
  return bytes;
}

/**
 * The bytes one side of a `::` spells. `allowIpv4` is for the side that ends the address, where a
 * dotted quad may stand for the last two groups (`::ffff:203.0.113.1`).
 */
function halfBytes(half: string, allowIpv4: boolean): Uint8Array | undefined {
  if (half === '') {
    return new Uint8Array(0);
  }
  const tokens = half.split(':');
  const chunks: Uint8Array[] = [];
  for (const [index, token] of tokens.entries()) {
    if (allowIpv4 && index === tokens.length - 1 && token.includes('.')) {
      const quad = parseIpv4(token);
      if (quad === undefined) {
        return undefined;
      }
      chunks.push(quad);
      continue;
    }
    if (!IPV6_GROUP_RE.test(token)) {
      return undefined;
    }
    const group = Number.parseInt(token, HEX_RADIX);
    chunks.push(new Uint8Array([group >>> BITS_PER_BYTE, group & BYTE_MAX]));
  }
  return concatBytes(chunks);
}

/**
 * Sixteen bytes, or `undefined`. `::` may appear once and stands for at least one zero group,
 * which is why a compressed address must spell fewer than sixteen bytes and an uncompressed one
 * exactly sixteen.
 */
function parseIpv6(text: string): Uint8Array | undefined {
  const halves = text.split('::');
  const [first, second] = halves;
  if (first === undefined || halves.length > 2) {
    return undefined;
  }
  const compressed = second !== undefined;
  const head = halfBytes(first, !compressed);
  const tail = compressed ? halfBytes(second, true) : new Uint8Array(0);
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  const spelled = head.byteLength + tail.byteLength;
  if (compressed ? spelled >= IPV6_BYTES : spelled !== IPV6_BYTES) {
    return undefined;
  }
  const bytes = new Uint8Array(IPV6_BYTES);
  bytes.set(head, 0);
  bytes.set(tail, IPV6_BYTES - tail.byteLength);
  return bytes;
}

/** `::ffff:0:0/96`, the prefix under which an IPv6 address carries an IPv4 one: ten zero bytes… */
const IPV4_MAPPED_ZEROES = 10;
/** …then two of `0xff`, and then the four the address is. */
const IPV4_MAPPED_MARKER = IPV4_MAPPED_ZEROES + 2;

/** The four bytes an IPv4-mapped address carries, or the address as it was. */
function unmapIpv4(bytes: Uint8Array): Uint8Array {
  for (let index = 0; index < IPV4_MAPPED_ZEROES; index += 1) {
    if (bytes[index] !== 0) {
      return bytes;
    }
  }
  for (let index = IPV4_MAPPED_ZEROES; index < IPV4_MAPPED_MARKER; index += 1) {
    if (bytes[index] !== BYTE_MAX) {
      return bytes;
    }
  }
  return bytes.slice(IPV4_MAPPED_MARKER);
}

/**
 * An address as bytes — four for IPv4, sixteen for IPv6 — or `undefined` for one this does not
 * read. An IPv4-mapped address (`::ffff:203.0.113.1`) comes back as the four bytes it carries, so
 * a caller that arrives that way is matched against the IPv4 ranges rather than missing them all.
 */
export function parseIp(text: string): Uint8Array | undefined {
  if (text === '') {
    return undefined;
  }
  if (!text.includes(':')) {
    return parseIpv4(text);
  }
  const bytes = parseIpv6(text);
  return bytes === undefined ? undefined : unmapIpv4(bytes);
}

/** A range: the address its prefix is taken from, and how many bits of it count. */
export interface Cidr {
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
}

/** `192.30.252.0/22` or `2a0a:a440::/29`; `undefined` for anything this does not read. */
export function parseCidr(text: string): Cidr | undefined {
  const slash = text.indexOf('/');
  if (slash === -1) {
    return undefined;
  }
  const bytes = parseIp(text.slice(0, slash));
  const prefix = text.slice(slash + 1);
  if (bytes === undefined || !DECIMAL_RE.test(prefix)) {
    return undefined;
  }
  const prefixBits = Number.parseInt(prefix, DECIMAL_RADIX);
  return prefixBits > bytes.byteLength * BITS_PER_BYTE ? undefined : { bytes, prefixBits };
}

/**
 * Every range in the list, or `undefined` if any one of them does not read. All or nothing: a
 * list that is half understood is not an allowlist anybody meant to write.
 */
export function parseCidrs(texts: readonly string[]): Cidr[] | undefined {
  const cidrs: Cidr[] = [];
  for (const text of texts) {
    const cidr = parseCidr(text);
    if (cidr === undefined) {
      return undefined;
    }
    cidrs.push(cidr);
  }
  return cidrs;
}

/** Whether the address is inside the range. An IPv4 address is never inside an IPv6 range. */
function ipInCidr(ip: Uint8Array, cidr: Cidr): boolean {
  if (ip.byteLength !== cidr.bytes.byteLength) {
    return false;
  }
  const whole = Math.floor(cidr.prefixBits / BITS_PER_BYTE);
  for (let index = 0; index < whole; index += 1) {
    if (ip[index] !== cidr.bytes[index]) {
      return false;
    }
  }
  const remaining = cidr.prefixBits % BITS_PER_BYTE;
  if (remaining === 0) {
    return true;
  }
  const mask = (BYTE_MAX << (BITS_PER_BYTE - remaining)) & BYTE_MAX;
  return ((ip[whole] ?? 0) & mask) === ((cidr.bytes[whole] ?? 0) & mask);
}

/** Whether the address is inside any of the ranges. */
function ipInCidrs(ip: Uint8Array, cidrs: readonly Cidr[]): boolean {
  return cidrs.some((cidr) => ipInCidr(ip, cidr));
}

/**
 * Whether the address, written as it arrives in a header, is inside any of the ranges. An address
 * that does not read is inside none of them — the refusal an allowlist owes an unreadable caller.
 */
export function addressInCidrs(address: string, cidrs: readonly Cidr[]): boolean {
  const ip = parseIp(address);
  return ip !== undefined && ipInCidrs(ip, cidrs);
}
