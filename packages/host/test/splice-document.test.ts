import { describe, expect, it, vi } from 'vitest';

import { decodeUtf8, encodeUtf8 } from '../../core/src/util/bytes.ts';
import { crc32 } from '../../core/src/util/crc32.ts';
import { MAX_TRAILING_WHITESPACE_BYTES } from '../../core/src/util/html.ts';
import {
  buildPprDocument,
  countingOriginResponse,
  failingOriginResponse,
  fakeOriginResponse,
  neverSettles,
  splitBytes,
  stallingOriginResponse,
  unreleasableOriginResponse,
  VirtualClock,
} from '../../core/test/fixtures/partial-prerender-document.ts';
import { unsentCookieNames } from '../src/splice/cookies.ts';
import { buildRecoveryBytes } from '../src/splice/recovery.ts';
import { createSplice, type SpliceOptions } from '../src/splice/splice.ts';
import {
  brotliStoredHead,
  brotliWire,
  gzipStoredHead,
  gzipWire,
  joinedWire,
} from '../src/splice/wire.ts';

/** A page below the root: a cookie it sets naming no path is kept under `/account`. */
const PAGE_BELOW = '/account/page';

const RECOVERY = buildRecoveryBytes();
const RECOVERY_TEXT = decodeUtf8(RECOVERY);
const SETTLE_DELAY_MS = 20;
/** Real milliseconds a stalled origin is given before the splice must have closed the response. */
const STALL_TIMEOUT_MS = 30;
/**
 * A response that has not closed by then is the hang the unreleasable-origin tests exist to catch.
 * Generous next to the 30 ms stall budget so scheduling delay under a loaded CI never trips it.
 */
const HANG_TIMEOUT = { timeout: 2000 };

/** Yield long enough for an unthrottled pump to drain the origin. */
async function settleMacrotasks(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, SETTLE_DELAY_MS);
  });
}

