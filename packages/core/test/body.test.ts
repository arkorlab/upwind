import { describe, expect, it } from 'vitest';

import { type BoundedBody, readBodyPrefix, readBoundedBody } from '../src/util/body.ts';
import { encodeUtf8 } from '../src/util/bytes.ts';

const READ_TIMEOUT_MS = 500;
/** Long enough to outlast a stall budget that only counted total time. */
const SLOW_CHUNK_MS = 30;
/** Long enough that the whole-read budget is never what a test is measuring. */
const READ_BUDGET_MS = 30_000;
/** The body an over-limit read hands back, read to its end; nothing at all for a complete one. */
async function restOf(bounded: BoundedBody): Promise<Uint8Array> {
  const body = bounded.kind === 'over-limit' ? bounded.body : null;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Let go of whatever an over-limit read handed back, as a caller that will not deliver it does. */
async function releaseRest(bounded: BoundedBody): Promise<void> {
  const body = bounded.kind === 'over-limit' ? bounded.body : undefined;
  await body?.cancel('test over');
}

/** A read that has not given up by then is hung on the cancel; generous so CI load cannot trip it. */
const HANG_TIMEOUT = { timeout: 2000 };

interface TrackedStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly produced: () => number;
  readonly cancelled: () => boolean;
}

/** A body that keeps producing `chunk` until the consumer stops asking for more. */
function endlessStream(chunk: Uint8Array): TrackedStream {
  let produced = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        produced += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, produced: () => produced, cancelled: () => cancelled };
}

function chunkedStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = queue.shift();
        if (next === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(next);
      },
    },
    { highWaterMark: 0 },
  );
}

function neverSettles(): Promise<undefined> {
  return new Promise<undefined>(() => {
    // Never settles: this is the origin that answers and then goes quiet.
  });
}

/**
 * A body that delivers its headers and first chunk, then never yields again. With `unreleasable`
 * the socket does not acknowledge the cancel either, so anything awaiting the release hangs.
 */
function stallingStream(first: Uint8Array, unreleasable = false): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<undefined> | undefined {
        if (sent) {
          return neverSettles();
        }
        sent = true;
        controller.enqueue(first);
        return undefined;
      },
      ...(unreleasable && { cancel: neverSettles }),
    },
    { highWaterMark: 0 },
  );
}

describe('readBodyPrefix', () => {
  it('stops at the limit and cancels the rest', async () => {
    const stream = endlessStream(new Uint8Array(64));

    const prefix = await readBodyPrefix(stream.body, { limit: 200, timeoutMs: READ_TIMEOUT_MS });

    expect(prefix.byteLength).toBe(200);
    // Four pulls of 64 bytes reach the limit; an unbounded read would never stop.
    expect(stream.produced()).toBe(4);
    expect(stream.cancelled()).toBe(true);
  });

  it('returns the same bytes however the origin chunked them', async () => {
    const document = encodeUtf8('<!DOCTYPE html><html><body>hello</body></html>');
    const whole = await readBodyPrefix(chunkedStream([document]), {
      limit: 32,
      timeoutMs: READ_TIMEOUT_MS,
    });
    const split = await readBodyPrefix(
      chunkedStream([document.subarray(0, 7), document.subarray(7, 30), document.subarray(30)]),
      { limit: 32, timeoutMs: READ_TIMEOUT_MS },
    );

    expect(split).toStrictEqual(whole);
    expect(whole.byteLength).toBe(32);
  });

  it('returns a body shorter than the limit in full', async () => {
    const document = encodeUtf8('short');

    const prefix = await readBodyPrefix(chunkedStream([document]), {
      limit: 4096,
      timeoutMs: READ_TIMEOUT_MS,
    });

    expect(prefix).toStrictEqual(document);
  });

  it('gives up on a body that stops arriving', async () => {
    const stream = stallingStream(encodeUtf8('<!DOCTYPE html>'));

    await expect(readBodyPrefix(stream, { limit: 4096, timeoutMs: 20 })).rejects.toThrow(
      'timed out',
    );
  });

  it(
    'gives up on time even when the socket never acknowledges the cancel',
    HANG_TIMEOUT,
    async () => {
      const stream = stallingStream(encodeUtf8('<!DOCTYPE html>'), true);

      // The deadline is only worth anything if releasing the body cannot hold it up.
      await expect(readBodyPrefix(stream, { limit: 4096, timeoutMs: 20 })).rejects.toThrow(
        'timed out',
      );
    },
  );
});

