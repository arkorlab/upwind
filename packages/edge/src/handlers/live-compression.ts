// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- the runtime's module has no declarations of its own, and a consumer that imports this one without `@types/node` reads them from here: no type entry or import can name a file of ambient declarations.
/// <reference path="../../types/node-zlib.d.ts" />
// eslint-disable-next-line no-restricted-imports, import-x/no-nodejs-modules -- the Workers runtime has no other compressor that can be told to flush; this module is the one place that compresses on the way out.
import { constants, createBrotliCompress, createBrotliDecompress, createGzip } from 'node:zlib';

import type { ShellEncoding } from '@stayingupwind/core/artifact';
import { concatBytes } from '@stayingupwind/core/util';
import {
  BROTLI_STORED_WINDOW_BITS,
  brotliStoredHead,
  brotliStoresOnly,
  brotliWire,
} from '@stayingupwind/host/splice';

import { logWarn } from '../observability/logger.ts';
import { IDENTITY_ENCODING, type ShellDelivery } from './document-headers.ts';

/**
 * Compress a document on the way out, flushing every few kilobytes.
 *
 * This is what the runtime's own compressor would be if it could be told when to flush. It cannot:
 * left to itself it holds the shell until there is enough input to emit a block, which for a PPR
 * document is when the continuation arrives — the wait this whole response exists to avoid. Here
 * the document is compressed and flushed as it is composed, so the shell reaches the client about
 * as early as it does uncompressed, in fewer bytes.
 *
 * Flushing per input chunk is not enough on its own, because the splice enqueues the whole shell
 * as one chunk: nothing would leave until the last of it had been encoded, which on a large shell
 * is most of what the client is waiting for. A chunk is therefore fed to the encoder in pieces,
 * the first of them small enough that the head's stylesheet links are out straight away.
 *
 * Used when the shell cannot go out pre-compressed: a project whose documents are rewritten for a
 * CSP nonce (the shell then differs per response, and a rendering compressed once cannot carry it),
 * a manifest naming no rendering, or a rendering that could not be read in time. Compressing per
 * response costs CPU on the critical path, so the quality is set for speed; a rendering prepared
 * ahead of time at the highest quality is the intended path, this the one that never lets a
 * document go out larger than it has to.
 */

/**
 * A middle quality: tens of times faster than the highest, at roughly a tenth more bytes on text —
 * which is what a shell on the critical path can afford, and still ahead of gzip.
 */
const BROTLI_QUALITY_LIVE = 5;

/**
 * How much of the document is encoded before the first flush, and before every flush after it.
 *
 * Only the first one buys anything, and it is the first of the whole response rather than of each
 * chunk: what the browser is waiting for is the `<link rel=stylesheet>` a Next.js head writes in
 * its first kilobyte, and a few TCP segments carry that comfortably. Once it has gone the client is
 * already fetching and the rest is just bytes, whichever chunk they arrive in. Every flush ends a
 * block, so pieces cost: on a 145 KB shell, measured, 4 KiB throughout is 7.4% more bytes than one
 * flush at the end, while 4 KiB and then 64 KiB is 0.5% — the same earliness for a fourteenth of
 * the price.
 *
 * These size what a chunk is cut into, and nothing waits to fill one. A chunk that has arrived is
 * always flushed, however small: the suffix arrives in whatever pieces the origin sends it in, and
 * holding one back to gather more bytes would be the wait this whole path exists to avoid.
 */
const FIRST_FLUSH_BYTES = 4096;
const FLUSH_PIECE_BYTES = 65_536;

/** An encoder as `node:zlib` streams present one; a test may hand in one that fails on purpose. */
export interface Compressor {
  readonly stream: ReturnType<typeof createGzip>;
  readonly flushKind: number;
}

