import { releaseStream } from '@stayingupwind/core/util';

import { cuttable, type Cuttable } from '../handlers/image-stream.ts';

/** Record bytes may be a view whose sentinel capacity is outside the record. */
export type RecordBytes = ArrayBuffer | Uint8Array<ArrayBuffer>;
type CacheRead = ArrayBuffer | ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
const STOPPED = 'cache body no longer needed';
const WRONG_LENGTH = 'cache body length mismatch';

function lengthOf(hit: Response): number | undefined {
  const value = hit.headers.get('content-length');
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/** A cache body's read, which its deadline or the source that beats it can give up. */
export class CacheBody {
  #body: Cuttable | undefined;
  #reader: ReadableStreamBYOBReader | undefined;
  #expected: number | undefined;
  #stopped = false;

  get stopped(): boolean {
    return this.#stopped;
  }

  stop(): void {
    this.#stopped = true;
    releaseStream(this.#reader, STOPPED);
    this.#reader?.releaseLock();
    this.#reader = undefined;
    this.#body?.cut(new Error(STOPPED));
    this.#body = undefined;
  }

  /** Normal Cache API hits expose native byte streams and their stored length. */
  open(hit: Response, expected?: number): Promise<CacheRead> | undefined {
    if (this.#stopped) {
      releaseStream(hit.body, STOPPED);
      return undefined;
    }
    const storedLength = lengthOf(hit);
    if (expected !== undefined && storedLength !== undefined && expected !== storedLength) {
      releaseStream(hit.body, WRONG_LENGTH);
      throw new Error(WRONG_LENGTH);
    }
    this.#expected = expected ?? storedLength;
    if (hit.body === null) return hit.arrayBuffer();
    const length = this.#expected;
    if (length !== undefined && Number.isSafeInteger(length + 1) && length >= 0) {
      try {
        this.#reader = hit.body.getReader({ mode: 'byob' });
      } catch {
        // Non-byte test or adapter streams retain the cancellable buffer fallback.
      }
      if (this.#reader !== undefined) {
        // Waiting for one extra byte distinguishes exact EOF from a longer body in one read.
        const capacity = length + 1;
        return this.#reader.readAtLeast(capacity, new Uint8Array(capacity));
      }
    }
    this.#body = cuttable(hit.body as ReadableStream<Uint8Array>);
    return new Response(this.#body.stream).arrayBuffer();
  }

  finish(result: CacheRead): RecordBytes {
    if (this.#stopped) throw new Error(STOPPED);
    const bytes = result instanceof ArrayBuffer ? result : (result.value ?? new Uint8Array(0));
    if (this.#expected !== undefined && bytes.byteLength !== this.#expected) {
      this.stop();
      throw new Error(WRONG_LENGTH);
    }
    this.#reader?.releaseLock();
    this.#reader = undefined;
    this.#body = undefined;
    return bytes;
  }
}
