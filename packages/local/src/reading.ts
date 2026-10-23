import { createHash } from 'node:crypto';
import http from 'node:http';
import { PassThrough, pipeline, type Readable, type Transform } from 'node:stream';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- a browser accepts zstd, as Chrome does, and an application may answer in it
  createZstdDecompress,
} from 'node:zlib';

/**
 * What the check keeps of an answer, read as it streams to its end and held nowhere whole: a
 * document or a file is as long as its application makes it, and a check that held one entire
 * could run out of memory before it said anything. Kept are the body's length and digest, its
 * first bytes (as many as a shell has), its last ones, whether a marker was anywhere in it, and
 * what was made of a copy of it sent on as it streamed.
 */
export interface Reading {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly length: number;
  readonly sha256: string;
  /** Its first bytes, as many as were asked for (`ReadOptions.headBytes`). */
  readonly head: Buffer;
  /** Its last bytes, up to `TAIL_BYTES`. */
  readonly tail: Buffer;
  /** Whether the bytes asked about (`ReadOptions.marker`) are anywhere in it. */
  readonly marked: boolean;
  /**
   * Whether it was let go of at its headers (`ReadOptions.headersOnly`) or body bound
   * (`ReadOptions.limitBytes`): its length, digest
   * and tail are then those of what was read, not of the body.
   */
  readonly truncated: boolean;
  /** What a copy of the body was answered with, where one was sent on (`ReadOptions.copyTo`). */
  readonly copied?: Copied | undefined;
}

/** A copy's answer: its status and its text, or why there was none. */
type Copied =
  | { readonly kind: 'answered'; readonly status: number; readonly text: string }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ReadOptions {
  /** `GET` where this names none. */
  readonly method?: 'GET' | 'HEAD' | undefined;
  /**
   * The socket the request is made to, where not the one its URL names: the stack's, for a request
   * that names the site as a host's validation does (`Host`, in `headers`).
   */
  readonly via?: URL | undefined;
  /** Exactly these: a navigation's fetch metadata among them, which `fetch` would replace. */
  readonly headers: Readonly<Record<string, string>>;
  readonly headBytes?: number | undefined;
  readonly marker?: Buffer | undefined;
  /** How long the answer may take, to its last byte. */
  readonly deadlineMs: number;
  /** Keep only headers, optionally selected from this response before any body is consumed. */
  readonly headersOnly?:
    | boolean
    | ((status: number, headers: http.IncomingHttpHeaders) => boolean)
    | undefined;
  /**
   * How much of the body is read, once which the answer is let go of — said to be cut short — all of
   * it, where this names nothing: for an answer only its start is asked of, one a Function may
   * stream for as long as it likes. One that is to be no longer than some length is read to a byte
   * past it, which only a longer one reaches.
   */
  readonly limitBytes?: number | undefined;
  /**
   * Where a copy of the body is posted as it streams, if the answer's headers name somewhere: to
   * have made of it there what the check, which holds it nowhere whole, cannot make of it — by the
   * stack's backstage, say. Its answer is the reading's (`Reading.copied`), read once the body has
   * ended; a body let go of past `limitBytes` has none.
   */
  readonly copyTo?: ((headers: http.IncomingHttpHeaders) => URL | undefined) | undefined;
  /**
   * Whether the body is undone of the codings its answer names (`Content-Encoding`) as it streams,
   * as a browser undoes them, the last applied first: what is kept — and copied — is then what the
   * browser reads, not the bytes sent. A coding the check does not undo — none a browser asks in —
   * fails the reading. Decided of the answer's headers where it is a function: an answer that turns
   * out to be a stored file is kept as it was stored.
   */
  readonly decode?: boolean | ((headers: http.IncomingHttpHeaders) => boolean) | undefined;
}

/**
 * What undoes each coding the check reads a body in: every one a browser asks for at once
 * (`gzip, deflate, br, zstd`), which an application may answer in where the edge hands it on.
 */
const DECODERS: ReadonlyMap<string, () => Transform> = new Map([
  ['br', () => createBrotliDecompress()],
  ['deflate', () => createInflate()],
  ['gzip', () => createGunzip()],
  ['x-gzip', () => createGunzip()],
  ['zstd', () => createZstdDecompress()],
]);

