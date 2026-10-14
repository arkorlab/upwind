import {
  BEHAVIORAL_RESPONSE_HEADERS,
  CONTENT_DISPOSITION_HEADER,
  REDIRECT_STATUSES,
  rendersInline,
} from '@stayingupwind/core/request';
import {
  concatBytes,
  documentTerminates,
  isHtmlContentType,
  releaseStream,
  TERMINATION_WINDOW_BYTES,
} from '@stayingupwind/core/util';

import { unsentCookieNames } from './cookies.ts';
import type { SpliceOutcome, SplicePhase } from './outcome.ts';
import { identityWire, type WireEncoding } from './wire.ts';

export interface SpliceOptions {
  /** The shell the document begins with, as the wire encoding will carry it. */
  readonly shell: Uint8Array;
  /** What goes on the wire for the shell and around every suffix chunk; identity when absent. */
  readonly wire?: WireEncoding | undefined;
  readonly upstream: Promise<Response>;
  /**
   * The `Set-Cookie` values the shell's headers carried — what a middleware set. A resume may
   * repeat them (`cookies.ts`); any other cookie ends the splice.
   */
  readonly sentCookies?: readonly string[] | undefined;
  /**
   * The `x-middleware-set-cookie` the render was handed beside its request: of the cookies the
   * shell carried, those it names the resume may also answer with as Next.js writes them back.
   */
  readonly handedCookies?: string | undefined;
  /**
   * The path the client asked for: a cookie the shell carried naming no path of its own is stored
   * under it (`cookies.ts`). The root where absent.
   */
  readonly requestPathname?: string | undefined;
  readonly recoveryHtml: Uint8Array;
  readonly now: () => number;
  readonly firstByteTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly abortUpstream: (reason: string) => void;
}

/** What a middleware set, as a resume's cookies are weighed against it (`unsentCookieNames`). */
export type MiddlewareCookies = Pick<
  SpliceOptions,
  'handedCookies' | 'requestPathname' | 'sentCookies'
>;

export interface Splice {
  readonly readable: ReadableStream<Uint8Array>;
  readonly outcome: Promise<SpliceOutcome>;
}

type Phase = SplicePhase;
const HEAD_PHASE: Phase = 'head';

const OK_STATUS = 200;
const TIMEOUT_ABORT_REASON = 'continuation timeout';

class TimeoutError extends Error {
  readonly phase: Phase;

  constructor(phase: Phase, options?: ErrorOptions) {
    super(`continuation ${phase} timeout`, options);
    this.name = 'TimeoutError';
    this.phase = phase;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, phase: Phase): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(phase));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** How much of a refused answer is kept, for whoever reads why it was refused. */
const OPENING_BYTES = 400;
/** And how much of the list of header names it came with; the names are short and few. */
const HEADER_NAMES_BYTES = 400;

/**
 * The names of a refused answer's headers, sorted and comma-joined, bounded.
 *
 * Names only: a value may hold a cookie or a token, and what is being told apart here — which
 * layer answered — is told by the names alone. Sorted so the same answer reads the same whatever
 * order it arrived in, which is what lets a query group by it.
 */
function headerNamesOf(headers: Headers): string {
  // `localeCompare` rather than byte order: `Headers` lowercases every name it holds, so the two
  // agree on the ASCII these are, and this is the one the linter can see is deliberate.
  return [...headers.keys()]
    .toSorted((one, other) => one.localeCompare(other))
    .join(',')
    .slice(0, HEADER_NAMES_BYTES);
}

/**
 * The opening of a body this is about to give up on, as text.
 *
 * Read rather than simply released, and then released: a status alone does not say why a
 * deployment answers 500 on every one of its routes, and an error page usually says something.
 * Bounded at `OPENING_BYTES`, and taken only where the answer is already refused, so nothing on the
 * path that works pays for it. `undefined` where there was no body or it could not be read — a
 * reason to give up is not a reason to throw.
 *
 * And within `withinMs`, what is left of the splice's budget: an answer that sent its headers and
 * then nothing would otherwise hold the committed shell, with no recovery sent, until the runtime
 * ended the request. Out of it — before the read, or during it — it throws the `TimeoutError`, for
 * the caller to let the upstream go as a stall anywhere else is let go of.
 */
