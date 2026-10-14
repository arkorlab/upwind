import { concatBytes, crc32, encodeUtf8, fromHex } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import {
  brotliStoredHead,
  brotliStoresOnly,
  brotliWire,
  gzipHeader,
  gzipStoredHead,
  gzipWire,
  identityWire,
  joinedWire,
  type WireEncoding,
} from '../src/splice/wire.ts';

/**
 * The shell a real encoder produced, captured once. `brotli` is `brotliCompressSync` at quality 11
 * with `BROTLI_OPERATION_FLUSH` as the finishing operation; `deflate` is `deflateRawSync` with
 * `Z_SYNC_FLUSH`. Both are unfinished streams: the wire has to be able to continue them.
 */
const FIXTURE_SHELL =
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Wire fixture</title>' +
  '</head><body><div id="__next"><header>Static header</header><main><!--$?-->' +
  '<template id="B:0"></template><p>Loading…</p><!--/$--></main></div>';
const FIXTURE_BROTLI_HEAD =
  '600e0084b3c0dddd8aa6aa6c61e0ec61b582071c72a8c723b5259651bab956acb290bec3433ddde4db4144e1a1' +
  'e597888ecd0e3c40ac5a5b5b12a70ff45b7cdb8bbce08bbc6e0c4b129479831cf0881cd61792f1725fafe7f8ffdb' +
  '6be83a2a5014b7bc5ee9ab4edf364018906e6506d304b727e71e94e0b915ba49200c99aaac5aeceeb982202f062' +
  'f226d7f47b012246023b8f16f00';
const FIXTURE_DEFLATE_HEAD =
  '348d4d0ac2301085af9206b7212e45a623f8b313142a882b89cdd806d258ca54eaced378304f626c74f3e03df8be' +
  '07d97ab73a9cf61b5173e311be29bc09552e29c8d8c9588486d888b2365d419ccb9eaf6a2635023bf68447d791b8' +
  'ba81fb8e40a70d74022f37fb40b0ee2e9ccde5f91c68e09f953a2cd8b02b456a09892b34c605844ca9c942a9f842' +
  '4deb0dd3a858cea791d7ff0da1c5edcd5817aaf7f305ba1d393df9723a79747cc70f000000ffff';
const FIXTURE_CRC32 = 3_762_363_527;
/**
 * What `brotliCompressSync` writes for `FIXTURE_BROTLI_HEAD` at quality 5 with a 64 KiB window and
 * `BROTLI_OPERATION_FLUSH`, captured once: a quality-11 stream leaves it nothing to find, so it
 * stores it — WBITS=16, then one uncompressed meta-block (MLEN−1=149) — and this is the header, the
 * head following as it is. The edge's second layer asks exactly this of its encoder.
 */
const FIXTURE_STORED_REPLAY_HEADER = '500910';
/** The same at the encoder's default window: stored, but under WBITS=22 (the first bit is `1`). */
const FIXTURE_WIDE_REPLAY_HEADER = '8b4a80';
/** What the same encoder writes for `REPEATED`, which it compresses rather than stores. */
const FIXTURE_COMPRESSED_REPLAY = 'b0120080a8700c88978f183014b8a09ccede1b';
const REPEATED = 'abcdefghij'.repeat(30);

const SUFFIX = encodeUtf8('<div hidden id="S:0"><p>Hello dynamic</p></div></body></html>');
const BROTLI_MAX_BLOCK = 65_536;
const DEFLATE_MAX_BLOCK = 65_535;

function hex(value: string): Uint8Array {
  const bytes = fromHex(value);
  if (bytes === undefined) {
    throw new Error('bad hex fixture');
  }
  return bytes;
}

/** Everything a client would receive for `chunks` under `wire`. */
function transmit(wire: WireEncoding, chunks: readonly Uint8Array[]): Uint8Array {
  return concatBytes([
    wire.shell,
    ...chunks.flatMap((chunk) => [...wire.frame(chunk)]),
    wire.finish(),
  ]);
}