/** `response`'s body undone of the codings it names, the last applied first (`decode`). */
function decodedBody(response: http.IncomingMessage): Readable {
  const named = (response.headers['content-encoding'] ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity');
  const decoders: Transform[] = [];
  for (const coding of named.toReversed()) {
    const decoder = DECODERS.get(coding)?.();
    if (decoder === undefined) {
      // Let go of at once, rather than held open to the request's deadline.
      response.destroy();
      const refused = new PassThrough();
      queueMicrotask(() => {
        refused.destroy(new Error(`answered in ${coding}, a coding the check does not undo`));
      });
      return refused;
    }
    decoders.push(decoder);
  }
  const last = decoders.at(-1);
  if (last === undefined) {
    return response;
  }
  // One chain, let go of whole: a layer that fails — bytes it cannot undo — and a body let go of
  // past its bound take every other layer and the response with them, rather than leave them open.
  pipeline([response, ...decoders], () => {
    // What failed is told the last layer, which the reading listens to.
  });
  return last;
}

/** Enough for a document's closing tags and the whitespace that may follow them. */
const TAIL_BYTES = 1024;
const EMPTY: Buffer = Buffer.alloc(0);

/** Whether this response ends at its headers, decided before decoding or copying its body. */
function onlyHeaders(options: ReadOptions, response: http.IncomingMessage): boolean {
  return typeof options.headersOnly === 'function'
    ? options.headersOnly(response.statusCode ?? 0, response.headers)
    : options.headersOnly === true;
}

/** The last `count` bytes of `before` followed by `chunk`. */
function lastOf(before: Buffer, chunk: Buffer, count: number): Buffer {
  if (chunk.byteLength >= count) {
    return chunk.subarray(chunk.byteLength - count);
  }
  const joined = Buffer.concat([before, chunk]);
  return joined.subarray(Math.max(0, joined.byteLength - count));
}

/** What is read of a body so far, chunk by chunk. */
class Kept {
  readonly #hash = createHash('sha256');
  readonly #headBytes: number;
  readonly #marker: Buffer | undefined;
  #carry: Buffer = EMPTY;
  length = 0;
  head: Buffer = EMPTY;
  tail: Buffer = EMPTY;
  marked = false;

  constructor(options: ReadOptions) {
    this.#headBytes = options.headBytes ?? 0;
    this.#marker = options.marker;
  }

  take(chunk: Buffer): void {
    this.#hash.update(chunk);
    this.length += chunk.byteLength;
    if (this.head.byteLength < this.#headBytes) {
      const wanted = this.#headBytes - this.head.byteLength;
      this.head = Buffer.concat([this.head, chunk.subarray(0, wanted)]);
    }
    this.tail = lastOf(this.tail, chunk, TAIL_BYTES);
    const marker = this.#marker;
    if (marker !== undefined && !this.marked) {
      // A marker split across two chunks is found in the bytes kept from the one before.
      const window = Buffer.concat([this.#carry, chunk]);
      this.marked = window.includes(marker);
      this.#carry = window.subarray(Math.max(0, window.byteLength - (marker.byteLength - 1)));
    }
  }

  digest(): string {
    return this.#hash.digest('hex');
  }
}

/**
 * A copy of a body, posted to `at` as the body streams (`ReadOptions.copyTo`), and its answer: read
 * whole, as an answer of the check's own making is small. A copy that fails says why, and the
 * reading goes on.
 */
class Copy {
  readonly #request: http.ClientRequest;
  /** What goes on reading the body once the copy's way has drained, while it waits to. */
  #waiting: (() => void) | undefined;
  /** The copy's answer, once it has one, and what is told it once the body has ended. */
  #answer: Copied | undefined;
  #ended: ((copied: Copied) => void) | undefined;

  constructor(at: URL, signal: AbortSignal) {
    const failed = (error: unknown): void => {
      const reason = error instanceof Error ? error.message : String(error);
      this.#settle({ kind: 'failed', reason });
    };
    this.#request = http.request(at, { method: 'POST', signal }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        this.#settle({ kind: 'answered', status: response.statusCode ?? 0, text });
      });
      response.on('error', failed);
    });
    this.#request.on('error', failed);
    this.#request.on('drain', () => {
      this.#resume();
    });
  }

  /** The copy's first answer: one that failed holds the body up no longer. */
  #settle(copied: Copied): void {
    if (this.#answer !== undefined) {
      return;
    }
    this.#answer = copied;
    this.#resume();
    this.#tell();
  }

  #tell(): void {
    const answer = this.#answer;
    const ended = this.#ended;
    if (answer === undefined || ended === undefined) {
      return;
    }
    this.#ended = undefined;
    ended(answer);
  }

  #resume(): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.();
  }

  /**
   * `chunk` sent on, and whether to go on reading at once: where the copy's way is full, the body
   * waits for it to drain (`resume`), so as not to hold what the copy has yet to send.
   */
  write(chunk: Buffer, resume: () => void): boolean {
    if (this.#request.destroyed || this.#request.write(chunk)) {
      return true;
    }
    this.#waiting = resume;
    return false;
  }

  /** Ended, its answer told `then` once it has one. */
  end(then: (copied: Copied) => void): void {
    if (!this.#request.destroyed) {
      this.#request.end();
    }
    this.#ended = then;
    this.#tell();
  }

  /** Let go of, for a body let go of before its end. */
  abandon(): void {
    this.#request.destroy();
  }
}