function compressorFor(encoding: ShellEncoding): Compressor {
  if (encoding === 'br') {
    return {
      stream: createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY_LIVE,
        },
      }),
      flushKind: constants.BROTLI_OPERATION_FLUSH,
    };
  }
  // gzip is the fallback for a client without brotli; zlib's default level is left alone.
  return { stream: createGzip(), flushKind: constants.Z_SYNC_FLUSH };
}

/** The document's bytes as one `encoding` stream, flushed in pieces as the input arrives. */
export function compressLive(
  body: ReadableStream<Uint8Array>,
  encoding: ShellEncoding,
): ReadableStream<Uint8Array> {
  return compressWith(body, compressorFor(encoding));
}

export function compressWith(
  body: ReadableStream<Uint8Array>,
  compressor: Compressor,
): ReadableStream<Uint8Array> {
  const { stream, flushKind } = compressor;
  // The one step in flight — a chunk's flush, or the final end — so that an encoder error settles
  // it: a step left waiting would hold the pipe open, and with it the origin fetch behind it.
  let pending: PromiseWithResolvers<undefined> | undefined;
  let failure: Error | undefined;
  /** Whether the small first piece has been cut yet. The head is in it, and it is cut once. */
  let started = false;
  /** Whether the client has gone, and with it anything that takes what the encoder writes. */
  let cancelled = false;
  const step = (run: (done: () => void) => void): Promise<undefined> => {
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    const current = Promise.withResolvers<undefined>();
    pending = current;
    run(() => {
      current.resolve(undefined);
      pending = undefined;
    });
    return current.promise;
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      stream.on('data', (chunk) => {
        // Nothing takes it once the client has gone: the readable would throw, where no one
        // catches it, on the output of a step that was under way.
        if (cancelled) {
          return;
        }
        // A copy: the chunk is the encoder's own buffer, and the stream may hold it a while.
        controller.enqueue(new Uint8Array(chunk));
      });
      stream.on('error', (error) => {
        failure = error;
        controller.error(error);
        pending?.reject(error);
        pending = undefined;
      });
    },
    // Settled on the flush, not on the write: a flush is what makes a piece's bytes leave, and a
    // write that merely queued would let the next read run ahead of the last one's send.
    transform: async (chunk) => {
      let at = 0;
      while (at < chunk.byteLength) {
        const size = started ? FLUSH_PIECE_BYTES : FIRST_FLUSH_BYTES;
        const piece = chunk.subarray(at, at + size);
        at += size;
        started = true;
        await step((done) => {
          stream.write(piece);
          stream.flush(flushKind, done);
        });
        // The client may have left while the piece was encoded: no more of it is.
        if (cancelled) {
          return;
        }
      }
    },
    flush: () => {
      return step((done) => {
        stream.on('end', done);
        stream.end();
      });
    },
    // The client left: the encoder is let go now rather than when it is collected, and a step it
    // was in the middle of is settled, so nothing goes on encoding what nobody reads.
    cancel: () => {
      cancelled = true;
      pending?.resolve(undefined);
      pending = undefined;
      if (failure === undefined) {
        stream.end();
      }
    },
  });
  return body.pipeThrough(transform);
}

/**
 * A rendering's document with its suffix compressed too: the single-layer wire
 * (`@stayingupwind/host/splice`'s `wire.ts`) inside a second brotli stream, `content-encoding: br,
 * br`.
 *
 * The rendering is the head of a brotli stream compressed at the highest quality, and the suffix
 * the application resumes can only be framed behind it uncompressed, because no encoder can
 * continue a stream it did not write. So that whole stream — head, framed suffix, closing byte —
 * is encoded again, and a browser undoes the two in turn (RFC 9110 §8.4). The head is already as
 * small as brotli makes it: the second layer has nothing to gain from it, and must not make it
 * wait. It goes out the moment it arrives as stored blocks of the outer stream, before any encoder
 * exists (`brotliStoredHead`): the bytes the single layer sends, one more, and three per 64 KiB.
 *
 * What follows it is compressed by an encoder that is first given the head, and whose output for
 * it is dropped. An encoder stores a stream it can find nothing in, and once it has — checked, not
 * assumed (`brotliStoresOnly`) — it is in the state the client's decoder is in after the stored
 * head the edge already sent, so what it writes next follows that. A head an encoder did not make,
 * such as a stored one a test may seed, is compressible, fails the check, and has the rest stored
 * too: the single layer's bytes, framed once more. That is the whole fallback, and a failing
 * encoder takes it as well, so long as it fails on the head.
 *
 * The encoder is made when the first chunk after the head arrives, not with the head. A resumed
 * document spends most of its life waiting for the render, and an encoder held from the head on
 * would be a megabyte an isolate holds through every render it serves; made at the suffix, it costs
 * the first chunk the head's encoding instead, around a tenth of a millisecond.
 */

