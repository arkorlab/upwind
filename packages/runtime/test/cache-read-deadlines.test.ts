import { deriveEntry } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureCacheHandlers, PlatformFetchCache } from '../src/cache/handlers.ts';
import type { CacheHost, FetchLike } from '../src/cache/host.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { createCacheHost } from './function-cache-host.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

/**
 * How long a render waits on the read gateway: a value of the data cache, or the invalidations of
 * its tags, is given up after a second (`packages/cache-host`; 300 ms until 2026-10-22), and the
 * render goes on as it would with no cache — a miss for that request alone, nothing of it
 * remembered, and the request to the gateway let go of.
 */

const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-test',
};
/** How long a read waits, on the read gateway or the authority itself (`packages/cache-host`). */
const DEADLINE_MS = 1000;
/** Reads go to the authority itself: no read gateway, by binding or by URL. */
const AUTHORITY_ONLY = {
  ARKOR_CACHE_GATEWAY_URL: ENV.ARKOR_CACHE_GATEWAY_URL,
  ARKOR_CACHE_TOKEN: ENV.ARKOR_CACHE_TOKEN,
  NEXT_DEPLOYMENT_ID: ENV.NEXT_DEPLOYMENT_ID,
};
/** How long an artifact read waits on the authority (`packages/cache-host`). */
const ARTIFACT_DEADLINE_MS = 10_000;
/** How long a delivery record read waits on its gateway, its body included (`packages/cache-host`). */
const RECORD_DEADLINE_MS = 10_000;
/** How long after a read that stalls the read behind it asks: well within its own deadline. */
const BEHIND_AFTER_MS = 1000;
const FETCHED = { kind: 'FETCH', data: { body: 'kept' }, revalidate: 60 };

function result(value: unknown): Response {
  return Response.json({ ok: true, result: value });
}

/** The data record the read gateway answers for a key the fetch cache stored. */
function record(timestamp: number, entryId: string) {
  return {
    entryId,
    generationId: 'generation',
    dependencyRevision: 1,
    entry: {
      kind: 'data:fetch',
      tags: ['feed'],
      stale: 0,
      timestamp,
      expire: 31_536_000,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
    value: { kind: 'inline', base64: btoa(JSON.stringify(FETCHED)) },
  };
}

/**
 * A read gateway that holds its answers to `held` — for `answerAfterMs`, or until the test lets them
 * go, rejecting a request that is aborted meanwhile — and names every request it was sent.
 */
async function gateway(
  held: '/data/get' | '/tags/get',
  timestamp: number,
  {
    answerAfterMs,
    env = ENV,
  }: { readonly answerAfterMs?: number; readonly env?: Record<string, unknown> } = {},
) {
  const { entryId } = await deriveEntry(ENV.NEXT_DEPLOYMENT_ID, {
    kind: 'data:fetch',
    key: 'feed',
  });
  const requests: Request[] = [];
  let holding = true;
  const runtime = createCacheRuntime({
    env,
    now: () => Date.now(),
    fetchImpl: (request) => {
      requests.push(request);
      const answer = (): Response =>
        result(request.url.endsWith('/tags/get') ? { tags: [] } : record(timestamp, entryId));
      if (!holding || !request.url.endsWith(held)) {
        return Promise.resolve(answer());
      }
      if (answerAfterMs === undefined) {
        // As a fetch does: no answer, and a rejection once its request is aborted. That rejection
        // comes after the render has stopped waiting, and must not go unhandled (Vitest fails the
        // run on one).
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new Error('the request was aborted', { cause: request.signal.reason }));
          });
        });
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(answer());
        }, answerAfterMs);
      });
    },
  });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  vi.spyOn(runtime, 'log').mockImplementation(vi.fn());
  configureCacheHandlers(runtime);
  return {
    requests,
    release: () => {
      holding = false;
    },
  };
}

/** Where each request went, as the gateway's routes name it. */
function routesOf(requests: readonly Request[]): string[] {
  return requests.map((request) => new URL(request.url).pathname.split('/').slice(-2).join('/'));
}