function makeSplice(overrides: Partial<SpliceOptions> & { upstream: Promise<Response> }) {
  const aborted: string[] = [];
  const clock = new VirtualClock();
  const splice = createSplice({
    shell: buildPprDocument().shell,
    recoveryHtml: RECOVERY,
    now: clock.now,
    firstByteTimeoutMs: 200,
    totalTimeoutMs: 1000,
    abortUpstream: (reason) => {
      aborted.push(reason);
    },
    ...overrides,
  });
  return { splice, aborted };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function unreleasableWith(
  chunks: readonly Uint8Array[],
  init: { status?: number | undefined; headers?: Record<string, string> | undefined } = {},
): Promise<Response> {
  return Promise.resolve(unreleasableOriginResponse(chunks, init));
}

function originWith(
  chunks: readonly Uint8Array[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Promise<Response> {
  const clock = new VirtualClock();
  return Promise.resolve(
    fakeOriginResponse({
      clock,
      chunks: chunks.map((bytes) => ({ bytes, delayMs: 1 })),
      ...init,
    }),
  );
}

describe('createSplice', () => {
  it('emits the shell first and forwards only the suffix', async () => {
    const { suffix, shellText, suffixText } = buildPprDocument();
    const { splice } = makeSplice({
      upstream: originWith(splitBytes(suffix, 2)),
    });
    const body = await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(body).toBe(shellText + suffixText);
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && outcome.suffixBytes).toBe(suffix.byteLength);
  });

  /**
   * A runtime that resumes a prerender sends the suffix alone. There is no prefix to compare, and
   * the first byte it sends is the first byte forwarded; the build id gate and the termination
   * check are what still stand between the suffix and the client.
   */
  it('forwards a suffix-only upstream from its first byte', async () => {
    const { shell, suffix, shellText, suffixText } = buildPprDocument();
    const { splice } = makeSplice({
      upstream: originWith(splitBytes(suffix, 3)),
    });
    const body = await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(body).toBe(shellText + suffixText);
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && outcome.suffixBytes).toBe(suffix.byteLength);
    expect(shell.byteLength).toBeGreaterThan(0);
  });

  /**
   * `fetch` resolves on headers, and a continuation's headers can arrive long before its first body
   * byte. Recording header latency would make an origin that answers at once and then stalls over
   * the suffix look like the fastest there is, and every comparison between continuation policies
   * would be made against the wrong number.
   */
  it('measures the first body byte, not the response headers', async () => {
    const { shell, suffix } = buildPprDocument();
    const clock = new VirtualClock();
    // Constructing the response advances the clock past the headers, so the splice starts after
    // them: measured at the headers this would be zero, and at the first body byte it is 120.
    const origin = fakeOriginResponse({
      clock,
      headerDelayMs: 5,
      chunks: [
        { bytes: shell, delayMs: 120 },
        { bytes: suffix, delayMs: 10 },
      ],
    });
    const { splice } = makeSplice({ upstream: Promise.resolve(origin), now: clock.now });
    await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(outcome.kind === 'ok' && outcome.originFirstByteMs).toBe(120);
    expect(outcome.kind === 'ok' && outcome.totalMs).toBe(130);
  });

  /**
   * The shell's headers went out before the render began, so a `Set-Cookie` on the resume cannot
   * be forwarded: the document is recovered rather than served without it.
   */
  it('refuses a resume carrying a cookie', async () => {
    const { suffix, shellText } = buildPprDocument();
    const { splice } = makeSplice({
      upstream: originWith([suffix], {
        headers: { 'set-cookie': 'session=abc; Path=/' },
      }),
    });
    const body = await readAll(splice.readable);

    expect(body).toBe(shellText + RECOVERY_TEXT);
    await expect(splice.outcome).resolves.toStrictEqual({
      kind: 'set-cookie-observed',
      names: ['session'],
      recovered: true,
    });
  });

  /**
   * What a middleware set goes out with the shell and is handed to the render as well, and Next.js
   * writes it back onto the render's response: repeating it sets nothing the client lacks.
   */
  it('splices a resume that repeats a cookie the shell went out with', async () => {
    const { suffix, shellText, suffixText } = buildPprDocument();
    const { splice } = makeSplice({
      upstream: originWith([suffix], { headers: { 'set-cookie': 'session=abc; Path=/' } }),
      sentCookies: ['session=abc; Path=/'],
    });
    const body = await readAll(splice.readable);

    expect(body).toBe(shellText + suffixText);
    expect((await splice.outcome).kind).toBe('ok');
  });

  it('still refuses a cookie the shell did not carry, of the same name or not', async () => {
    const { suffix, shellText } = buildPprDocument();
    const { splice } = makeSplice({
      upstream: originWith([suffix], { headers: { 'set-cookie': 'session=xyz; Path=/' } }),
      sentCookies: ['session=abc; Path=/'],
    });
    const body = await readAll(splice.readable);

    expect(body).toBe(shellText + RECOVERY_TEXT);
    await expect(splice.outcome).resolves.toStrictEqual({
      kind: 'set-cookie-observed',
      names: ['session'],
      recovered: true,
    });
  });

  it('recovers when the resume sends nothing at all', async () => {
    const empty = makeSplice({ upstream: originWith([]) });

    await expect(readAll(empty.splice.readable)).resolves.toContain(RECOVERY_TEXT);
    // The shell alone is a truncated document: a shell never carries the closing tags.
    await expect(empty.splice.outcome).resolves.toStrictEqual({
      kind: 'unterminated',
      forwarded: 0,
      receivedSuffixBytes: 0,
      recovered: true,
    });
  });

  it('recovers instead of serving a suffix that ends before the closing tags', async () => {
    const { suffix, shellText } = buildPprDocument();
    const half = suffix.subarray(0, 40);
    const { splice } = makeSplice({ upstream: originWith([half]) });
    const body = await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(body).toBe(shellText + decodeUtf8(half) + RECOVERY_TEXT);
    expect(outcome).toStrictEqual({
      kind: 'unterminated',
      forwarded: 40,
      receivedSuffixBytes: half.byteLength,
      recovered: true,
    });
  });

  it('counts the suffix bytes it received when the resume stops short', async () => {
    const { shellText } = buildPprDocument();
    const partial = encodeUtf8('<script>self.__next_f');
    const { splice } = makeSplice({ upstream: originWith([partial]) });

    await expect(readAll(splice.readable)).resolves.toBe(
      shellText + decodeUtf8(partial) + RECOVERY_TEXT,
    );
    await expect(splice.outcome).resolves.toStrictEqual({
      kind: 'unterminated',
      forwarded: partial.byteLength,
      receivedSuffixBytes: partial.byteLength,
      recovered: true,
    });
  });

  it('accepts trailing whitespace after the closing tags, up to the tail window', async () => {
    const { suffix } = buildPprDocument();
    const withinTrailer = encodeUtf8('\n'.repeat(MAX_TRAILING_WHITESPACE_BYTES));
    const beyondTrailer = encodeUtf8('\n'.repeat(MAX_TRAILING_WHITESPACE_BYTES + 1));
    const within = makeSplice({ upstream: originWith([suffix, withinTrailer]) });
    const beyond = makeSplice({ upstream: originWith([suffix, beyondTrailer]) });
    await readAll(within.splice.readable);
    await readAll(beyond.splice.readable);

    expect((await within.splice.outcome).kind).toBe('ok');
    expect((await beyond.splice.outcome).kind).toBe('unterminated');
  });

  it('recovers on bad upstream responses and pre-first-byte errors', async () => {
    const bad = makeSplice({ upstream: originWith([encodeUtf8('nope')], { status: 500 }) });
    const failed = makeSplice({ upstream: Promise.reject(new Error('connect')) });
    const timedOut = makeSplice({
      upstream: neverSettles<Response>(),
      firstByteTimeoutMs: 10,
    });

    expect((await bad.splice.outcome, await readAll(bad.splice.readable))).toContain(RECOVERY_TEXT);
    expect((await bad.splice.outcome).kind).toBe('bad-upstream-response');
    await expect(readAll(failed.splice.readable)).resolves.toContain(RECOVERY_TEXT);
    expect((await failed.splice.outcome).kind).toBe('upstream-error');
    await expect(readAll(timedOut.splice.readable)).resolves.toContain(RECOVERY_TEXT);
    expect((await timedOut.splice.outcome).kind).toBe('timeout');
  });

  it('appends recovery after a mid-suffix error', async () => {
    const { suffix, shellText } = buildPprDocument();
    const half = suffix.subarray(0, 40);
    const upstream = Promise.resolve(failingOriginResponse([half], new Error('reset')));
    const { splice } = makeSplice({ upstream });
    const text = await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(text.startsWith(shellText + decodeUtf8(half))).toBe(true);
    expect(text.endsWith(RECOVERY_TEXT)).toBe(true);
    expect(outcome.kind).toBe('upstream-error');
    expect(outcome.kind === 'upstream-error' && outcome.phase).toBe('suffix');
    expect(outcome.kind === 'upstream-error' && outcome.forwarded).toBe(40);
  });

  it('recovers instead of dropping a cookie the continuation set', async () => {
    const { suffix, shellText } = buildPprDocument();
    const { splice } = makeSplice({
      upstream: originWith([suffix], { headers: { 'set-cookie': 'session=abc; Path=/' } }),
    });
    const body = await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(body).toBe(shellText + RECOVERY_TEXT);
    expect(outcome.kind).toBe('set-cookie-observed');
    expect(outcome.kind === 'set-cookie-observed' && outcome.recovered).toBe(true);
  });

  /**
   * `inline` is the header's default meaning and Next.js puts it on ordinary pages, so proof reads
   * it as no behavior at all. Reading it as behavior here would condemn, on its first request,
   * every route proof had just admitted — which on a Vercel App Router deployment is all of them.
   */
  it.each(['inline', 'INLINE', 'inline; filename="page.html"'])(
    'splices a document the origin dispositions as %s',
    async (value) => {
      const { suffix, shellText, suffixText } = buildPprDocument();
      const { splice } = makeSplice({
        upstream: originWith([suffix], { headers: { 'content-disposition': value } }),
      });

      await expect(readAll(splice.readable)).resolves.toBe(shellText + suffixText);
      await expect(splice.outcome).resolves.toMatchObject({ kind: 'ok' });
    },
  );

  it.each([
    ['content-disposition', 'attachment; filename="page.html"'],
    ['refresh', '1; url=/next'],
    ['clear-site-data', '"cache"'],
  ])('recovers to preserve the browser behavior of %s', async (header, value) => {
    const { suffix, shellText } = buildPprDocument();
    const { splice } = makeSplice({
      upstream: originWith([suffix], { headers: { [header]: value } }),
    });

    await expect(readAll(splice.readable)).resolves.toBe(shellText + RECOVERY_TEXT);
    await expect(splice.outcome).resolves.toStrictEqual({
      kind: 'behavioral-header-observed',
      header,
      recovered: true,
    });
  });

  it.each([
    {
      header: 'content-disposition',
      value: 'attachment; filename="data.bin"',
      status: 200,
      contentType: 'application/octet-stream',
      body: 'data',
    },
    { header: 'refresh', value: '1; url=/next', status: 200, contentType: 'text/html', body: null },
    {
      header: 'clear-site-data',
      value: '"cache"',
      status: 302,
      contentType: 'text/html',
      body: null,
    },
    {
      header: 'clear-site-data',
      value: '"cache"',
      status: 204,
      contentType: 'text/html',
      body: null,
    },
  ] as const)(
    'reports $header before rejecting status $status or a missing HTML body',
    async ({ header, value, status, contentType, body }) => {
      const { shellText } = buildPprDocument();
      const { splice } = makeSplice({
        upstream: Promise.resolve(
          new Response(body, { status, headers: { 'content-type': contentType, [header]: value } }),
        ),
      });

      await expect(readAll(splice.readable)).resolves.toBe(shellText + RECOVERY_TEXT);
      await expect(splice.outcome).resolves.toStrictEqual({
        kind: 'behavioral-header-observed',
        header,
        recovered: true,
      });
    },
  );

  it.each([301, 302, 303, 307, 308])(
    'reports a %i redirect with Location before requiring an HTML body',
    async (status) => {
      const { shellText } = buildPprDocument();
      const { splice } = makeSplice({
        upstream: Promise.resolve(new Response(null, { status, headers: { location: '/next' } })),
      });

      await expect(readAll(splice.readable)).resolves.toBe(shellText + RECOVERY_TEXT);
      await expect(splice.outcome).resolves.toStrictEqual({
        kind: 'behavioral-header-observed',
        header: 'location',
        recovered: true,
      });
    },
  );

  it('keeps a successful HTML response eligible when it carries Location', async () => {
    const { suffix, shellText, suffixText } = buildPprDocument();
    const { splice } = makeSplice({
      upstream: originWith([suffix], { headers: { location: '/next' } }),
    });

    await expect(readAll(splice.readable)).resolves.toBe(shellText + suffixText);
    await expect(splice.outcome).resolves.toMatchObject({ kind: 'ok' });
  });

  it.each([
    [201, { location: '/created' }],
    [304, { location: '/next' }],
    [302, {}],
  ])(
    'keeps status %i without a browser redirect as an upstream failure',
    async (status, headers) => {
      const { splice } = makeSplice({
        upstream: Promise.resolve(new Response(null, { status, headers })),
      });

      await readAll(splice.readable);

      await expect(splice.outcome).resolves.toStrictEqual({
        kind: 'bad-upstream-response',
        status,
        // A bodyless answer has no opening to keep; one with a body says what it said.
        body: undefined,
        // And the names it came with, sorted — which is what says who answered when the body is
        // a phrase more than one layer uses.
        headers: Object.keys(headers)
          .toSorted((one, other) => one.localeCompare(other))
          .join(','),
        recovered: true,
      });
    },
  );

  it.each([
    [200, 'application/json', '{}'],
    [302, 'text/html', null],
    [200, 'text/html', null],
  ] as const)(
    'reports cookies before rejecting status %i with %s or a missing body',
    async (status, contentType, body) => {
      const { shellText } = buildPprDocument();
      const { splice } = makeSplice({
        upstream: Promise.resolve(
          new Response(body, {
            status,
            headers: {
              'content-type': contentType,
              'set-cookie': 'session=abc; Path=/',
              refresh: '1; url=/next',
            },
          }),
        ),
      });

      await expect(readAll(splice.readable)).resolves.toBe(shellText + RECOVERY_TEXT);
      await expect(splice.outcome).resolves.toStrictEqual({
        kind: 'set-cookie-observed',
        names: ['session'],
        recovered: true,
      });
    },
  );

  it('releases a download body without awaiting cancellation', HANG_TIMEOUT, async () => {
    const { shellText } = buildPprDocument();
    const cancel = vi.fn(() => neverSettles<never>());
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const { splice } = makeSplice({
      upstream: Promise.resolve(
        new Response(body, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="data.bin"',
          },
        }),
      ),
    });

    await expect(readAll(splice.readable)).resolves.toBe(shellText + RECOVERY_TEXT);
    await expect(splice.outcome).resolves.toMatchObject({ kind: 'behavioral-header-observed' });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('behavioral header observed');
  });

  /**
   * A refused answer's opening is read for whoever reads why it was refused. One that sent its
   * headers and then nothing held the committed shell, with no recovery sent, for as long as it
   * stayed silent (Codex): the read is held to what is left of the budget.
   */
  it(
    'gives up on the opening of a refused answer that says nothing more, within the budget',
    HANG_TIMEOUT,
    async () => {
      const { shellText } = buildPprDocument();
      const { splice, aborted } = makeSplice({
        upstream: unreleasableWith([], {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
        firstByteTimeoutMs: STALL_TIMEOUT_MS,
        totalTimeoutMs: STALL_TIMEOUT_MS,
      });

      await expect(readAll(splice.readable)).resolves.toBe(shellText + RECOVERY_TEXT);
      await expect(splice.outcome).resolves.toStrictEqual({
        kind: 'bad-upstream-response',
        status: 500,
        body: undefined,
        headers: 'content-type',
        recovered: true,
      });
      expect(aborted).toStrictEqual(['continuation timeout']);
    },
  );

  it('applies the first-byte budget to the body, not only to the headers', async () => {
    const { shell } = buildPprDocument();
    const stalled = stallingOriginResponse([]);
    const { splice } = makeSplice({
      upstream: Promise.resolve(stalled),
      firstByteTimeoutMs: 20,
      totalTimeoutMs: 60_000,
    });
    const body = await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(body).toBe(decodeUtf8(shell) + RECOVERY_TEXT);
    expect(outcome.kind).toBe('timeout');
    expect(outcome.kind === 'timeout' && outcome.phase).toBe('head');
  });

  it.each([
    { firstByteTimeoutMs: 1000, totalTimeoutMs: 100 },
    { firstByteTimeoutMs: 100, totalTimeoutMs: 1000 },
  ])('bounds the header wait by the earlier deadline (%j)', async (budgets) => {
    vi.useFakeTimers();
    try {
      const { shellText } = buildPprDocument();
      const { splice, aborted } = makeSplice({
        upstream: neverSettles<Response>(),
        now: () => Date.now(),
        ...budgets,
      });
      const body = readAll(splice.readable);
      await vi.advanceTimersByTimeAsync(99);

      expect(aborted).toStrictEqual([]);

      await vi.advanceTimersByTimeAsync(1);

      await expect(body).resolves.toBe(shellText + RECOVERY_TEXT);
      await expect(splice.outcome).resolves.toStrictEqual({
        kind: 'timeout',
        phase: 'head',
        forwarded: 0,
        recovered: true,
      });
      expect(aborted).toStrictEqual(['continuation timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deducts the header wait from the remaining total body budget', async () => {
    vi.useFakeTimers();
    try {
      const upstream = Promise.withResolvers<Response>();
      const { shellText } = buildPprDocument();
      const { splice, aborted } = makeSplice({
        upstream: upstream.promise,
        now: () => Date.now(),
        firstByteTimeoutMs: 1000,
        totalTimeoutMs: 100,
      });
      const body = readAll(splice.readable);
      await vi.advanceTimersByTimeAsync(60);
      upstream.resolve(stallingOriginResponse([]));
      await vi.advanceTimersByTimeAsync(39);

      expect(aborted).toStrictEqual([]);

      await vi.advanceTimersByTimeAsync(1);

      await expect(body).resolves.toBe(shellText + RECOVERY_TEXT);
      await expect(splice.outcome).resolves.toStrictEqual({
        kind: 'timeout',
        phase: 'head',
        forwarded: 0,
        recovered: true,
      });
      expect(aborted).toStrictEqual(['continuation timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  /** An empty chunk is not the suffix beginning: a stall after one is still the head's. */
  it('keeps the head phase through an empty chunk', async () => {
    const { shellText } = buildPprDocument();
    const empty = stallingOriginResponse([new Uint8Array()]);
    const { splice } = makeSplice({
      upstream: Promise.resolve(empty),
      firstByteTimeoutMs: 20,
      totalTimeoutMs: 60_000,
    });

    await expect(readAll(splice.readable)).resolves.toBe(shellText + RECOVERY_TEXT);
    await expect(splice.outcome).resolves.toStrictEqual({
      kind: 'timeout',
      phase: 'head',
      forwarded: 0,
      recovered: true,
    });
  });

  it('recovers when the origin stalls after forwarding suffix bytes', async () => {
    const { suffix, shellText } = buildPprDocument();
    const half = suffix.subarray(0, 40);
    const { splice } = makeSplice({
      upstream: Promise.resolve(stallingOriginResponse([half])),
      firstByteTimeoutMs: 20,
      totalTimeoutMs: 60,
    });
    const text = await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(text).toBe(shellText + decodeUtf8(half) + RECOVERY_TEXT);
    expect(outcome.kind).toBe('timeout');
    expect(outcome.kind === 'timeout' && outcome.phase).toBe('suffix');
    expect(outcome.kind === 'timeout' && outcome.recovered).toBe(true);
  });

  it('does not read further than the consumer drains', async () => {
    const { suffix } = buildPprDocument();
    const parts = splitBytes(suffix, 8);
    const origin = countingOriginResponse(parts);
    const { splice } = makeSplice({ upstream: Promise.resolve(origin.response) });
    const reader = splice.readable.getReader();
    await reader.read();
    // Give the pump every chance to run ahead; with backpressure it stays parked on the queue.
    await settleMacrotasks();
    const pulledBeforeDraining = origin.pulled();
    await reader.cancel();

    expect(pulledBeforeDraining).toBeLessThan(parts.length);
  });

  it(
    'closes the response when a stalled origin never acknowledges the cancel',
    HANG_TIMEOUT,
    async () => {
      const { shellText } = buildPprDocument();
      const { splice, aborted } = makeSplice({
        upstream: unreleasableWith([]),
        totalTimeoutMs: STALL_TIMEOUT_MS,
      });
      const body = await readAll(splice.readable);
      const outcome = await splice.outcome;

      expect(body).toBe(shellText + RECOVERY_TEXT);
      expect(outcome.kind).toBe('timeout');
      expect(outcome.kind === 'timeout' && outcome.phase).toBe('head');
      expect(outcome.kind === 'timeout' && outcome.recovered).toBe(true);
      expect(aborted).toStrictEqual(['continuation timeout']);
    },
  );

  it('closes the response when the origin stalls mid-suffix', HANG_TIMEOUT, async () => {
    const { suffix, shellText } = buildPprDocument();
    const half = suffix.subarray(0, 40);
    const { splice, aborted } = makeSplice({
      upstream: unreleasableWith([half]),
      totalTimeoutMs: STALL_TIMEOUT_MS,
    });
    const body = await readAll(splice.readable);
    const outcome = await splice.outcome;

    expect(body).toBe(shellText + decodeUtf8(half) + RECOVERY_TEXT);
    expect(outcome.kind).toBe('timeout');
    expect(outcome.kind === 'timeout' && outcome.phase).toBe('suffix');
    expect(outcome.kind === 'timeout' && outcome.forwarded).toBe(40);
    expect(aborted).toStrictEqual(['continuation timeout']);
  });

  it(
    'recovers from a bad upstream response whose body never acknowledges the cancel',
    HANG_TIMEOUT,
    async () => {
      const { shellText } = buildPprDocument();
      const { splice } = makeSplice({
        upstream: unreleasableWith([encodeUtf8('nope')], { status: 500 }),
      });
      const body = await readAll(splice.readable);
      const outcome = await splice.outcome;

      expect(body).toBe(shellText + RECOVERY_TEXT);
      expect(outcome.kind).toBe('bad-upstream-response');
    },
  );

  it(
    'recovers from a cookie-setting continuation whose body never acknowledges the cancel',
    HANG_TIMEOUT,
    async () => {
      const { suffix, shellText } = buildPprDocument();
      const { splice } = makeSplice({
        upstream: unreleasableWith([suffix], { headers: { 'set-cookie': 'a=b' } }),
      });
      const body = await readAll(splice.readable);
      const outcome = await splice.outcome;

      expect(body).toBe(shellText + RECOVERY_TEXT);
      expect(outcome.kind).toBe('set-cookie-observed');
    },
  );

  it(
    'recovers from a refused resume whose body never acknowledges the cancel',
    HANG_TIMEOUT,
    async () => {
      const { suffix, shellText } = buildPprDocument();
      const { splice } = makeSplice({
        upstream: unreleasableWith([suffix], { headers: { 'set-cookie': 'session=abc' } }),
      });
      const body = await readAll(splice.readable);
      const outcome = await splice.outcome;

      expect(body).toBe(shellText + RECOVERY_TEXT);
      expect(outcome.kind).toBe('set-cookie-observed');
    },
  );

  it('does not hand the origin a second full budget after waiting for demand', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const { splice } = makeSplice({
        upstream: Promise.resolve(stallingOriginResponse([])),
        now: () => Date.now(),
        firstByteTimeoutMs: 1000,
        totalTimeoutMs: 1000,
      });
      let settledAt = -1;
      const settled = (async (): Promise<string> => {
        const outcome = await splice.outcome;
        settledAt = Date.now();
        return outcome.kind;
      })();
      const reader = splice.readable.getReader();
      // Nothing is read, so the pump parks on the shell it enqueued and burns most of the budget
      // waiting for demand. The read that follows must inherit what is left, not a fresh budget.
      await vi.advanceTimersByTimeAsync(900);
      await reader.read();
      await vi.advanceTimersByTimeAsync(1500);

      await expect(settled).resolves.toBe('timeout');
      expect(settledAt - startedAt).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A client that has gone takes nothing more. The splice lets go of the origin where it sees the
   * cancel, rather than drain a continuation that the abort reaches late or not at all — as here,
   * where aborting the upstream stops nothing.
   */
  it('lets go of the origin once the client cancels', async () => {
    const { suffix } = buildPprDocument();
    const parts = splitBytes(suffix, 8);
    const origin = countingOriginResponse(parts);
    const { splice } = makeSplice({ upstream: Promise.resolve(origin.response) });
    const reader = splice.readable.getReader();
    await reader.read();
    await settleMacrotasks();
    await reader.cancel();
    await settleMacrotasks();

    expect(origin.pulled()).toBeLessThan(parts.length);
    expect(origin.cancelled()).toBe('client cancelled');
  });

  /**
   * Nor does a read out on the origin hold it once the client has gone: an origin that stalls is let
   * go of as the client leaves, not when it answers or the budget runs out, since the abort may be
   * acknowledged late or not at all — as here, where it stops nothing.
   */
  it('lets go of an origin whose read is out as the client cancels', async () => {
    const { suffix } = buildPprDocument();
    const origin = countingOriginResponse(splitBytes(suffix, 8).slice(0, 1), { thenStall: true });
    const { splice } = makeSplice({ upstream: Promise.resolve(origin.response) });
    const reader = splice.readable.getReader();
    await reader.read();
    await reader.read();
    await settleMacrotasks();

    expect(origin.cancelled()).toBeUndefined();

    await reader.cancel();
    await settleMacrotasks();

    expect(origin.cancelled()).toBe('client cancelled');
    await expect(splice.outcome).resolves.toMatchObject({ kind: 'client-cancelled' });
  });

  /**
   * Nor does the read of a refused answer's opening: one that sent its headers and then nothing is
   * let go of as the client leaves, not when it says more or the budget runs out.
   */
  it('lets go of a refused answer whose opening is being read as the client cancels', async () => {
    const origin = countingOriginResponse([], { thenStall: true, status: 500 });
    const { splice } = makeSplice({ upstream: Promise.resolve(origin.response) });
    const reader = splice.readable.getReader();
    await reader.read();
    await settleMacrotasks();

    expect(origin.cancelled()).toBeUndefined();

    await reader.cancel();
    await settleMacrotasks();

    expect(origin.cancelled()).toBe('client cancelled');
    await expect(splice.outcome).resolves.toMatchObject({ kind: 'client-cancelled' });
  });

  /** And one that comes once the client has gone is let go of then, its opening unread. */
  it('lets go of a refused answer that comes once the client has gone', async () => {
    const upstream = Promise.withResolvers<Response>();
    const origin = countingOriginResponse([], { thenStall: true, status: 500 });
    const { splice } = makeSplice({ upstream: upstream.promise });
    const reader = splice.readable.getReader();
    await reader.read();
    await reader.cancel();
    upstream.resolve(origin.response);
    await settleMacrotasks();

    expect(origin.cancelled()).toBe('client cancelled');
    await expect(splice.outcome).resolves.toMatchObject({ kind: 'client-cancelled' });
  });

  it('aborts the upstream when the client cancels', async () => {
    const { suffix } = buildPprDocument();
    const { splice, aborted } = makeSplice({ upstream: originWith([suffix]) });
    const reader = splice.readable.getReader();
    await reader.read();
    await reader.cancel();
    const outcome = await splice.outcome;

    expect(outcome.kind).toBe('client-cancelled');
    expect(aborted).toStrictEqual(['client cancelled']);
  });
});

/**
 * Whatever the wire encoding, the client must end up with a stream that decodes to exactly what
 * identity would have carried — the shell, then either the suffix or the recovery script — and
 * that is properly closed on every path, since a browser treats an unterminated stream as an error.
 */
type WireFormat = 'brotli' | 'gzip';

/** Node's web streams decode brotli; its lib typings predate the format, hence the cast. */
async function decode(format: WireFormat, stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new DecompressionStream(format as CompressionFormat);
  return new Response(new Response(stream).body?.pipeThrough(decoder)).text();
}

function wireFor(format: WireFormat, shell: Uint8Array) {
  return format === 'brotli'
    ? brotliWire(brotliStoredHead(shell))
    : gzipWire(gzipStoredHead(shell), { crc32: crc32(shell), byteLength: shell.byteLength });
}

describe('createSplice on a compressed wire', () => {
  it.each(['brotli', 'gzip'] as const)(
    'delivers shell and suffix as one %s stream',
    async (format) => {
      const { shell, suffix, shellText, suffixText } = buildPprDocument();
      const { splice } = makeSplice({
        shell,
        wire: wireFor(format, shell),
        upstream: originWith(splitBytes(suffix, 2)),
      });

      await expect(decode(format, splice.readable)).resolves.toBe(shellText + suffixText);
      expect((await splice.outcome).kind).toBe('ok');
    },
  );

  it.each(['brotli', 'gzip'] as const)(
    'frames the recovery script and closes the %s stream',
    async (format) => {
      const { shell, suffix, shellText } = buildPprDocument();
      const { splice } = makeSplice({
        shell,
        wire: wireFor(format, shell),
        upstream: originWith([suffix], { headers: { 'set-cookie': 'session=abc' } }),
      });

      await expect(decode(format, splice.readable)).resolves.toBe(shellText + RECOVERY_TEXT);
      expect((await splice.outcome).kind).toBe('set-cookie-observed');
    },
  );

  it.each(['brotli', 'gzip'] as const)(
    'closes the %s stream after a mid-suffix stall',
    async (format) => {
      const { shell, suffix, shellText } = buildPprDocument();
      const half = suffix.subarray(0, 40);
      const { splice } = makeSplice({
        shell,
        wire: wireFor(format, shell),
        upstream: Promise.resolve(stallingOriginResponse([half])),
        firstByteTimeoutMs: 20,
        totalTimeoutMs: 60,
      });

      await expect(decode(format, splice.readable)).resolves.toBe(
        shellText + decodeUtf8(half) + RECOVERY_TEXT,
      );
      expect((await splice.outcome).kind).toBe('timeout');
    },
  );

  /**
   * The edge's second brotli layer flushes once per array it is handed, so a wire that joins its
   * frames must reach it as the head, one array per origin chunk, and the closing bytes.
   */
  it('hands over one array per origin chunk when the wire joins its frames', async () => {
    const { shell, suffix, shellText, suffixText } = buildPprDocument();
    const head = brotliStoredHead(shell);
    const chunks = splitBytes(suffix, 3);
    const { splice } = makeSplice({
      shell,
      wire: joinedWire(brotliWire(head)),
      upstream: originWith(chunks),
    });
    const reader = splice.readable.getReader();
    const parts: Uint8Array[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      parts.push(read.value);
    }
    const sent = new Blob(parts as BlobPart[]).stream();

    expect(parts).toHaveLength(chunks.length + 2);
    expect(parts[0]).toBe(head);
    await expect(decode('brotli', sent)).resolves.toBe(shellText + suffixText);
  });

  it('puts the encoded head on the wire before the origin has answered', async () => {
    const { shell } = buildPprDocument();
    const head = brotliStoredHead(shell);
    const { splice } = makeSplice({
      shell,
      wire: brotliWire(head),
      upstream: neverSettles<Response>(),
    });
    const reader = splice.readable.getReader();
    const first = await reader.read();
    await reader.cancel();

    expect(first.value).toBe(head);
  });
});

/**
 * A cookie is the one the shell carried when a browser would store the same thing, however the two
 * were written: Next.js parses what the middleware set and writes it again for the render.
 */
describe('unsentCookieNames', () => {
  const MIDDLEWARE_SET =
    'seen=1; Path=/; Expires=Sat, 26 Sep 2026 08:00:00 GMT; Max-Age=60; HttpOnly';

  it('compares nothing while the resume sets no cookie', () => {
    expect(unsentCookieNames([], [MIDDLEWARE_SET])).toStrictEqual([]);
  });

  it('reads a cookie written again, a second later, in another order and case, as the same', () => {
    const again = 'seen=1; httponly; max-age=60; path=/; expires=Sat, 26 Sep 2026 08:00:01 GMT';

    expect(unsentCookieNames([again], [MIDDLEWARE_SET])).toStrictEqual([]);
  });

  /** Without a `Max-Age`, `Expires` is when the cookie goes, and a later one is another cookie. */
  it('reads a different expiry as another cookie where no Max-Age stands for it', () => {
    const sent = 'seen=1; Path=/; Expires=Sat, 26 Sep 2026 08:00:00 GMT';
    const later = 'seen=1; Path=/; Expires=Sat, 26 Sep 2026 09:00:00 GMT';

    expect(unsentCookieNames([later], [sent])).toStrictEqual(['seen']);
  });

  it('reads another value, path or flag as another cookie, a path in its own case', () => {
    const set = [
      'seen=2; Path=/; Max-Age=60; HttpOnly',
      'seen=1; Path=/Admin; Max-Age=60; HttpOnly',
      'seen=1; Path=/; Max-Age=60',
    ];
    const sent = [
      'seen=1; Path=/; Max-Age=60; HttpOnly',
      'seen=1; Path=/admin; Max-Age=60; HttpOnly',
    ];

    expect(unsentCookieNames(set, sent)).toStrictEqual(['seen', 'seen', 'seen']);
  });

  it('names only the cookies the shell did not carry', () => {
    const set = ['seen=1; Path=/', 'theme=dark; Path=/'];

    expect(unsentCookieNames(set, ['seen=1; Path=/'])).toStrictEqual(['theme']);
    expect(unsentCookieNames(set)).toStrictEqual(['seen', 'theme']);
  });

  it('reads another name case, domain, flag, SameSite or a deletion as another cookie', () => {
    const sent = ['session=abc; Path=/'];
    const set = [
      'Session=abc; Path=/',
      'session=abc; Path=/; Domain=example.com',
      'session=abc; Path=/; Secure',
      'session=abc; Path=/; SameSite=Strict',
      'session=abc; Path=/; Partitioned',
      'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ];

    expect(unsentCookieNames(set, sent)).toStrictEqual([
      'Session',
      'session',
      'session',
      'session',
      'session',
      'session',
    ]);
  });

  /** RFC 6265, section 5.3: the last of an attribute is the one kept, and a bad `Max-Age` none. */
  it('keeps the last of an attribute written twice, and no Max-Age a browser would ignore', () => {
    const paths = unsentCookieNames(['a=1; Path=/x; Path=/y'], ['a=1; Path=/y; Path=/x']);
    const expiries = unsentCookieNames(
      ['a=1; Max-Age=abc; Expires=Fri, 01 Jan 2027 00:00:00 GMT'],
      ['a=1; Max-Age=abc; Expires=Sat, 01 Jan 2028 00:00:00 GMT'],
    );

    expect(paths).toStrictEqual(['a']);
    expect(expiries).toStrictEqual(['a']);
  });

  /**
   * RFC 6265, section 5.2: a browser ignores an attribute it does not know, and keeps a flag as
   * there whatever value it carries. A cookie written with either is the one written without.
   */
  it('reads an attribute no browser keeps, or a value on a flag, as no part of the cookie', () => {
    const sent = ['a=b; Path=/; Foo=1', 'c=d; Path=/; Secure=yes; HttpOnly=1; Partitioned=on'];
    const set = ['a=b; Path=/', 'c=d; Path=/; Secure; HttpOnly; Partitioned'];

    expect(unsentCookieNames(set, sent)).toStrictEqual([]);
    // One that some browser keeps still tells two apart.
    expect(unsentCookieNames(['a=b; Path=/; Priority=High'], sent)).toStrictEqual(['a']);
  });

  /**
   * RFC 6265, section 5.2: a browser parts a name from its value at the first `=`, and takes the
   * spaces and tabs off either end of each, and of an attribute's name and value.
   */
  it('reads the spaces and tabs about a name, a value or an attribute as no part of the cookie', () => {
    const sent = ['a = b; Path=/', 'c\t=\td=e\t;\tPath\t=\t/x\t'];
    const set = ['a=b; Path=/', 'c=d=e; Path=/x'];

    expect(unsentCookieNames(set, sent)).toStrictEqual([]);
  });

  /** Nothing but spaces and tabs: a no-break space is kept, in a name, a value or a path. */
  it('reads any other space about a name, a value or a path as part of the cookie', () => {
    const sent = [
      '\u{A0}a=b; Path=/',
      'a\u{A0}=b; Path=/',
      'a=\u{A0}b; Path=/',
      'a=b; Path=/\u{A0}',
    ];

    expect(sent.map((each) => unsentCookieNames(['a=b; Path=/'], [each]))).toStrictEqual(
      sent.map(() => ['a']),
    );
  });

  /**
   * Next.js reads what the middleware set with its own parser before writing it back: it decodes
   * the value twice, keeps only what is truthy, and sets `Path=/` where there was none. It writes
   * back what it was handed, which `NextResponse` wrote as it wrote the shell's.
   */
  it('reads the shell’s cookie as Next.js writes it back as the same', () => {
    const cases = [
      { sent: 'token=; Path=/; Max-Age=0', echo: 'token=; Path=/' },
      { sent: 'next=%252Faccount; Path=/', echo: 'next=%2Faccount; Path=/' },
      { sent: 'f=1; Path=/; SameSite=true', echo: 'f=1; Path=/' },
      { sent: 'raw=1', echo: 'raw=1; Path=/' },
      {
        sent: 'e=1; Path=/; Expires=Fri, 01-Jan-2027 00:00:00 GMT',
        echo: 'e=1; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT',
      },
    ];

    expect(cases.map(({ sent, echo }) => unsentCookieNames([echo], [sent], sent))).toStrictEqual(
      cases.map(() => []),
    );
  });

  it('still names a cookie the shell carried in another form than Next.js would write it back', () => {
    const sent = 'token=; Path=/; Max-Age=0';

    expect(unsentCookieNames(['token=1; Path=/'], [sent], sent)).toStrictEqual(['token']);
  });

  /**
   * Next.js decodes a path a cookie names, and writes its copy back there: `/a%2Fb` as `/a/b`. The
   * client keeps the original under the path as it was written, so the copy is another cookie,
   * which a whole render would send beside it and the client never got.
   */
  it('reads a copy written back to the decoded path of a named one as another cookie', () => {
    const slashed = 'a=b; Path=/a%2Fb';
    const spaced = 'p=1; Path=/a%20b';

    expect(unsentCookieNames(['a=b; Path=/a/b'], [slashed], slashed)).toStrictEqual(['a']);
    expect(unsentCookieNames(['p=1; Path=/a b'], [spaced], spaced)).toStrictEqual(['p']);
    expect(unsentCookieNames([slashed], [slashed], slashed)).toStrictEqual([]);
  });

  /**
   * A `Set-Cookie` the middleware appended on its own response after `cookies.set` goes out with
   * the shell and is never handed to the render: a resume that sets it as Next.js would write it
   * back sets a cookie of its own — here with `Path=/`, where the client's is kept under the
   * directory of the page that set it.
   */
  it('reads no cookie as written back from one the render was not handed', () => {
    const sent = ['session=abc; Path=/', 'raw=1'];
    const set = ['raw=1; Path=/'];

    expect(unsentCookieNames(set, sent, 'session=abc; Path=/', PAGE_BELOW)).toStrictEqual(['raw']);
    expect(unsentCookieNames(set, sent, '', PAGE_BELOW)).toStrictEqual(['raw']);
  });

  /**
   * One the render was handed is written back with `Path=/` where it named none, and a browser
   * keeps it under the directory of the path asked for (RFC 6265, section 5.1.4): below the root
   * the copy is another cookie, which a whole render would send beside it and the client lacks. At
   * the root it is the same one.
   */
  it('reads a cookie written back to the root as the one sent only where that one is kept', () => {
    const sent = ['session=abc; Path=/', 'raw=1'];
    const set = ['raw=1; Path=/'];
    const handed = 'session=abc; Path=/,raw=1';

    expect(unsentCookieNames(set, sent, handed, PAGE_BELOW)).toStrictEqual(['raw']);
    expect(unsentCookieNames(set, sent, handed, '/account')).toStrictEqual([]);
    expect(unsentCookieNames(set, sent, handed)).toStrictEqual([]);
    expect(unsentCookieNames(['raw=1'], sent, handed, PAGE_BELOW)).toStrictEqual([]);
    // A path that does not begin with `/` has the root for its default.
    expect(unsentCookieNames(set, sent, handed, 'account/page')).toStrictEqual([]);
  });

  /**
   * The path a cookie naming none is stored under is the client's own, as it asked for it: Next.js
   * decodes a path it reads, but none is read here. A cookie the render sets at the decoded path is
   * another, which the client was never sent.
   */
  it('takes the default path of a cookie naming none as the client asked for it, not decoded', () => {
    const page = '/a%2Fb/page';

    expect(unsentCookieNames(['a=b; Path=/a/b'], ['a=b'], 'a=b', page)).toStrictEqual(['a']);
    expect(unsentCookieNames(['a=b'], ['a=b'], 'a=b', page)).toStrictEqual([]);
    expect(unsentCookieNames(['a=b; Path=/a%2Fb'], ['a=b'], 'a=b', page)).toStrictEqual([]);
  });

  /** Next.js splits `x-middleware-set-cookie` where a name follows a comma, and nowhere else. */
  it('reads what the render was handed as Next.js splits it, past a comma in a date', () => {
    const expiring = 'next=%252Faccount; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT';
    const cleared = 'token=; Path=/; Max-Age=0';
    const set = [
      'next=%2Faccount; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT',
      'token=; Path=/',
    ];

    expect(unsentCookieNames(set, [expiring, cleared], `${expiring},${cleared}`)).toStrictEqual([]);
    expect(unsentCookieNames(set, [expiring, cleared], `${cleared}, ${expiring}`)).toStrictEqual(
      [],
    );
    expect(unsentCookieNames(set, [expiring, cleared], expiring.split(',', 1)[0])).toStrictEqual([
      'next',
      'token',
    ]);
  });

  it('names a cookie without a name too, so that it ends the splice as any other', () => {
    expect(unsentCookieNames(['=secret; Path=/'])).toStrictEqual(['(nameless)']);
  });
});