/** Keep the physical authority while carrying the logical path, even when it begins with `//`. */
function requestTarget(url: URL, via: URL | undefined): URL {
  if (via === undefined) return url;
  const target = new URL(via);
  target.pathname = url.pathname;
  target.search = url.search;
  target.hash = '';
  return target;
}

/**
 * A GET of `url` (or a HEAD, `options.method`) with exactly `options.headers`, its body kept as
 * `Reading` says: as it comes, with nothing decoded — which a check asks for (`accept-encoding:
 * identity`) — so as it is stored; or undone of its codings, where it is asked for in one
 * (`decode`).
 */
export function read(url: URL, options: ReadOptions): Promise<Reading> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(options.deadlineMs);
    const { headers, method = 'GET', via } = options;
    const target = requestTarget(url, via);
    const request = http.request(target, { method, headers, signal }, (response) => {
      const kept = new Kept(options);
      // Once: a response let go of past its bound may still say it ended, and its digest is taken
      // only the once it can be.
      let settled = false;
      const settle = (truncated: boolean, copied: Copied | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          length: kept.length,
          sha256: kept.digest(),
          head: kept.head,
          tail: kept.tail,
          marked: kept.marked,
          truncated,
          ...(copied !== undefined && { copied }),
        });
      };
      if (onlyHeaders(options, response)) {
        // Intentional cancellation may still emit an error; the reading is already settled.
        response.on('error', reject);
        settle(true, undefined);
        response.destroy();
        return;
      }
      const copyAt = options.copyTo?.(response.headers);
      const copy = copyAt === undefined ? undefined : new Copy(copyAt, signal);
      const decoding =
        typeof options.decode === 'function'
          ? options.decode(response.headers)
          : options.decode === true;
      const body = decoding ? decodedBody(response) : response;
      const resume = (): void => {
        body.resume();
      };
      body.on('data', (chunk: Buffer) => {
        // Buffered events can outlive cancellation; a settled digest must stay final.
        if (settled) return;
        kept.take(chunk);
        if (options.limitBytes !== undefined && kept.length >= options.limitBytes) {
          copy?.abandon();
          settle(true, undefined);
          body.destroy();
          response.destroy();
          return;
        }
        if (copy?.write(chunk, resume) === false) {
          body.pause();
        }
      });
      body.on('end', () => {
        if (copy === undefined) {
          settle(false, undefined);
          return;
        }
        // Once the copy was answered as well: what it was answered is part of the reading.
        copy.end((copied) => {
          settle(false, copied);
        });
      });
      body.on('error', (error) => {
        copy?.abandon();
        reject(error);
      });
    });
    request.on('error', reject);
    request.end();
  });
}