describe('a read the gateway does not answer in time', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is given up as a miss that is not remembered, and its request let go of', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { requests, release } = await gateway('/data/get', Date.now() - 1000);
    const cache = new PlatformFetchCache();

    const late = cache.get('feed', { kind: 'FETCH' });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    const waiting = requests.map((request) => request.signal.aborted);
    await vi.advanceTimersByTimeAsync(1);

    await expect(late).resolves.toBeNull();
    expect(waiting).toStrictEqual([false]);
    expect(requests.map((request) => request.signal.aborted)).toStrictEqual([true]);

    // The next read asks again, rather than find a miss the late one left behind.
    release();
    const again = await cache.get('feed', { kind: 'FETCH' });

    expect(again).toMatchObject({ value: FETCHED });
    expect(routesOf(requests)).toStrictEqual(['data/get', 'data/get', 'tags/get']);
  });

  /** An answer of no invalidations would call the value fresh, whatever the host holds. */
  it('fails a tag check rather than call the value fresh, and the value is a miss', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { requests } = await gateway('/tags/get', Date.now() - 1000);
    const cache = new PlatformFetchCache();

    const unjudged = cache.get('feed', { kind: 'FETCH' });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    await expect(unjudged).resolves.toBeNull();
    expect(routesOf(requests)).toStrictEqual(['data/get', 'tags/get']);
    expect(requests.map((request) => request.signal.aborted)).toStrictEqual([false, true]);
  });

  /**
   * A read past the 300 ms it was given up at until 2026-10-22 is waited for: the value is a hit,
   * where it was a miss the render fetched again, in front of its response, and wrote over the one
   * the cache held.
   */
  it.each(['/data/get', '/tags/get'] as const)(
    'answers as ever when the gateway answers %s within it',
    async (held) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { requests } = await gateway(held, Date.now() - 1000, {
        answerAfterMs: DEADLINE_MS - 1,
      });
      const cache = new PlatformFetchCache();

      const read = cache.get('feed', { kind: 'FETCH' });
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);

      await expect(read).resolves.toMatchObject({ value: FETCHED });
      expect(routesOf(requests)).toStrictEqual(['data/get', 'tags/get']);
      expect(requests.map((request) => request.signal.aborted)).toStrictEqual([false, false]);
    },
  );

  /**
   * With no read gateway, reads go to the authority itself, a placed Worker answering from its own
   * region, and are waited for as long: what it answers within the second is a hit.
   */
  it('waits as long on the authority itself, where there is no read gateway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { requests } = await gateway('/data/get', Date.now() - 1000, {
      answerAfterMs: DEADLINE_MS - 1,
      env: AUTHORITY_ONLY,
    });
    const cache = new PlatformFetchCache();

    const read = cache.get('feed', { kind: 'FETCH' });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    await expect(read).resolves.toMatchObject({ value: FETCHED });
    expect(new URL(requests[0]?.url ?? '').origin).toBe(ENV.ARKOR_CACHE_GATEWAY_URL);
  });
});

/**
 * How long a render waits on an artifact the authority is reading: 10 s, from the request to the
 * last byte (`packages/cache-host`). A gateway or a body that goes quiet past that is given up, and
 * its request let go of, rather than holding the render open for as long as the request lasts.
 */
describe('an artifact the authority does not answer in time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A read with no deadline never settles here: it fails on the timeout, kept short to say so soon.
  it('is given up as a failed read, and its request let go of', { timeout: 5000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requests: Request[] = [];
    const binding = createCacheHost({
      env: AUTHORITY_ONLY,
      // As a fetch does: no answer, and a rejection once its request is aborted.
      fetchImpl: (request) => {
        requests.push(request);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new Error('the request was aborted', { cause: request.signal.reason }));
          });
        });
      },
    });

    const read = (async () => {
      try {
        await binding?.host.readArtifact('blob_never_answered');
        return 'answered';
      } catch {
        return 'given up';
      }
    })();
    await vi.advanceTimersByTimeAsync(ARTIFACT_DEADLINE_MS - 1);
    const waiting = requests.map((request) => request.signal.aborted);
    await vi.advanceTimersByTimeAsync(1);

    await expect(read).resolves.toBe('given up');
    expect(waiting).toStrictEqual([false]);
    expect(requests.map((request) => request.signal.aborted)).toStrictEqual([true]);
  });
});

const KIB = 1024;
const MIB = KIB * KIB;

