/* eslint-disable no-bitwise, @typescript-eslint/no-magic-numbers -- this module writes two binary formats whose headers are specified bit by bit; the literals are the format. */
import { concatBytes, crc32, equalBytes } from '@stayingupwind/core/util';

/**
 * How the spliced document is put on the wire.
 *
 * The shell is compressed ahead of time, at a quality no request could afford, and stored as the
 * *unfinished head* of a stream: every block it contains is complete and flushed, but the stream's
 * last-block marker has not been written. The edge sends that head exactly as stored, then wraps
 * each suffix chunk in a block the format lets an unrelated writer append — an uncompressed
 * brotli meta-block, a stored deflate block — and finally writes the marker. The suffix is not
 * compressed in this stream: a fresh encoder cannot continue a stream whose state it never saw,
 * and a stream admits only one encoder. A brotli document the application resumes goes out inside
 * a second brotli stream instead (`content-encoding: br, br`; the edge's `live-compression.ts`),
 * which carries this one's head stored, as this one carries the suffix, and compresses what comes
 * after it with an encoder whose state is proved to match (`brotliStoresOnly`). (When no such head
 * can be used, the edge compresses the whole document on the way out with an encoder of its own,
 * flushed every few kilobytes; that path does not come through here.)
 *
 * Nothing here compresses. Framing a chunk costs a few header bytes and, for gzip, a CRC update.
 */
export interface WireEncoding {
  /** The `content-encoding` the response declares. */
  readonly encoding: 'identity' | 'br' | 'gzip';
  /** Bytes that stand in for the shell on the wire, flushed before any origin byte exists. */
  readonly shell: Uint8Array;
  /** Wire bytes for one suffix chunk, in order. Never called with an empty chunk. */
  frame(chunk: Uint8Array): readonly Uint8Array[];
  /**
   * Bytes that end the stream after the last suffix chunk; empty when the format needs none.
   *
   * Bytes of their own at every call. Whoever reads the stream is handed them, and may write into
   * them — or take their buffer away, as a byte stream does with every chunk it is given — so one
   * shared by every stream would be every stream's end gone at once.
   */
  finish(): Uint8Array;
}

const BYTE_MASK = 0xff;
const BITS_PER_BYTE = 8;
const NO_BYTES = new Uint8Array();

function littleEndian32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

/** Split `chunk` into views of at most `limit` bytes, framing each one. */
function framed(
  chunk: Uint8Array,
  limit: number,
  header: (length: number) => Uint8Array,
): readonly Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < chunk.byteLength; offset += limit) {
    const part = chunk.subarray(offset, offset + limit);
    out.push(header(part.byteLength), part);
  }
  return out;
}

export function identityWire(shell: Uint8Array): WireEncoding {
  return {
    encoding: 'identity',
    shell,
    frame: (chunk) => [chunk],
    finish: () => new Uint8Array(),
  };
}

/*
 * Brotli (RFC 7932 §9.2). An uncompressed meta-block header, least-significant bit first:
 * ISLAST=0 (1 bit), MNIBBLES=0 meaning four length nibbles (2 bits), MLEN−1 (16 bits),
 * ISUNCOMPRESSED=1 (1 bit); the 20 bits are padded to three bytes and the raw bytes follow. Four
 * nibbles hold at most 65536 bytes, so longer chunks are split. The stream ends with a meta-block
 * that is both ISLAST and ISLASTEMPTY: the two bits `11`, padded to one byte.
 */
const BROTLI_MAX_UNCOMPRESSED_BLOCK = 65_536;
const BROTLI_MLEN_SHIFT = 3;
const BROTLI_UNCOMPRESSED_BIT = 1 << 19;
const BROTLI_LAST_EMPTY_META_BLOCK = new Uint8Array([0x03]);
/**
 * A stream head that compresses nothing: WBITS=16 as the single bit `0`, then an empty metadata
 * meta-block (ISLAST=0, MNIBBLES=3, reserved 0, MSKIPBYTES=0) padded to the byte boundary.
 * Uncompressed meta-blocks may follow it directly, which makes a valid brotli stream without an
 * encoder. It is also what a brotli encoder itself writes when it is flushed before any input.
 */
const BROTLI_STORED_HEAD = new Uint8Array([0x0c]);
/**
 * The window `BROTLI_STORED_HEAD` declares: WBITS=16. An encoder set to continue a stream begun
 * that way has to be given this window and no other — a decoder judges every distance, and where
 * the static dictionary begins, against the window the stream's first bits declared.
 */