async function openingOf(
  body: ReadableStream<Uint8Array> | null,
  withinMs: number,
): Promise<string | undefined> {
  if (body === null) {
    return undefined;
  }
  const reader = body.getReader();
  try {
    if (withinMs <= 0) {
      throw new TimeoutError(HEAD_PHASE);
    }
    const { value } = await withTimeout(reader.read(), withinMs, HEAD_PHASE);
    return value === undefined
      ? undefined
      : new TextDecoder().decode(value.slice(0, OPENING_BYTES));
  } catch (error) {
    if (error instanceof TimeoutError) {
      throw error;
    }
    return undefined;
  } finally {
    // Released the way `releaseStream` releases one, and for the reason it does not await: a body
    // that never acknowledges a cancel would otherwise hold this until the request's own deadline,
    // and what is being given up on here is already a failure.
    releaseStream(reader, 'bad upstream response');
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upstreamError(phase: Phase, forwarded: number, error: unknown): SpliceOutcome {
  return { kind: 'upstream-error', phase, forwarded, detail: errorDetail(error), recovered: false };
}

function isHtmlResponse(response: Response): boolean {
  return response.status === OK_STATUS && isHtmlContentType(response.headers.get('content-type'));
}

export function behavioralHeader(response: Response): string | undefined {
  const header = BEHAVIORAL_RESPONSE_HEADERS.find((name) => response.headers.has(name));
  if (header !== undefined) {
    return header;
  }
  // The reading proof takes, or this would condemn on its first request every route proof had just
  // admitted: `inline` is what a document response already says, and Next.js puts it on ordinary
  // pages. Anything else is a download or a value neither of us recognises.
  const disposition = response.headers.get(CONTENT_DISPOSITION_HEADER);
  if (disposition !== null && !rendersInline(disposition)) {
    return CONTENT_DISPOSITION_HEADER;
  }
  // Status and Location must reach the browser together. The committed 200 shell cannot carry
  // that redirect, so delegate the route just as for other browser behavior that it would lose.
  return REDIRECT_STATUSES.has(response.status) && response.headers.has('location')
    ? 'location'
    : undefined;
}

/**
 * Concatenate `[shell][resumed suffix]` into one response body.
 *
 * The shell is enqueued synchronously, before the application's Worker has produced a byte, so
 * time-to-first-byte never depends on the render. The bytes that carry the shell and the framing
 * around every suffix chunk belong to the wire encoding. What the upstream sends is the suffix
 * alone — it was asked to render only what the shell left out — so there is no prefix to discard
 * and nothing to compare: the suffix is forwarded from its first byte. What the splice still
 * refuses is a response the committed shell cannot carry (a cookie, a redirect, a download) and
 * one that ends without the document ending.
 */
class SplicePump {
  readonly #options: SpliceOptions;
  readonly #wire: WireEncoding;
  readonly #startedAt: number;
  readonly #resolvers = Promise.withResolvers<SpliceOutcome>();
  #tail: Uint8Array = new Uint8Array();
  /** When the first non-empty body chunk arrived; the `fetch` promise resolves on headers alone. */
  #firstByteAt: number | undefined;
  #forwarded = 0;
  #receivedSuffixBytes = 0;
  #cancelled = false;
  #recovered = false;
  #suffixStarted = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #demand: PromiseWithResolvers<undefined> | undefined;

  constructor(options: SpliceOptions) {
    this.#options = options;
    this.#wire = options.wire ?? identityWire(options.shell);
    this.#startedAt = options.now();
  }

  get #phase(): Phase {
    return this.#suffixStarted ? 'suffix' : HEAD_PHASE;
  }

  #settle(outcome: SpliceOutcome): void {
    this.#resolvers.resolve(outcome);
  }

  /** Every way the response ends passes through here, so the wire format is always closed. */
  #finish(outcome: SpliceOutcome): void {
    if (!this.#cancelled) {
      const trailer = this.#wire.finish();
      if (trailer.byteLength > 0) {
        this.#controller?.enqueue(trailer);
      }
      this.#controller?.close();
    }
    this.#settle(outcome);
  }

  #enqueueFramed(chunk: Uint8Array): void {
    if (this.#cancelled || chunk.byteLength === 0) {
      return;
    }
    for (const part of this.#wire.frame(chunk)) {
      this.#controller?.enqueue(part);
    }
  }

  #recover(): boolean {
    if (this.#cancelled) {
      return false;
    }
    this.#enqueueFramed(this.#options.recoveryHtml);
    this.#recovered = true;
    return true;
  }

  #fail(outcome: SpliceOutcome): void {
    const recovered = this.#recover();
    this.#finish('recovered' in outcome ? { ...outcome, recovered } : outcome);
  }

  async #run(): Promise<void> {
    const response = await this.#awaitResponse();
    if (response === undefined) {
      return;
    }
    // The response headers were committed before the render began, so a cookie set by the resumed
    // part cannot reach the client. Stop before forwarding anything and let the recovery script
    // re-run the request through the application's Worker, where it can set the cookie for real —
    // unless the shell went out with it already (`cookies.ts`).
    const cookies = unsentCookieNames(
      response.headers.getSetCookie(),
      this.#options.sentCookies,
      this.#options.handedCookies,
      this.#options.requestPathname,
    );
    if (cookies.length > 0) {
      this.#fail({ kind: 'set-cookie-observed', names: cookies, recovered: false });
      releaseStream(response.body, 'set-cookie observed');
      return;
    }
    // Asked before the status is, so redirects, downloads and bodyless responses are asked too:
    // those routes must be left to the application's Worker rather than stay eligible for the
    // same failed splice as a `bad-upstream-response` would leave them.
    const behavioral = behavioralHeader(response);
    if (behavioral !== undefined) {
      this.#fail({ kind: 'behavioral-header-observed', header: behavioral, recovered: false });
      releaseStream(response.body, 'behavioral header observed');
      return;
    }
    if (!isHtmlResponse(response) || response.body === null) {
      let body: string | undefined;
      try {
        body = await openingOf(response.body, this.#remainingMs());
      } catch {
        // Out of time on the way: the upstream is let go of as a stall anywhere else is, and the
        // reason is told without the opening it never sent.
        this.#options.abortUpstream(TIMEOUT_ABORT_REASON);
      }
      this.#fail({
        kind: 'bad-upstream-response',
        status: response.status,
        body,
        headers: headerNamesOf(response.headers),
        recovered: false,
      });
      return;
    }
    const reader = response.body.getReader();
    const completed = await this.#drain(reader);
    if (!completed) {
      return;
    }
    // EOF is not proof of completeness: a crashed render ends the stream cleanly too.
    if (!documentTerminates(this.#tail)) {
      this.#fail({
        kind: 'unterminated',
        forwarded: this.#forwarded,
        receivedSuffixBytes: this.#receivedSuffixBytes,
        recovered: false,
      });
      return;
    }
    this.#finish({
      kind: 'ok',
      suffixBytes: this.#forwarded,
      originFirstByteMs: this.#originFirstByteMs,
      totalMs: this.#options.now() - this.#startedAt,
    });
  }

  /**
   * Latency to the first body byte, not to the response headers.
   *
   * `fetch` resolves as soon as the headers arrive, and for a continuation that is long before the
   * part that matters: an origin that answers instantly and then takes seconds over the suffix
   * would otherwise be recorded as the fastest there is, and every comparison between continuation
   * policies would be made against header latency.
   */
  get #originFirstByteMs(): number {
    return (this.#firstByteAt ?? this.#options.now()) - this.#startedAt;
  }

  async #awaitResponse(): Promise<Response | undefined> {
    try {
      return await withTimeout(this.#options.upstream, this.#budgetMs(), HEAD_PHASE);
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.#fail({ kind: 'timeout', phase: HEAD_PHASE, forwarded: 0, recovered: false });
        this.#options.abortUpstream(TIMEOUT_ABORT_REASON);
      } else {
        this.#fail(upstreamError(HEAD_PHASE, 0, error));
      }
      return undefined;
    }
  }

  /**
   * Budget for the next await. Headers and the first body read share the earlier of the total and
   * first-byte deadlines; after the first body byte only the total deadline applies. An empty
   * chunk is not a first byte: an origin that keeps sending them would otherwise buy itself the
   * whole total timeout without having produced anything.
   */
  #remainingMs(): number {
    const totalRemaining = this.#startedAt + this.#options.totalTimeoutMs - this.#options.now();
    if (this.#firstByteAt !== undefined) {
      return totalRemaining;
    }
    const firstByteRemaining =
      this.#startedAt + this.#options.firstByteTimeoutMs - this.#options.now();
    return Math.min(totalRemaining, firstByteRemaining);
  }

  /** Time left for the next await, or a timeout when the deadline has already passed. */
  #budgetMs(): number {
    const remainingMs = this.#remainingMs();
    if (remainingMs <= 0) {
      throw new TimeoutError(this.#phase);
    }
    return remainingMs;
  }

  /**
   * Read every chunk; returns false when the pump already settled (mismatch, error, timeout).
   * The response is always settled before the origin body is released: `cancel()` on a stalled
   * socket may never be acknowledged, so nothing the client is waiting for may wait on it.
   */
  async #drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
    try {
      for (;;) {
        // Do not read faster than the client drains, or a slow client would buffer the whole
        // document in the isolate. Waiting for demand spends the same budget the read does, so the
        // budget is taken again afterwards: otherwise a slow client would buy the origin a second
        // full timeout and one iteration could run to twice the deadline.
        await this.#awaitDemand(this.#budgetMs());
        const { done, value } = await withTimeout(reader.read(), this.#budgetMs(), this.#phase);
        if (done) {
          return true;
        }
        // An empty chunk is no first byte, and no suffix to forward: the phase stays the head's.
        if (value.byteLength > 0) {
          this.#firstByteAt ??= this.#options.now();
          this.#forwardSuffix(value);
        }
      }
    } catch (error) {
      this.#handleReadError(error);
      releaseStream(reader, 'splice error');
      return false;
    }
  }

  /** Resolve once the consumer asks for more, or immediately while the queue has room. */
  async #awaitDemand(timeoutMs: number): Promise<void> {
    const desired = this.#controller?.desiredSize;
    if (desired === undefined || desired === null || desired > 0 || this.#cancelled) {
      return;
    }
    this.#demand ??= Promise.withResolvers<undefined>();
    await withTimeout(this.#demand.promise, timeoutMs, this.#phase);
  }

  #handleReadError(error: unknown): void {
    const phase = this.#phase;
    if (error instanceof TimeoutError) {
      // A stall leaves a truncated document, which the browser would render as a broken page, so
      // it recovers exactly like any other mid-suffix failure.
      this.#fail({ kind: 'timeout', phase, forwarded: this.#forwarded, recovered: false });
      // Releasing the reader does not tear down a stalled fetch; aborting it does.
      this.#options.abortUpstream(TIMEOUT_ABORT_REASON);
      return;
    }
    this.#fail(upstreamError(phase, this.#forwarded, error));
  }

  #emit(chunk: Uint8Array): void {
    this.#enqueueFramed(chunk);
    this.#forwarded += chunk.byteLength;
  }

  #forwardSuffix(rest: Uint8Array): void {
    this.#receivedSuffixBytes += rest.byteLength;
    this.#suffixStarted = true;
    this.#rememberTail(rest);
    this.#emit(rest);
  }

  /** Keep exactly the bytes `documentTerminates` needs at EOF, independent of how chunks arrive. */
  #rememberTail(chunk: Uint8Array): void {
    if (chunk.byteLength >= TERMINATION_WINDOW_BYTES) {
      this.#tail = chunk.slice(chunk.byteLength - TERMINATION_WINDOW_BYTES);
      return;
    }
    const joined = concatBytes([this.#tail, chunk]);
    this.#tail =
      joined.byteLength > TERMINATION_WINDOW_BYTES
        ? joined.subarray(joined.byteLength - TERMINATION_WINDOW_BYTES)
        : joined;
  }

  get outcome(): Promise<SpliceOutcome> {
    return this.#resolvers.promise;
  }

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#controller = controller;
    controller.enqueue(this.#wire.shell);
    void this.#run().catch((error: unknown) => {
      controller.error(error);
      this.#settle(upstreamError(this.#phase, this.#forwarded, error));
    });
  }

  cancel(): void {
    this.#cancelled = true;
    this.signalDemand();
    this.#options.abortUpstream('client cancelled');
    this.#settle({ kind: 'client-cancelled', forwarded: this.#forwarded });
  }

  /** Called from the stream's `pull` (and on cancel) to release a waiting read. */
  signalDemand(): void {
    this.#demand?.resolve(undefined);
    this.#demand = undefined;
  }

  get recovered(): boolean {
    return this.#recovered;
  }
}

export function createSplice(options: SpliceOptions): Splice {
  const pump = new SplicePump(options);
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      pump.start(controller);
    },
    pull() {
      pump.signalDemand();
    },
    cancel() {
      pump.cancel();
    },
  });
  return { readable, outcome: pump.outcome };
}