/** The artifact a request to the authority asks for. */
function artifactOf(request: Request): string {
  const { pathname } = new URL(request.url);
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

/** A host whose reads of artifacts go to an authority answering through `fetchImpl`. */
function hostThrough(fetchImpl: FetchLike): CacheHost {
  const binding = createCacheHost({ env: AUTHORITY_ONLY, fetchImpl });
  if (binding === undefined) {
    throw new Error('these bindings reach no cache');
  }
  return binding.host;
}

interface Outcome {
  now: 'out' | 'answered' | 'given up';
}

/** Keep in `outcome` what the read comes to: answered, or given up. */
async function settle(read: Promise<unknown>, outcome: Outcome): Promise<void> {
  try {
    await read;
    outcome.now = 'answered';
  } catch {
    outcome.now = 'given up';
  }
}

/** What a read asks the host for by its id. */
type Ask = (host: CacheHost, id: string) => Promise<Uint8Array | undefined>;

/**
 * Three reads at once, each answered with `size` bytes that take a moment to arrive, the answer
 * saying how many unless `sayLength` is false: how long each answer read was, and the most bodies
 * read at once. Each asks for an artifact, unless `ask` says otherwise.
 */
async function readTogether(
  size: number,
  sayLength = true,
  ask: Ask = (host, id) => host.readArtifact(id),
): Promise<{ readonly lengths: (number | undefined)[]; readonly most: number }> {
  const bodies = { out: 0, most: 0 };
  const host = hostThrough((request) => {
    const bytes = new Uint8Array(size).fill(artifactOf(request).length);
    // Observe actual consumption, independent of whether the reader uses arrayBuffer or BYOB.
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          bodies.out += 1;
          bodies.most = Math.max(bodies.most, bodies.out);
          try {
            await new Promise((resolve) => {
              setTimeout(resolve, 5);
            });
            controller.enqueue(bytes);
            controller.close();
          } finally {
            bodies.out -= 1;
          }
        },
      },
      { highWaterMark: 0 },
    );
    return Promise.resolve(
      new Response(body, { headers: sayLength ? { 'content-length': String(size) } : {} }),
    );
  });
  const answers = await Promise.all(['blob_a', 'blob_bb', 'blob_ccc'].map((id) => ask(host, id)));
  return { lengths: answers.map((answer) => answer?.byteLength), most: bodies.most };
}

/**
 * An artifact is read whole before it is answered with, and one render may miss several large ones
 * together: an isolate reads no more of the authority's answers at once than it has room for, 32 MiB
 * by what each answer says it holds (`packages/cache-host`). Answers that fit together are read
 * together. Authority artifacts over 32 MiB miss before their body is read.
 */
describe('artifacts the authority answers together', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads no more of them at once than an isolate has room for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // These bytes are no artifact's: served, and said not to be kept.
    });

    const small = await readTogether(MIB);
    const large = await readTogether(12 * MIB);
    const unsaid = await readTogether(MIB, false);

    expect(small).toStrictEqual({ lengths: [MIB, MIB, MIB], most: 3 });
    expect(large).toStrictEqual({ lengths: [12 * MIB, 12 * MIB, 12 * MIB], most: 2 });
    // An answer that says nothing of its length is taken to be as long as a read may be.
    expect(unsaid).toStrictEqual({ lengths: [MIB, MIB, MIB], most: 1 });
  });

  it('misses an oversized authority artifact before consuming its body', async () => {
    const cancelled = vi.fn();
    const pulled = vi.fn();
    const host = hostThrough(() => {
      const body = new ReadableStream<Uint8Array>(
        { pull: pulled, cancel: cancelled },
        { highWaterMark: 0 },
      );
      return Promise.resolve(
        new Response(body, { headers: { 'content-length': String(48 * MIB) } }),
      );
    });

    await expect(host.readArtifact('blob_alone')).resolves.toBeUndefined();

    expect(pulled).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(expect.any(String));
  });

  it('cancels a stalled artifact at its deadline and gives the room to the read behind it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // These bytes are no artifact's: served, and said not to be kept.
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const size = 20 * MIB;
    const cancelled = vi.fn();
    const host = hostThrough((request) => {
      const body =
        artifactOf(request) === 'blob_holding'
          ? new ReadableStream<Uint8Array>({ cancel: cancelled }, { highWaterMark: 0 })
          : new Uint8Array(size);
      return Promise.resolve(new Response(body, { headers: { 'content-length': String(size) } }));
    });
    const holding: Outcome = { now: 'out' };
    const behind: Outcome = { now: 'out' };
    const settled = [settle(host.readArtifact('blob_holding'), holding)];
    await vi.advanceTimersByTimeAsync(BEHIND_AFTER_MS);
    settled.push(settle(host.readArtifact('blob_behind'), behind));
    await vi.advanceTimersByTimeAsync(ARTIFACT_DEADLINE_MS - BEHIND_AFTER_MS - 1);

    expect([holding.now, behind.now]).toStrictEqual(['out', 'out']);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(behind.now).toBe('answered');
    });
    await Promise.all(settled);

    expect(holding.now).toBe('given up');
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(expect.any(String));
  });
});