/**
 * The outer stream's own framing, the same for every document: its first byte (WBITS=16 and an
 * empty metadata block), stored blocks around whatever it carries, and its closing byte.
 */
const STORED_LAYER = brotliWire(brotliStoredHead(new Uint8Array()));

/** The live quality, over the one window the stored first byte lets an encoder continue it in. */
function layerCompressor(): Compressor {
  return {
    stream: createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY_LIVE,
        [constants.BROTLI_PARAM_LGWIN]: BROTLI_STORED_WINDOW_BITS,
      },
    }),
    flushKind: constants.BROTLI_OPERATION_FLUSH,
  };
}

/**
 * An encoder driven a step at a time, each step's output handed back whole once the step is done
 * rather than as the encoder emits it: nothing it writes reaches the response except where the
 * layer puts it — never its output for the head, never anything after it failed.
 */
class LayerEncoder {
  readonly #stream: Compressor['stream'];
  readonly #flushKind: number;
  #output: Uint8Array[] = [];
  /** The step in flight, so that an encoder error settles it rather than leave it waiting. */
  #pending: PromiseWithResolvers<Uint8Array> | undefined;
  #failure: Error | undefined;

  constructor(compressor: Compressor) {
    this.#stream = compressor.stream;
    this.#flushKind = compressor.flushKind;
    this.#stream.on('data', (chunk) => {
      // A copy: the chunk is the encoder's own buffer.
      this.#output.push(new Uint8Array(chunk));
    });
    this.#stream.on('error', (error) => {
      this.#failure = error;
      this.#pending?.reject(error);
      this.#pending = undefined;
    });
  }

  #run(start: (done: () => void) => void): Promise<Uint8Array> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const current = Promise.withResolvers<Uint8Array>();
    this.#pending = current;
    start(() => {
      this.#pending = undefined;
      const output = concatBytes(this.#output);
      this.#output = [];
      current.resolve(output);
    });
    return current.promise;
  }

  /** What the encoder writes for `chunk`, flushed. */
  step(chunk: Uint8Array): Promise<Uint8Array> {
    return this.#run((done) => {
      this.#stream.write(chunk);
      this.#stream.flush(this.#flushKind, done);
    });
  }

  /** What the encoder writes to end its stream. */
  end(): Promise<Uint8Array> {
    return this.#run((done) => {
      this.#stream.on('end', done);
      this.#stream.end();
    });
  }

  /** Let the encoder go now, rather than when it is collected; nothing it writes is read again. */
  release(): void {
    this.#pending = undefined;
    if (this.#failure === undefined) {
      this.#stream.end();
    }
  }
}

function enqueueAll(
  controller: TransformStreamDefaultController<Uint8Array>,
  parts: readonly Uint8Array[],
): void {
  for (const part of parts) {
    if (part.byteLength > 0) {
      controller.enqueue(part);
    }
  }
}

/** The second layer over the single-layer wire, whose first chunk is the rendering's head. */
class BrotliLayer {
  readonly #create: () => Compressor;
  /** The first chunk: stored the moment it arrived, and what the encoder is given first. */
  #head: Uint8Array | undefined;
  /** The encoder, once shown to follow the stored head; `undefined` when the rest is stored. */
  #layer: Promise<LayerEncoder | undefined> | undefined;
  #cancelled = false;