export const BROTLI_STORED_WINDOW_BITS = 16;
/** MNIBBLES as its two bits say it: `3` is a metadata block, `0`–`2` are four to six nibbles. */
const BROTLI_METADATA_NIBBLES = 3;
const BROTLI_MIN_MLEN_NIBBLES = 4;
const BITS_PER_NIBBLE = 4;

function brotliUncompressedHeader(length: number): Uint8Array {
  const bits = ((length - 1) << BROTLI_MLEN_SHIFT) | BROTLI_UNCOMPRESSED_BIT;
  return new Uint8Array([
    bits & BYTE_MASK,
    (bits >>> BITS_PER_BYTE) & BYTE_MASK,
    (bits >>> (2 * BITS_PER_BYTE)) & BYTE_MASK,
  ]);
}

function brotliUncompressed(chunk: Uint8Array): readonly Uint8Array[] {
  return framed(chunk, BROTLI_MAX_UNCOMPRESSED_BLOCK, brotliUncompressedHeader);
}

/** `head` is the unfinished brotli stream the shell was encoded into. */
export function brotliWire(head: Uint8Array): WireEncoding {
  return {
    encoding: 'br',
    shell: head,
    frame: brotliUncompressed,
    finish: () => Uint8Array.from(BROTLI_LAST_EMPTY_META_BLOCK),
  };
}

/**
 * The shell as an unfinished brotli stream that stores rather than compresses it. The tests seed it
 * as a rendering; the edge's second brotli layer begins with it, around a rendering's head.
 */
export function brotliStoredHead(shell: Uint8Array): Uint8Array {
  return concatBytes([BROTLI_STORED_HEAD, ...brotliUncompressed(shell)]);
}

/**
 * `wire` with each chunk's frames joined into one array, for a reader that acts once per array it
 * is handed: the edge's second brotli layer flushes after each, and a flush per three-byte frame
 * header would cost a block apiece. The bytes are the same; only where they are cut differs.
 */
export function joinedWire(wire: WireEncoding): WireEncoding {
  return {
    encoding: wire.encoding,
    shell: wire.shell,
    frame: (chunk) => [concatBytes(wire.frame(chunk))],
    finish: () => wire.finish(),
  };
}