/** A read of the entry's delivery record, rather than of an artifact. */
const askRecord: Ask = (host, id) => host.readRecord(id);

/** Give the reads under way a moment to take their room or come to their answers. */
async function aMoment(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
}

/**
 * A delivery record is read whole too, may be as long as an artifact (`MAX_PACK_BYTES`), and the
 * runtime has many reads of them out at once: one whose answer says how long it is is read in the
 * room artifacts are read in (`packages/cache-host`), and waits only past it. One that says nothing,
 * a gateway's from before records said it, is read as it always was.
 */
describe('records the gateway answers together', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads no more of them at once than an isolate has room for', async () => {
    const large = await readTogether(12 * MIB, true, askRecord);
    const unsaid = await readTogether(12 * MIB, false, askRecord);

    expect(large).toStrictEqual({ lengths: [12 * MIB, 12 * MIB, 12 * MIB], most: 2 });
    expect(unsaid).toStrictEqual({ lengths: [12 * MIB, 12 * MIB, 12 * MIB], most: 3 });
  });

  it('waits for the room an artifact holds only once it would not fit beside it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // These bytes are no artifact's: served, and said not to be kept.
    });
    const held = Promise.withResolvers<undefined>();
    const host = hostThrough((request) => {
      const size = new URL(request.url).pathname.endsWith('/small/record') ? MIB : 20 * MIB;
      const bytes = new Uint8Array(size);
      const body =
        artifactOf(request) === 'blob_holding'
          ? new ReadableStream<Uint8Array>(
              {
                async pull(controller) {
                  await held.promise;
                  controller.enqueue(bytes);
                  controller.close();
                },
              },
              { highWaterMark: 0 },
            )
          : bytes;
      return Promise.resolve(new Response(body, { headers: { 'content-length': String(size) } }));
    });
    const holding: Outcome = { now: 'out' };
    const small: Outcome = { now: 'out' };
    const large: Outcome = { now: 'out' };

    const settled = [settle(host.readArtifact('blob_holding'), holding)];
    await aMoment();
    settled.push(settle(host.readRecord('small'), small));
    await aMoment();
    settled.push(settle(host.readRecord('large'), large));
    await aMoment();

    expect([holding.now, small.now, large.now]).toStrictEqual(['out', 'answered', 'out']);

    held.resolve(undefined);
    await Promise.all(settled);

    expect([holding.now, large.now]).toStrictEqual(['answered', 'answered']);
  });

  /**
   * A document stops waiting for its record long before the runtime calls the read off, and a
   * caller may hand the read no signal at all: a body that stalls once its room is taken is given up
   * with its read, and the room goes to the read behind it.
   */
  it('gives the room of a record whose body stalls back once its read is given up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const size = 20 * MIB;
    // Held on to, as a fetch holds its request: a request follows the signal it was made with only
    // while it is alive, and one nothing holds could be collected before its read is called off.
    const asked: Request[] = [];
    const host = hostThrough((request) => {
      asked.push(request);
      // Its headers, then nothing of its body until its request is called off, as a fetch's.
      const stalls = new URL(request.url).pathname.endsWith('/stalled/record');
      const body = stalls
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              request.signal.addEventListener('abort', () => {
                controller.error(request.signal.reason);
              });
            },
          })
        : new Uint8Array(size);
      return Promise.resolve(new Response(body, { headers: { 'content-length': String(size) } }));
    });
    const stalled: Outcome = { now: 'out' };
    const behind: Outcome = { now: 'out' };

    const settled = [settle(host.readRecord('stalled'), stalled)];
    await vi.advanceTimersByTimeAsync(BEHIND_AFTER_MS);
    settled.push(settle(host.readRecord('behind'), behind));
    await vi.advanceTimersByTimeAsync(RECORD_DEADLINE_MS - BEHIND_AFTER_MS - 1);

    expect([stalled.now, behind.now]).toStrictEqual(['out', 'out']);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(behind.now).toBe('answered');
    });
    await Promise.all(settled);

    expect(stalled.now).toBe('given up');
    // The stalled read's request was called off, and the one behind it was not.
    expect(asked.map((request) => request.signal.aborted)).toStrictEqual([true, false]);
  });
});