/** Node's web streams decode brotli; its lib typings predate the format, hence the cast. */
async function decode(format: 'brotli' | 'gzip', bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream(format as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('identityWire', () => {
  it('passes the shell and every chunk through untouched and ends with nothing', () => {
    const shell = encodeUtf8('<html>');
    const wire = identityWire(shell);

    expect(wire.encoding).toBe('identity');
    expect(wire.shell).toBe(shell);
    expect(wire.frame(SUFFIX)).toStrictEqual([SUFFIX]);
    expect(wire.finish().byteLength).toBe(0);
  });
});

describe('brotliWire', () => {
  it('continues a head a real encoder flushed', async () => {
    const wire = brotliWire(hex(FIXTURE_BROTLI_HEAD));
    const decoded = await decode(
      'brotli',
      transmit(wire, [SUFFIX.subarray(0, 7), SUFFIX.subarray(7)]),
    );

    expect(wire.encoding).toBe('br');
    expect(new TextDecoder().decode(decoded)).toBe(
      FIXTURE_SHELL + new TextDecoder().decode(SUFFIX),
    );
  });

  it('frames a chunk as one uncompressed meta-block with a three-byte header', () => {
    const chunk = encodeUtf8('abc');
    const [header, body] = brotliWire(new Uint8Array()).frame(chunk);

    // ISLAST=0, MNIBBLES=0 (four nibbles), MLEN-1=2 from bit 3, ISUNCOMPRESSED=1 at bit 19.
    expect([...(header ?? [])]).toStrictEqual([0x10, 0x00, 0x08]);
    expect(body).toStrictEqual(chunk);
  });

  it('splits a chunk longer than a meta-block can carry', async () => {
    const big = new Uint8Array(BROTLI_MAX_BLOCK + 1).map((_byte, index) => index % 251);
    const wire = brotliWire(brotliStoredHead(new Uint8Array()));
    const parts = wire.frame(big);

    expect(parts).toHaveLength(4);
    expect(parts[1]?.byteLength).toBe(BROTLI_MAX_BLOCK);
    expect(parts[3]?.byteLength).toBe(1);
    await expect(decode('brotli', transmit(wire, [big]))).resolves.toStrictEqual(big);
  });

  it('closes a stream that never got a suffix', async () => {
    const shell = encodeUtf8(FIXTURE_SHELL);
    const wire = brotliWire(brotliStoredHead(shell));

    await expect(decode('brotli', transmit(wire, []))).resolves.toStrictEqual(shell);
  });
});

describe('joinedWire', () => {
  it("hands each chunk's frames over as one array, byte for byte the wire's", async () => {
    const shell = encodeUtf8(FIXTURE_SHELL);
    const big = new Uint8Array(BROTLI_MAX_BLOCK + 1).map((_byte, index) => index % 251);
    const wire = brotliWire(brotliStoredHead(shell));
    const joined = joinedWire(wire);
    const parts = joined.frame(big);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toStrictEqual(concatBytes(wire.frame(big)));
    expect(joined.shell).toBe(wire.shell);
    expect(joined.finish()).toStrictEqual(wire.finish());
    await expect(decode('brotli', transmit(joined, [big, SUFFIX]))).resolves.toStrictEqual(
      concatBytes([shell, big, SUFFIX]),
    );
  });

  it('frames each chunk once, so a wire that counts what it framed closes right', async () => {
    const shell = encodeUtf8(FIXTURE_SHELL);
    const digest = { crc32: crc32(shell), byteLength: shell.byteLength };
    const joined = joinedWire(gzipWire(gzipStoredHead(shell), digest));

    expect(joined.encoding).toBe('gzip');
    await expect(decode('gzip', transmit(joined, [SUFFIX, SUFFIX]))).resolves.toStrictEqual(
      concatBytes([shell, SUFFIX, SUFFIX]),
    );
  });
});

/**
 * The check the edge's second brotli layer rests on: an encoder that stored the head exactly as the
 * edge already sent it is in the state the client's decoder is in, and may continue the stream.
 */
describe('brotliStoresOnly', () => {
  const head = hex(FIXTURE_BROTLI_HEAD);

  it('takes what an encoder wrote for a head it could only store', () => {
    const replay = hex(FIXTURE_STORED_REPLAY_HEADER + FIXTURE_BROTLI_HEAD);

    expect(brotliStoresOnly(replay, head)).toBe(true);
  });

  it('takes the stored head the edge sends, its empty metadata block and all', () => {
    const shell = encodeUtf8(FIXTURE_SHELL);
    const nothing = new Uint8Array();
    const empty = brotliStoredHead(nothing);

    expect(brotliStoresOnly(brotliStoredHead(shell), shell)).toBe(true);
    expect(brotliStoresOnly(empty, nothing)).toBe(true);
  });

  it('reads a block of five length nibbles, which an encoder writes for more than 64 KiB', () => {
    const content = new Uint8Array(BROTLI_MAX_BLOCK + 1).map((_byte, index) => index % 251);
    // WBITS=16, ISLAST=0, MNIBBLES=1 (five nibbles), MLEN−1=65536, ISUNCOMPRESSED=1 at bit 24.
    const stream = concatBytes([new Uint8Array([0x04, 0x00, 0x10, 0x01]), content]);

    expect(brotliStoresOnly(stream, content)).toBe(true);
  });

  it('refuses a compressed block, and a window the stored head does not declare', () => {
    const compressed = hex(FIXTURE_COMPRESSED_REPLAY);
    const wide = hex(FIXTURE_WIDE_REPLAY_HEADER + FIXTURE_BROTLI_HEAD);

    expect(brotliStoresOnly(compressed, encodeUtf8(REPEATED))).toBe(false);
    expect(brotliStoresOnly(wide, head)).toBe(false);
  });

  it('refuses a last-block marker, metadata with bytes, and padding that is not zero', () => {
    const closed = hex(`${FIXTURE_STORED_REPLAY_HEADER}${FIXTURE_BROTLI_HEAD}03`);

    expect(brotliStoresOnly(closed, head)).toBe(false);
    // An empty metadata block but MSKIPBYTES=1, and one byte of metadata.
    expect(brotliStoresOnly(new Uint8Array([0x2c, 0x00, 0xaa]), new Uint8Array())).toBe(false);
    // The empty metadata block of `BROTLI_STORED_HEAD` with its last padding bit set.
    expect(brotliStoresOnly(new Uint8Array([0x8c]), new Uint8Array())).toBe(false);
  });

  it('refuses a stream that stores other bytes, fewer or more than the content', () => {
    const stored = hex(FIXTURE_STORED_REPLAY_HEADER + FIXTURE_BROTLI_HEAD);
    const altered = Uint8Array.from(head);
    altered[10] = ((altered[10] ?? 0) + 1) % 256;
    const longer = concatBytes([head, new Uint8Array(1)]);

    expect(brotliStoresOnly(stored, altered)).toBe(false);
    expect(brotliStoresOnly(stored, head.subarray(1))).toBe(false);
    expect(brotliStoresOnly(stored, longer)).toBe(false);
  });

  it('refuses a stream cut short, and one with nothing in it', () => {
    const stored = hex(FIXTURE_STORED_REPLAY_HEADER + FIXTURE_BROTLI_HEAD);

    expect(brotliStoresOnly(stored.subarray(0, stored.byteLength - 1), head)).toBe(false);
    expect(brotliStoresOnly(stored.subarray(0, 2), head)).toBe(false);
    expect(brotliStoresOnly(new Uint8Array(), new Uint8Array())).toBe(false);
  });
});

describe('gzipWire', () => {
  const shell = encodeUtf8(FIXTURE_SHELL);
  const digest = { crc32: FIXTURE_CRC32, byteLength: shell.byteLength };

  it('continues a head a real encoder sync-flushed, with the CRC carried over the suffix', async () => {
    const head = concatBytes([gzipHeader(), hex(FIXTURE_DEFLATE_HEAD)]);
    const wire = gzipWire(head, digest);
    const decoded = await decode(
      'gzip',
      transmit(wire, [SUFFIX.subarray(0, 9), SUFFIX.subarray(9)]),
    );

    expect(wire.encoding).toBe('gzip');
    expect(crc32(shell)).toBe(FIXTURE_CRC32);
    expect(decoded).toStrictEqual(concatBytes([shell, SUFFIX]));
  });

  it('frames a chunk as one stored block', () => {
    const chunk = encodeUtf8('abc');
    const [header, body] = gzipWire(new Uint8Array(), digest).frame(chunk);

    // BFINAL=0 BTYPE=00, LEN=3, NLEN=~3, little-endian.
    expect([...(header ?? [])]).toStrictEqual([0x00, 0x03, 0x00, 0xfc, 0xff]);
    expect(body).toStrictEqual(chunk);
  });

  it('ends with a final empty block, the CRC-32 and the length of the whole body', () => {
    const wire = gzipWire(gzipStoredHead(shell), {
      crc32: crc32(shell),
      byteLength: shell.byteLength,
    });
    wire.frame(SUFFIX);
    const trailer = wire.finish();
    const view = new DataView(trailer.buffer, trailer.byteOffset);

    expect([...trailer.subarray(0, 5)]).toStrictEqual([0x01, 0x00, 0x00, 0xff, 0xff]);
    expect(view.getUint32(5, true)).toBe(crc32(concatBytes([shell, SUFFIX])));
    expect(view.getUint32(9, true)).toBe(shell.byteLength + SUFFIX.byteLength);
  });

  it('splits a chunk longer than a stored block can carry', async () => {
    const big = new Uint8Array(DEFLATE_MAX_BLOCK + 1).map((_byte, index) => index % 253);
    const stored = { crc32: crc32(shell), byteLength: shell.byteLength };
    const parts = gzipWire(gzipStoredHead(shell), stored).frame(big);
    const sent = transmit(gzipWire(gzipStoredHead(shell), stored), [big]);

    expect(parts).toHaveLength(4);
    expect(parts[1]?.byteLength).toBe(DEFLATE_MAX_BLOCK);
    await expect(decode('gzip', sent)).resolves.toStrictEqual(concatBytes([shell, big]));
  });
});

/** `size` bytes that repeat on no power of two, so a block cut in the wrong place shows. */
function chunkOf(size: number): Uint8Array {
  return new Uint8Array(size).map((_byte, index) => index % 251);
}

/**
 * Where a chunk is cut into blocks is where a length is written by hand: four length nibbles hold
 * at most 65,536 bytes of brotli, and a stored deflate block 65,535. A chunk on either side of each
 * limit, and on it, goes out between the shell and a suffix, and a real decoder reads back every
 * byte of the three — the trailer's CRC-32 and length of the whole body included, for gzip.
 */
describe('framing at the block limits', () => {
  const shell = encodeUtf8(FIXTURE_SHELL);
  const sizes = [DEFLATE_MAX_BLOCK - 1, DEFLATE_MAX_BLOCK, BROTLI_MAX_BLOCK, BROTLI_MAX_BLOCK + 1];

  it.each(sizes)('decodes %d bytes framed in brotli', async (size) => {
    const chunk = chunkOf(size);
    const wire = brotliWire(brotliStoredHead(shell));

    expect(wire.frame(chunk)).toHaveLength(2 * Math.ceil(size / BROTLI_MAX_BLOCK));
    await expect(decode('brotli', transmit(wire, [chunk, SUFFIX]))).resolves.toStrictEqual(
      concatBytes([shell, chunk, SUFFIX]),
    );
  });

  it.each(sizes)('decodes %d bytes framed in gzip', async (size) => {
    const chunk = chunkOf(size);
    const digest = { crc32: crc32(shell), byteLength: shell.byteLength };
    const counted = gzipWire(gzipStoredHead(shell), digest);

    expect(counted.frame(chunk)).toHaveLength(2 * Math.ceil(size / DEFLATE_MAX_BLOCK));

    const wire = gzipWire(gzipStoredHead(shell), digest);

    await expect(decode('gzip', transmit(wire, [chunk, SUFFIX]))).resolves.toStrictEqual(
      concatBytes([shell, chunk, SUFFIX]),
    );
  });
});

/**
 * What a stream ends with is handed to whoever reads it, which may write into it or, as a byte
 * stream does with each chunk it is given, take its buffer away. Each call hands out bytes of its
 * own, so no stream's end is another's.
 */
describe('finish', () => {
  const shell = encodeUtf8(FIXTURE_SHELL);
  const digest = { crc32: crc32(shell), byteLength: shell.byteLength };
  const wires = {
    identity: () => identityWire(shell),
    brotli: () => brotliWire(brotliStoredHead(shell)),
    gzip: () => gzipWire(gzipStoredHead(shell), digest),
  };

  it.each(Object.entries(wires))(
    'hands out a trailer of its own each time: %s',
    (_name, wireOf) => {
      const wire = wireOf();
      const expected = [...wire.finish()];
      const taken = wire.finish();

      expect(taken).not.toBe(wire.finish());

      structuredClone(taken, { transfer: [taken.buffer as ArrayBuffer] });

      expect(taken.byteLength).toBe(0);
      expect([...wireOf().finish()]).toStrictEqual(expected);
    },
  );
});
