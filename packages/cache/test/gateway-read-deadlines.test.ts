import { deriveEntry } from '@stayingupwind/core/cache';
import { isDeadlineError } from '@stayingupwind/core/util';
import type { DataGetResponse } from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';

/**
 * How long a render waits on a read of a value of the data cache, or of the invalidations of its
 * tags: a second, wherever the read goes (`READ_DEADLINE_MS`). Through a read gateway such a read
 * was given up at 300 ms until 2026-10-22; one slower than that is now waited for, and told of in
 * the Function's log as slow (`SLOW_READ_MS`).
 */

const SCOPE = 'scope_read_deadlines';
const DATA = { kind: 'data:fetch', key: 'feed' } as const;
const TAGS = ['feed'];
const DEADLINE_MS = 1000;
const SLOW_MS = 300;
/** Past the 300 ms a read through a read gateway was given up at before, and short of a second. */
const SLOW_ANSWER_MS = 500;
const READ_GATEWAY = 'https://read.example';
const AUTHORITY = 'https://authority.example';

type Read = 'getData' | 'getTags';

/** What a read is answered with: the value it asked for, or no invalidation of the tags named. */
async function answerTo(read: Read): Promise<unknown> {
  if (read === 'getTags') {
    return { tags: [] };
  }
  const { entryId } = await deriveEntry(SCOPE, DATA);
  const value: DataGetResponse = {
    entryId,
    generationId: 'generation',
    dependencyRevision: 1,
    entry: {
      kind: DATA.kind,
      tags: TAGS,
      stale: 30,
      timestamp: 1,
      expire: 120,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
    value: { kind: 'inline', base64: btoa('value') },
  };
  return value;
}

/**
 * A gateway whose every read is answered with `answer` `afterMs` after it is asked, or never where
 * that is left out — a read then rejecting once its request is aborted, as a fetch does — through a
 * read gateway beside the render, or through the authority itself where `nearby` is false: and the
 * requests it was sent.
 */
function gatewayAnswering(
  answer: unknown,
  { afterMs, nearby = true }: { readonly afterMs?: number; readonly nearby?: boolean } = {},
): { readonly gateway: Gateway; readonly requests: Request[] } {
  const requests: Request[] = [];
  const send: FetchLike = (request) => {
    requests.push(request);
    return new Promise<Response>((resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        reject(new Error('the request was aborted', { cause: request.signal.reason }));
      });
      if (afterMs !== undefined) {
        setTimeout(() => {
          resolve(Response.json({ ok: true, result: answer }));
        }, afterMs);
      }
    });
  };
  const gateway = new Gateway({
    scopeId: SCOPE,
    gatewayUrl: AUTHORITY,
    token: 'scope-token',
    naming: { copyCache: 'read-deadline-copies', copyKeyOrigin: 'https://copies.example' },
    fetchImpl: send,
    ...(nearby && { readGatewayUrl: READ_GATEWAY, readFetchImpl: send }),
  });
  return { gateway, requests };
}

function reading(gateway: Gateway, read: Read): Promise<unknown> {
  return read === 'getData' ? gateway.getData(DATA) : gateway.getTags(TAGS);
}

/** The lines the Function's log was written, as the objects they say. */
function told(warned: MockInstance<typeof console.warn>): unknown[] {
  return warned.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
}

/** Where each request went. */
function originsOf(requests: readonly Request[]): string[] {
  return requests.map((request) => new URL(request.url).origin);
}

interface Outcome {
  now: 'out' | 'answered' | 'given up' | 'failed';
}

/** Keep in `outcome` what the read comes to: answered, given up at its deadline, or failed. */
async function settle(read: Promise<unknown>, outcome: Outcome): Promise<void> {
  try {
    await read;
    outcome.now = 'answered';
  } catch (error) {
    outcome.now = isDeadlineError(error) ? 'given up' : 'failed';
  }
}

describe('a read of a value or of its tags', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** It was given up at 300 ms, a miss the render made the value again for, and wrote. */
  it.each([
    ['getData', 'data read'],
    ['getTags', 'tag read'],
  ] as const)(
    'uses what %s is answered with past 300 ms, and tells of it as slow',
    async (read, what) => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
        // What the Function's log was written is read off the spy.
      });
      const answer = await answerTo(read);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { gateway, requests } = gatewayAnswering(answer, { afterMs: SLOW_ANSWER_MS });

      const answered = reading(gateway, read);
      await vi.advanceTimersByTimeAsync(SLOW_ANSWER_MS);

      await expect(answered).resolves.toStrictEqual(answer);
      expect(originsOf(requests)).toStrictEqual([READ_GATEWAY]);
      expect(told(warned)).toStrictEqual([
        { level: 'warn', msg: `cache-host: ${what} slow`, tookMs: SLOW_ANSWER_MS },
      ]);
    },
  );

  /** The runtime takes it for a miss and logs it as the read that failed: nothing is said here. */
  it.each(['getData', 'getTags'] as const)(
    'gives %s up at a second as before, and the request under it with it',
    async (read) => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
        // What the Function's log was written is read off the spy.
      });
      const answer = await answerTo(read);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { gateway, requests } = gatewayAnswering(answer);
      const outcome: Outcome = { now: 'out' };

      const settled = settle(reading(gateway, read), outcome);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      const waiting = {
        outcome: outcome.now,
        aborted: requests.map(({ signal }) => signal.aborted),
      };
      await vi.advanceTimersByTimeAsync(1);
      await settled;

      expect(waiting).toStrictEqual({ outcome: 'out', aborted: [false] });
      expect(outcome.now).toBe('given up');
      expect(requests.map(({ signal }) => signal.aborted)).toStrictEqual([true]);
      expect(warned).not.toHaveBeenCalled();
    },
  );

  it('tells of no read answered within 300 ms', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // What the Function's log was written is read off the spy.
    });
    const answer = await answerTo('getData');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { gateway } = gatewayAnswering(answer, { afterMs: SLOW_MS - 1 });

    const answered = gateway.getData(DATA);
    await vi.advanceTimersByTimeAsync(SLOW_MS - 1);

    await expect(answered).resolves.toStrictEqual(answer);
    expect(warned).not.toHaveBeenCalled();
  });

  /** A round trip from across the world is what a read of the authority ordinarily costs. */
  it('waits as long on the authority itself, and tells of no slow read of it', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // What the Function's log was written is read off the spy.
    });
    const answer = await answerTo('getData');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { gateway, requests } = gatewayAnswering(answer, {
      afterMs: DEADLINE_MS - 1,
      nearby: false,
    });

    const answered = gateway.getData(DATA);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);

    await expect(answered).resolves.toStrictEqual(answer);
    expect(originsOf(requests)).toStrictEqual([AUTHORITY]);
    expect(warned).not.toHaveBeenCalled();
  });
});
