/**
 * The slice of `node:zlib` the edge uses to compress a document on the way out, and a test may use
 * to make a rendering the way a deploy does. The Workers runtime provides the module
 * (`nodejs_compat` is on by compatibility date), but `wrangler types` emits no declarations for it,
 * and pulling in `@types/node` would put Node's globals into a Worker project.
 */
declare module 'node:zlib' {
  interface ZlibConstants {
    readonly Z_SYNC_FLUSH: number;
    readonly BROTLI_OPERATION_FLUSH: number;
    readonly BROTLI_PARAM_MODE: number;
    readonly BROTLI_MODE_TEXT: number;
    readonly BROTLI_PARAM_QUALITY: number;
    readonly BROTLI_PARAM_LGWIN: number;
  }
  interface BrotliOptions {
    readonly params?: Record<number, number>;
    readonly finishFlush?: number;
  }
  /** A compressor as a Node stream: written to, flushed, ended; its output arrives as `data`. */
  interface CompressorStream {
    write(chunk: Uint8Array): boolean;
    flush(kind: number, callback: () => void): void;
    end(): void;
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
  export const constants: ZlibConstants;
  export function createBrotliCompress(options?: BrotliOptions): CompressorStream;
  export function createGzip(): CompressorStream;
  export function createBrotliDecompress(): CompressorStream;
  export function gzipSync(input: Uint8Array): Uint8Array;
  export function deflateSync(input: Uint8Array): Uint8Array;
  export function brotliCompressSync(input: Uint8Array, options?: BrotliOptions): Uint8Array;
  export function brotliDecompressSync(input: Uint8Array, options?: BrotliOptions): Uint8Array;
  export function gunzipSync(
    input: Uint8Array,
    options?: { readonly finishFlush?: number },
  ): Uint8Array;
}