/** A brotli stream's bits, least-significant first, as RFC 7932 §2 packs them. */
class BrotliBits {
  readonly #bytes: Uint8Array;
  #bit = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get done(): boolean {
    return this.#bit === this.#bytes.byteLength * BITS_PER_BYTE;
  }

  /** The next `count` bits (at most 24) as a number, or `undefined` past the end. */
  take(count: number): number | undefined {
    if (this.#bit + count > this.#bytes.byteLength * BITS_PER_BYTE) {
      return undefined;
    }
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const at = this.#bit + index;
      value |= (((this.#bytes[at >>> 3] ?? 0) >>> (at & 7)) & 1) << index;
    }
    this.#bit += count;
    return value;
  }

  /** Move to the next byte boundary; false unless the bits passed over are all zero. */
  alignZero(): boolean {
    return this.take((BITS_PER_BYTE - (this.#bit % BITS_PER_BYTE)) % BITS_PER_BYTE) === 0;
  }

  /** The next `length` bytes, read from a byte boundary; `undefined` past the end. */
  takeBytes(length: number): Uint8Array | undefined {
    const start = this.#bit / BITS_PER_BYTE;
    if (start + length > this.#bytes.byteLength) {
      return undefined;
    }
    this.#bit += length * BITS_PER_BYTE;
    return this.#bytes.subarray(start, start + length);
  }
}

/**
 * One meta-block of a stream that only stores: the bytes an uncompressed block holds, none for an
 * empty metadata block — which is how an encoder pads a flush to the byte — or `undefined` for
 * anything else: a compressed block, a last one, metadata that carries bytes, padding that is not
 * zero, a stream that ends inside the block. An uncompressed block always holds at least one byte.
 */
function storedMetaBlock(bits: BrotliBits): Uint8Array | undefined {
  // ISLAST: a stream that is still being written has none.
  if (bits.take(1) !== 0) {
    return undefined;
  }
  const nibbles = bits.take(2);
  if (nibbles === undefined) {
    return undefined;
  }
  if (nibbles === BROTLI_METADATA_NIBBLES) {
    // The reserved bit, then MSKIPBYTES: none, so nothing to skip but the padding.
    return bits.take(1) === 0 && bits.take(2) === 0 && bits.alignZero() ? NO_BYTES : undefined;
  }
  const lengthMinusOne = bits.take((nibbles + BROTLI_MIN_MLEN_NIBBLES) * BITS_PER_NIBBLE);
  // ISUNCOMPRESSED, then the padding to the byte the stored bytes begin on.
  if (lengthMinusOne === undefined || bits.take(1) !== 1 || !bits.alignZero()) {
    return undefined;
  }
  return bits.takeBytes(lengthMinusOne + 1);
}

/**
 * Whether `stream` — what a brotli encoder wrote, flushed, given `content` — stores `content` the
 * way `brotliStoredHead(content)` does: WBITS=16, then nothing but uncompressed meta-blocks, and
 * the empty metadata blocks a flush pads with, holding `content` byte for byte and ending where it
 * ends. Where the blocks are cut does not matter; the encoder cuts them where it likes, and a block
 * of four nibbles holds no more than 64 KiB.
 *
 * This is what lets an encoder continue a stream somebody else began. Between meta-blocks a decoder
 * keeps only the window the stream declared, the bytes it has put out — which fix its position,
 * and with it where the static dictionary begins, and the two bytes the next literal is modelled
 * on — and the last four distances a compressed block used. Everything else, each compressed block
 * declares afresh. Two streams under the same window, made only of stored blocks, that put out the
 * same bytes therefore leave any decoder in one state; and an encoder is in the state of a decoder
 * that read what it wrote, or its own stream could not be read. So once the encoder's output for
 * `content` is shown to store it, what the encoder writes next may follow any other stored
 * rendering of `content` — the edge's, sent before the encoder had started.
 *
 * Nothing else is taken: a compressed block (the encoder found `content` compressible, and its
 * distances are now its own), another window, a last-block marker, a byte that differs.
 */
export function brotliStoresOnly(stream: Uint8Array, content: Uint8Array): boolean {
  const bits = new BrotliBits(stream);
  // WBITS=16, the single bit `0`.
  if (bits.take(1) !== 0) {
    return false;
  }
  let offset = 0;
  while (!bits.done) {
    const block = storedMetaBlock(bits);
    if (
      block === undefined ||
      !equalBytes(block, content.subarray(offset, offset + block.byteLength))
    ) {
      return false;
    }
    offset += block.byteLength;
  }
  return offset === content.byteLength;
}

/*
 * Gzip (RFC 1952) over deflate (RFC 1951). A stored block is a byte holding BFINAL and BTYPE=00,
 * then LEN and its one's complement as little-endian 16-bit values, then the raw bytes; the block
 * is byte-aligned because the head ends on a sync flush. The stream is closed with an empty stored
 * block that has BFINAL set, and the member with the CRC-32 and the length modulo 2^32 of the
 * whole uncompressed body. One member on purpose: a browser stops at the end of the first.
 */
const GZIP_HEADER = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
const DEFLATE_MAX_STORED_BLOCK = 65_535;
const DEFLATE_LAST_STORED_BLOCK = new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]);

function deflateStoredHeader(length: number): Uint8Array {
  const complement = ~length & DEFLATE_MAX_STORED_BLOCK;
  return new Uint8Array([
    0x00,
    length & BYTE_MASK,
    (length >>> BITS_PER_BYTE) & BYTE_MASK,
    complement & BYTE_MASK,
    (complement >>> BITS_PER_BYTE) & BYTE_MASK,
  ]);
}

function deflateStored(chunk: Uint8Array): readonly Uint8Array[] {
  return framed(chunk, DEFLATE_MAX_STORED_BLOCK, deflateStoredHeader);
}

export interface GzipHeadDigest {
  /** CRC-32 of the shell bytes the head decodes to. */
  readonly crc32: number;
  /** Length of those bytes. */
  readonly byteLength: number;
}

/** `head` is the gzip header plus the unfinished deflate stream the shell was encoded into. */
export function gzipWire(head: Uint8Array, shell: GzipHeadDigest): WireEncoding {
  let crc = shell.crc32;
  let length = shell.byteLength;
  return {
    encoding: 'gzip',
    shell: head,
    frame(chunk) {
      crc = crc32(chunk, crc);
      length += chunk.byteLength;
      return deflateStored(chunk);
    },
    finish: () =>
      concatBytes([DEFLATE_LAST_STORED_BLOCK, littleEndian32(crc), littleEndian32(length)]),
  };
}

/** The shell as a gzip header plus stored deflate blocks, an unfinished stream; for tests. */
export function gzipStoredHead(shell: Uint8Array): Uint8Array {
  return concatBytes([GZIP_HEADER, ...deflateStored(shell)]);
}

/** The gzip member header, for an encoder that supplies the deflate stream itself. */
export function gzipHeader(): Uint8Array {
  return Uint8Array.from(GZIP_HEADER);
}