  constructor(create: () => Compressor) {
    this.#create = create;
  }

  #encoderFor(head: Uint8Array): Promise<LayerEncoder | undefined> {
    this.#layer ??= this.#replay(head);
    return this.#layer;
  }

  /** An encoder given the head and shown to have stored it; else `undefined`, never a rejection. */
  async #replay(head: Uint8Array): Promise<LayerEncoder | undefined> {
    let encoder: LayerEncoder | undefined;
    try {
      encoder = new LayerEncoder(this.#create());
      if (brotliStoresOnly(await encoder.step(head), head)) {
        return encoder;
      }
      logWarn('brotli layer stores the suffix: its encoder compressed the head', {
        headBytes: head.byteLength,
      });
    } catch (error) {
      logWarn('brotli layer stores the suffix: its encoder failed on the head', {
        headBytes: head.byteLength,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    encoder?.release();
    return undefined;
  }

  async transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    if (this.#head === undefined) {
      // The first byte of the response: out before this call returns, with no encoder behind it,
      // and in one chunk, as the single layer sends its head — not a byte and a block header ahead.
      this.#head = chunk;
      controller.enqueue(brotliStoredHead(chunk));
      return;
    }
    const encoder = await this.#encoderFor(this.#head);
    const parts = encoder === undefined ? STORED_LAYER.frame(chunk) : [await encoder.step(chunk)];
    if (!this.#cancelled) {
      enqueueAll(controller, parts);
    }
  }

  async flush(controller: TransformStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.#head === undefined) {
      enqueueAll(controller, [STORED_LAYER.shell, STORED_LAYER.finish()]);
      return;
    }
    const encoder = await this.#encoderFor(this.#head);
    enqueueAll(controller, [encoder === undefined ? STORED_LAYER.finish() : await encoder.end()]);
  }

  cancel(): void {
    this.#cancelled = true;
    const layer = this.#layer;
    if (layer !== undefined) {
      // Not awaited: an encoder still busy with the head must not hold up the cancel, which is what
      // lets the application's response behind it go.
      void releaseWhenSettled(layer).catch((error: unknown) => {
        logWarn('brotli layer could not release its encoder', { error: String(error) });
      });
    }
  }
}

async function releaseWhenSettled(layer: Promise<LayerEncoder | undefined>): Promise<void> {
  const encoder = await layer;
  encoder?.release();
}

/** The single-layer wire of a rendering under a second brotli layer; see above. */
export function compressLayered(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return layerWith(body, layerCompressor);
}

export function layerWith(
  body: ReadableStream<Uint8Array>,
  create: () => Compressor,
): ReadableStream<Uint8Array> {
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(new BrotliLayer(create)));
}

/**
 * The body as it goes out: compressed live, under the second layer, or as the splice composed it —
 * a rendering's single layer, or identity.
 */
export function onTheWayOut(
  body: ReadableStream<Uint8Array>,
  delivery: ShellDelivery,
): ReadableStream<Uint8Array> {
  if (delivery.outbound === 'layered') {
    return compressLayered(body);
  }
  if (delivery.outbound === 'live' && delivery.encoding !== IDENTITY_ENCODING) {
    return compressLive(body, delivery.encoding);
  }
  return body;
}

/** A gate's encoded bytes are decoded before its per-response HTML nonce can be rewritten. */
export function decompressLive(
  body: ReadableStream<Uint8Array>,
  encoding: 'br' | 'gzip' | 'deflate',
): ReadableStream<Uint8Array> {
  return encoding === 'br'
    ? compressWith(body, {
        stream: createBrotliDecompress(),
        flushKind: constants.BROTLI_OPERATION_FLUSH,
      })
    : body.pipeThrough(new DecompressionStream(encoding));
}