describe('readBoundedBody', () => {
  const asset = encodeUtf8('console.log(1);export const x = 2;');

  it('reads a body to its end, whatever the origin chunked it into', async () => {
    const split = [asset.subarray(0, 4), asset.subarray(4, 30), asset.subarray(30)];

    const bounded = await readBoundedBody(chunkedStream(split), {
      limit: 4096,
      stallMs: READ_TIMEOUT_MS,
      budgetMs: READ_BUDGET_MS,
    });

    expect(bounded).toStrictEqual({ kind: 'complete', bytes: asset });
  });

  /**
   * The budget is a bound on what the edge will hold, so a body that fits it exactly fits. Stopping
   * at the limit rather than past it would refuse the largest asset the policy allows, and no read
   * of the body could tell you which of the two happened.
   */
  it('treats a body of exactly the limit as complete, and one byte more as over', async () => {
    const exact = await readBoundedBody(chunkedStream([asset]), {
      limit: asset.byteLength,
      stallMs: READ_TIMEOUT_MS,
      budgetMs: READ_BUDGET_MS,
    });
    const over = await readBoundedBody(chunkedStream([asset]), {
      limit: asset.byteLength - 1,
      stallMs: READ_TIMEOUT_MS,
      budgetMs: READ_BUDGET_MS,
    });

    expect(exact).toStrictEqual({ kind: 'complete', bytes: asset });
    expect(over.kind).toBe('over-limit');
    // Every byte the origin sent, in order: what this will not hold it can still hand on.
    await expect(restOf(over)).resolves.toStrictEqual(asset);
  });

  /** The body belongs to whoever asked for it: a caller delivering one lets go of it, not this. */
  it('stops pulling once the body is past the limit, and leaves the rest to the caller', async () => {
    const stream = endlessStream(new Uint8Array(64));

    const bounded = await readBoundedBody(stream.body, {
      limit: 200,
      stallMs: READ_TIMEOUT_MS,
      budgetMs: READ_BUDGET_MS,
    });
    const stillOpen = stream.cancelled();
    await releaseRest(bounded);

    // Four pulls of 64 bytes carry it past 200; an unbounded read would never stop.
    expect(stream.produced()).toBe(4);
    expect(stillOpen).toBe(false);
    expect(stream.cancelled()).toBe(true);
  });

  /**
   * The budget is silence, not duration: it is read at the pace of whoever else holds the body, so
   * a large asset behind a patient client must not look like an origin that stopped sending.
   */
  it('keeps reading a body that keeps arriving, however slowly', async () => {
    const pieces = [asset.subarray(0, 4), asset.subarray(4, 9), asset.subarray(9)];
    let sent = 0;
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => {
          setTimeout(resolve, SLOW_CHUNK_MS);
        });
        const piece = pieces[sent];
        sent += 1;
        if (piece === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(piece);
      },
    });

    // Four waits of `SLOW_CHUNK_MS` run well past this budget in total, and no single one reaches
    // it: a budget for the whole read would have given up on a body that never stopped arriving.
    const bounded = await readBoundedBody(slow, {
      limit: 4096,
      stallMs: SLOW_CHUNK_MS * 2,
      budgetMs: READ_BUDGET_MS,
    });

    expect(bounded).toStrictEqual({ kind: 'complete', bytes: asset });
  });

  it('gives up on a body that stops arriving', async () => {
    const stream = stallingStream(encodeUtf8('console.log('));

    await expect(
      readBoundedBody(stream, { limit: 4096, stallMs: 20, budgetMs: READ_BUDGET_MS }),
    ).rejects.toThrow('timed out');
  });

  /**
   * Whoever else holds this body is not waiting on the copy, but the runtime behind it is: work
   * still running when its window closes is stopped where it stands and reports nothing at all.
   */
  it('gives up a body still arriving once the whole budget is gone', async () => {
    const steady = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => {
          setTimeout(resolve, SLOW_CHUNK_MS);
        });
        controller.enqueue(asset);
      },
    });

    // Nothing here is ever silent for as long as the stall allows, and the body never ends.
    await expect(
      readBoundedBody(steady, {
        limit: 4096,
        stallMs: SLOW_CHUNK_MS * 4,
        budgetMs: SLOW_CHUNK_MS * 2,
      }),
    ).rejects.toThrow('timed out');
  });

  it(
    'gives up on time even when the socket never acknowledges the cancel',
    HANG_TIMEOUT,
    async () => {
      const stream = stallingStream(encodeUtf8('console.log('), true);

      await expect(
        readBoundedBody(stream, { limit: 4096, stallMs: 20, budgetMs: READ_BUDGET_MS }),
      ).rejects.toThrow('timed out');
    },
  );
});
