import { deriveEntry } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withClock } from '../../src/cache/clock.ts';
import type { CacheHost, DataEntryMetadata, DataWritten, FetchLike } from '../../src/cache/host.ts';
import { installRequestContext, withRequestContext } from '../../src/request-context.ts';
import { createCacheHost } from '../function-cache-host.ts';

/**
 * What a deployment's Worker keeps of the values it writes to the data cache
 * (`upwind/packages/cache/src/function/data-copies.ts`): its data center's Cache API holds a copy
 * of each, read where KV — the read gateway — answers with none. KV keeps an answer that there is
 * none for half a minute in the data center it was read in, and a value written meanwhile is
 * otherwise read by no other isolate there until that answer goes.
 *
 * Run inside workerd, since the Cache API is what is under test. The authority is a stand-in for the
 * two routes these calls take: it takes every write, and answers every read with none, as KV does for
 * a key read before it was written. Each test writes under a scope of its own, so no copy one test
 * keeps is found by another. A host made afresh stands for another isolate in the same data center.
 */

const GATEWAY_URL = 'https://authority.test';
const TOKEN = 'test-scope-token';
const KEY = 'a fetch cache key';
const MIB = 1024 * 1024;
const NOW = 1_790_000_000_000;
const MS_PER_SECOND = 1000;
const YEAR_SECONDS = 31_536_000;

interface Authority {
  readonly fetchImpl: FetchLike;
  /** The routes the authority was asked on, in order. */
  readonly asked: string[];
  /** What each read of the value the key holds now (`/data/current`) asked, in order. */
  readonly currentAsked: Promise<unknown>[];
}

interface AuthorityAnswers {
  /** What a write is answered with: the write taken, or refused. */
  readonly written?: Omit<DataWritten, 'entryId'> | 'refused';
  /** What KV holds of the key, answered for every read; none where left out. */
  readonly record?: unknown;
  /** What the authority holds of the key now (`/data/current`); none where left out. */
  readonly current?: unknown;
}

function scopeOfItsOwn(): string {
  return `scope-${crypto.randomUUID()}`;
}

/** The authority's answer to a write it took. */
function taken(extra: Partial<Omit<DataWritten, 'entryId'>> = {}): Omit<DataWritten, 'entryId'> {
  return { generationId: 'generation-written', revision: 7, ...extra };
}

/** The core's identity for the scoped fetch key, shared by writes and either read route. */
async function entryIdOf(scopeId: string): Promise<string> {
  return (await deriveEntry(scopeId, { kind: 'data:fetch', key: KEY })).entryId;
}

function entryOf(extra: Partial<DataEntryMetadata> = {}): DataEntryMetadata {
  return {
    kind: 'data:fetch',
    tags: ['products'],
    stale: 0,
    timestamp: NOW,
    expire: YEAR_SECONDS,
    revalidate: 60,
    ...extra,
  };
}

function refused(): Response {
  return Response.json(
    { ok: false, error: { code: 'scope_retired', message: 'the scope is retired' } },
    { status: 410 },
  );
}

/** The authority's data routes: every write answered as `answers` says, every read with none. */
async function authorityOf(scopeId: string, answers: AuthorityAnswers = {}): Promise<Authority> {
  const entryId = await entryIdOf(scopeId);
  const asked: string[] = [];
  const currentAsked: Promise<unknown>[] = [];
  return {
    asked,
    currentAsked,
    fetchImpl: (request) => {
      const { pathname } = new URL(request.url);
      const route = `${request.method} ${pathname.slice(pathname.lastIndexOf('/data'))}`;
      asked.push(route);
      if (route === 'POST /data/current') {
        currentAsked.push(request.clone().json());
      }
      if (route === 'POST /data/get' || route === 'POST /data/current') {
        const held = route === 'POST /data/get' ? answers.record : answers.current;
        return Promise.resolve(
          held === undefined
            ? Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 })
            : Response.json({ ok: true, result: held }),
        );
      }
      if (route === 'PUT /data') {
        const written = answers.written ?? taken();
        return Promise.resolve(
          written === 'refused'
            ? refused()
            : Response.json({ ok: true, result: { ...written, entryId } }),
        );
      }
      return Promise.resolve(new Response('not a data route', { status: 500 }));
    },
  };
}

/** The host a deployment's runtime is given, reaching the authority at a URL. */
function hostOf(scopeId: string, fetchImpl: FetchLike, token = TOKEN): CacheHost {
  const binding = createCacheHost({
    env: {
      ARKOR_CACHE_GATEWAY_URL: GATEWAY_URL,
      ARKOR_CACHE_TOKEN: token,
      NEXT_DEPLOYMENT_ID: scopeId,
    },
    fetchImpl,
  });
  if (binding === undefined) {
    throw new Error('these bindings reach no cache');
  }
  return binding.host;
}

/**
 * Run `work` as the runtime runs a request, at `now` on the request's clock; what the host hands
 * the request to keep going behind its response goes into `behind`.
 */
function inRequest<T>(
  work: () => Promise<T>,
  now = NOW,
  behind: Promise<unknown>[] = [],
): Promise<T> {
  installRequestContext();
  return withRequestContext(
    {
      headers: {},
      url: 'https://app.test/',
      waitUntil: (promise) => {
        behind.push(promise);
      },
    },
    async () => withClock(now, work),
  );
}

/** A first isolate's write of `base64` under the key, as its runtime makes it. */
async function write(
  scopeId: string,
  answers: AuthorityAnswers,
  input: { readonly base64?: string; readonly entry?: DataEntryMetadata } = {},
): Promise<DataWritten> {
  const host = hostOf(scopeId, (await authorityOf(scopeId, answers)).fetchImpl);
  return inRequest(async () => {
    return host.setData({
      key: KEY,
      entry: input.entry ?? entryOf(),
      valueBase64: input.base64 ?? btoa('the value a render fetched'),
      order: { writer: 'isolate-one', seq: 1 },
    });
  });
}

/** A read of the key by another isolate of the data center, whose KV holds none of it. */
async function readElsewhere(
  scopeId: string,
  options: { readonly now?: number; readonly token?: string; readonly record?: unknown } = {},
): Promise<unknown> {
  const authority = await authorityOf(scopeId, { record: options.record });
  const host = hostOf(scopeId, authority.fetchImpl, options.token);
  return inRequest(async () => host.getData({ key: KEY, kind: 'data:fetch' }), options.now);
}

/** The revision of the value a read judged stale or expired: the one a write here is taken at. */
const JUDGED_REVISION = 7;

/** What `host` answers a read that judged the key's value at `JUDGED_REVISION` with. */
function laterThanJudged(host: CacheHost): Promise<unknown> {
  return inRequest(async () =>
    host.getNewerData?.({ key: KEY, kind: 'data:fetch' }, JUDGED_REVISION),
  );
}

/**
 * A read by another isolate of the data center, the fake clock moved a millisecond at a time from
 * before it starts until it settles: what it answered, and how many milliseconds that took.
 */
async function timedRead(
  scopeId: string,
): Promise<{ readonly answer: unknown; readonly waited: number }> {
  const read = { settled: false, waited: 0 };
  const settling = async (): Promise<unknown> => {
    try {
      return await readElsewhere(scopeId);
    } finally {
      read.settled = true;
    }
  };
  const answer = settling();
  while (!read.settled && read.waited < 1000) {
    await vi.advanceTimersByTimeAsync(1);
    read.waited += 1;
  }
  return { answer: await answer, waited: read.waited };
}

describe('values a deployment has written to the data cache', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers another isolate of the data center, whose KV has none, from the copy', async () => {
    const base64 = btoa('the value a render fetched');
    const scopeId = scopeOfItsOwn();
    // The write answers once the copy is kept: nothing to wait for before it is read.
    await write(scopeId, {}, { base64 });

    await expect(readElsewhere(scopeId)).resolves.toStrictEqual({
      entryId: await entryIdOf(scopeId),
      generationId: 'generation-written',
      dependencyRevision: 7,
      entry: { ...entryOf(), dependencyCoverage: 'complete' },
      value: { kind: 'inline', base64 },
    });
  });

  it('answers with what KV holds where it holds anything', async () => {
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {});
    const record = {
      entryId: await entryIdOf(scopeId),
      generationId: 'generation-later',
      dependencyRevision: 9,
      entry: { ...entryOf(), dependencyCoverage: 'complete' },
      value: { kind: 'inline', base64: btoa('a later value') },
    };

    await expect(readElsewhere(scopeId, { record })).resolves.toStrictEqual(record);
  });

  /**
   * Where KV answers with a value the runtime then finds stale or expired, the runtime asks for a
   * later one (`getNewerData`): KV's cache goes on answering with what a later write replaced.
   */
  it('answers a read behind the copy with it, and a read at it or past it with nothing', async () => {
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {});
    const host = hostOf(scopeId, (await authorityOf(scopeId)).fetchImpl);
    const later = (than: number): Promise<unknown> =>
      inRequest(async () => host.getNewerData?.({ key: KEY, kind: 'data:fetch' }, than));

    await expect(later(6)).resolves.toMatchObject({
      generationId: 'generation-written',
      dependencyRevision: 7,
    });
    await expect(later(7)).resolves.toBeUndefined();
    await expect(later(8)).resolves.toBeUndefined();
  });

  /**
   * Where the data center holds no later value, it is the authority's to say: KV answers here with
   * what it read for half a minute, and a value another data center wrote since is read nowhere
   * here but there. What it answers is kept as the data center's copy, for the isolates after.
   */
  it('asks the authority for a later value where the data center holds none, and keeps it', async () => {
    const scopeId = scopeOfItsOwn();
    const current = {
      entryId: await entryIdOf(scopeId),
      generationId: 'generation-elsewhere',
      dependencyRevision: 9,
      entry: { ...entryOf(), dependencyCoverage: 'complete' },
      value: { kind: 'inline', base64: btoa('a value written in another data center') },
    };
    const authority = await authorityOf(scopeId, { current });
    const host = hostOf(scopeId, authority.fetchImpl);
    const next = hostOf(scopeId, (await authorityOf(scopeId)).fetchImpl);

    await expect(laterThanJudged(host)).resolves.toStrictEqual(current);
    expect(authority.asked).toStrictEqual(['POST /data/current']);
    // Past the value the read judged: the authority reads nothing of a value that is not later.
    await expect(Promise.all(authority.currentAsked)).resolves.toStrictEqual([
      { key: KEY, kind: 'data:fetch', than: JUDGED_REVISION },
    ]);

    // Another isolate of the data center, whose authority holds nothing to say: the copy answers.
    await vi.waitFor(async () => {
      await expect(laterThanJudged(next)).resolves.toStrictEqual(current);
    });
  });

  /**
   * The runtime waits for the authority's answer only so long, and the response the read is under
   * can end before it comes: the copy is the request's to keep going from the moment it is asked.
   */
  it('keeps the authority’s answer going behind the response from the moment it is asked', async () => {
    const scopeId = scopeOfItsOwn();
    const current = {
      entryId: await entryIdOf(scopeId),
      generationId: 'generation-elsewhere',
      dependencyRevision: 9,
      entry: { ...entryOf(), dependencyCoverage: 'complete' },
      value: { kind: 'inline', base64: btoa('a value written in another data center') },
    };
    const authority = await authorityOf(scopeId, { current });
    const answer = { release: (): void => undefined };
    const answered = new Promise<void>((resolve) => {
      answer.release = resolve;
    });
    const slow: FetchLike = async (request) => {
      await answered;
      return authority.fetchImpl(request);
    };
    const host = hostOf(scopeId, slow);
    const behind: Promise<unknown>[] = [];

    const read = inRequest(
      async () => host.getNewerData?.({ key: KEY, kind: 'data:fetch' }, JUDGED_REVISION),
      NOW,
      behind,
    );

    await vi.waitFor(() => {
      expect(behind).toHaveLength(1);
    });

    answer.release();
    const elsewhere = hostOf(scopeId, (await authorityOf(scopeId)).fetchImpl);

    await expect(read).resolves.toStrictEqual(current);

    await Promise.all(behind);

    await expect(laterThanJudged(elsewhere)).resolves.toStrictEqual(current);
  });

  /**
   * The authority's answer can come well after it was asked — past the runtime's wait, or behind
   * the request's other writes — and a write of the key in the data center can have kept a later
   * value's copy meanwhile: the answer is not kept over it.
   */
  it('keeps no answer of the authority over the copy of a later value written meanwhile', async () => {
    const scopeId = scopeOfItsOwn();
    const current = {
      entryId: await entryIdOf(scopeId),
      generationId: 'generation-elsewhere',
      dependencyRevision: 9,
      entry: { ...entryOf(), dependencyCoverage: 'complete' },
      value: { kind: 'inline', base64: btoa('a value written in another data center') },
    };
    const authority = await authorityOf(scopeId, { current });
    const answer = { release: (): void => undefined };
    const answered = new Promise<void>((resolve) => {
      answer.release = resolve;
    });
    const slow: FetchLike = async (request) => {
      await answered;
      return authority.fetchImpl(request);
    };
    const host = hostOf(scopeId, slow);
    const behind: Promise<unknown>[] = [];
    const read = inRequest(
      async () => host.getNewerData?.({ key: KEY, kind: 'data:fetch' }, JUDGED_REVISION),
      NOW,
      behind,
    );
    await vi.waitFor(() => {
      expect(behind).toHaveLength(1);
    });
    const later = { generationId: 'generation-here', revision: 10 };

    await write(scopeId, { written: taken(later) }, { base64: btoa('a value written here since') });
    answer.release();
    await read;
    await Promise.all(behind);

    await expect(readElsewhere(scopeId)).resolves.toMatchObject({
      generationId: 'generation-here',
      dependencyRevision: 10,
    });
  });

  it('keeps the authority’s answer over the copy of an earlier value', async () => {
    const scopeId = scopeOfItsOwn();
    // The copy of a write at the revision the read judged: no later than it.
    await write(scopeId, {});
    const current = {
      entryId: await entryIdOf(scopeId),
      generationId: 'generation-elsewhere',
      dependencyRevision: 9,
      entry: { ...entryOf(), dependencyCoverage: 'complete' },
      value: { kind: 'inline', base64: btoa('a value written in another data center') },
    };
    const host = hostOf(scopeId, (await authorityOf(scopeId, { current })).fetchImpl);
    const behind: Promise<unknown>[] = [];

    await inRequest(
      async () => host.getNewerData?.({ key: KEY, kind: 'data:fetch' }, JUDGED_REVISION),
      NOW,
      behind,
    );
    await Promise.all(behind);

    await expect(readElsewhere(scopeId)).resolves.toStrictEqual(current);
  });

  it('answers nothing where the authority holds the read’s value, or none, or no such route', async () => {
    const scopeId = scopeOfItsOwn();
    const atTheRead = {
      entryId: await entryIdOf(scopeId),
      generationId: 'generation-read',
      dependencyRevision: 7,
      entry: { ...entryOf(), dependencyCoverage: 'complete' },
      value: { kind: 'inline', base64: btoa('the value the read judged') },
    };
    const read = async (answers: AuthorityAnswers): Promise<unknown> =>
      laterThanJudged(hostOf(scopeId, (await authorityOf(scopeId, answers)).fetchImpl));

    // An authority from before `than` answers with the value it holds, whatever its revision.
    await expect(read({ current: atTheRead })).resolves.toBeUndefined();
    // An authority from before the route answers a 404 of its own, as for no value.
    await expect(read({})).resolves.toBeUndefined();
    // Nothing was kept for the next isolate to find.
    await expect(read({})).resolves.toBeUndefined();
  });

  it('keeps the invalidation the authority answered the write with, for the runtime to judge', async () => {
    const scopeId = scopeOfItsOwn();
    const invalidation = { revision: 6, staleAt: NOW - 1 };
    await write(scopeId, { written: taken({ invalidation }) });

    await expect(readElsewhere(scopeId)).resolves.toMatchObject({ invalidation });
  });

  it('keeps no copy of a write the authority refused, or kept a later one over', async () => {
    const refusedScope = scopeOfItsOwn();
    const supersededScope = scopeOfItsOwn();

    await expect(write(refusedScope, { written: 'refused' })).rejects.toThrow(
      'the scope is retired',
    );

    await write(supersededScope, { written: taken({ superseded: true }) });

    await expect(readElsewhere(refusedScope)).resolves.toBeUndefined();
    await expect(readElsewhere(supersededScope)).resolves.toBeUndefined();
  });

  /**
   * The answer to a write the authority kept a later write of its writer over names that write by
   * its revision. Its copy may never have been kept — its answer lost, or its turn not come in time —
   * and a read KV answers with none would be answered with the copy of an earlier value otherwise.
   */
  it('lets go of the copy of a value earlier than the write kept over it, and of no other', async () => {
    const earlier = scopeOfItsOwn();
    const kept = scopeOfItsOwn();
    const later = { generationId: 'generation-later', revision: 9 };
    // The copy of an earlier write of the key, at the revision a write here is taken at.
    await write(earlier, {});
    // The copy of the later write itself.
    await write(kept, { written: taken(later) });

    await write(earlier, { written: taken({ ...later, superseded: true }) });
    await write(kept, { written: taken({ ...later, superseded: true }) });

    await expect(readElsewhere(earlier)).resolves.toBeUndefined();
    await expect(readElsewhere(kept)).resolves.toMatchObject({
      generationId: 'generation-later',
      dependencyRevision: 9,
    });
  });

  it('keeps no copy of a value too large to be read back whole', async () => {
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {}, { base64: 'A'.repeat(MIB) });

    await expect(readElsewhere(scopeId)).resolves.toBeUndefined();
  });

  /** What the authority withdraws (`retireExpiredData`) is none in the copy either. */
  it('finds none past the expire it was written with, or its invalidation’s hard expiry', async () => {
    const expiring = scopeOfItsOwn();
    const condemned = scopeOfItsOwn();
    const hardExpireAt = NOW + 5 * MS_PER_SECOND;
    await write(expiring, {}, { entry: entryOf({ expire: 60 }) });
    await write(condemned, { written: taken({ invalidation: { revision: 8, hardExpireAt } }) });

    await expect(readElsewhere(expiring, { now: NOW + 59 * MS_PER_SECOND })).resolves.toMatchObject(
      { generationId: 'generation-written' },
    );
    await expect(
      readElsewhere(expiring, { now: NOW + 60 * MS_PER_SECOND }),
    ).resolves.toBeUndefined();
    await expect(readElsewhere(condemned, { now: hardExpireAt })).resolves.toBeUndefined();
  });

  it('keeps no copy of a value the authority would have withdrawn already', async () => {
    const scopeId = scopeOfItsOwn();
    await write(
      scopeId,
      {},
      { entry: entryOf({ timestamp: NOW - 61 * MS_PER_SECOND, expire: 60 }) },
    );

    await expect(readElsewhere(scopeId)).resolves.toBeUndefined();
  });

  /**
   * A later value the authority took and the copies cannot hold lets the earlier copy go: a read KV
   * answers with none would be answered with that earlier value otherwise.
   */
  it('lets go of the copy of an earlier value when a later one cannot be copied', async () => {
    const tooLarge = scopeOfItsOwn();
    const withdrawn = scopeOfItsOwn();
    await write(tooLarge, {});
    await write(withdrawn, {});
    const later = taken({ generationId: 'generation-later', revision: 8 });

    await expect(readElsewhere(tooLarge)).resolves.toMatchObject({
      generationId: 'generation-written',
    });

    await write(tooLarge, { written: later }, { base64: 'A'.repeat(MIB) });
    await write(
      withdrawn,
      { written: later },
      { entry: entryOf({ timestamp: NOW - 61 * MS_PER_SECOND, expire: 60 }) },
    );

    await expect(readElsewhere(tooLarge)).resolves.toBeUndefined();
    await expect(readElsewhere(withdrawn)).resolves.toBeUndefined();
  });

  /** Read past its withdrawal, a copy is found only to be put aside: it goes when the value does. */
  it('keeps a copy no longer than until the authority withdraws its value', async () => {
    const kept: string[] = [];
    const open = caches.open.bind(caches);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
      const cache = await open(name);
      return {
        put: async (key: RequestInfo | URL, response: Response) => {
          kept.push(response.headers.get('cache-control') ?? '');
          await cache.put(key, response);
        },
      } as unknown as Cache;
    });

    await write(scopeOfItsOwn(), {}, { entry: entryOf({ expire: 5 }) });
    await write(scopeOfItsOwn(), {});

    expect(kept).toStrictEqual(['max-age=5', 'max-age=60']);
  });

  it('lets go of the copy of an earlier value when the Cache API refuses a later one', async () => {
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {});
    const open = caches.open.bind(caches);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
      const cache = await open(name);
      return {
        put: () => Promise.reject(new Error('the Cache API is out of room')),
        delete: async (key: RequestInfo | URL) => cache.delete(key),
      } as unknown as Cache;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said, and not what this test reads.
    });

    await write(scopeId, { written: taken({ generationId: 'generation-later', revision: 8 }) });
    vi.restoreAllMocks();

    await expect(readElsewhere(scopeId)).resolves.toBeUndefined();
  });

  it('finds no copy kept under another token', async () => {
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {});

    await expect(readElsewhere(scopeId, { token: 'another-scope-token' })).resolves.toBeUndefined();
  });

  it('gives up on a copy that does not answer in time, as on one that is not there', async () => {
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {});
    const late = Promise.withResolvers<undefined>();
    const open = caches.open.bind(caches);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
      const cache = await open(name);
      return {
        match: async (key: RequestInfo | URL) => {
          await late.promise;
          return cache.match(key);
        },
      } as unknown as Cache;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const read = await timedRead(scopeId);

    expect(read.answer).toBeUndefined();
    // As long as a read waits on the copy (`DATA_COPY_READ_MS`), and no longer: the clock moves a
    // millisecond at a time, from before the copy is asked.
    expect(read.waited).toBeGreaterThanOrEqual(100);
    expect(read.waited).toBeLessThanOrEqual(110);

    late.resolve(undefined);
  });

  /** One budget for the lookup and the body: a body slow after a slow lookup gets what is left. */
  it('gives up on a copy whose body is slow, within the one budget its lookup took from', async () => {
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {});
    const open = caches.open.bind(caches);
    vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
      const cache = await open(name);
      return {
        match: async (key: RequestInfo | URL) => {
          const found = await cache.match(key);
          await new Promise((resolve) => {
            setTimeout(resolve, 90);
          });
          // The record's first bytes, and nothing after them.
          const stalled = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"entryId":'));
            },
          });
          await found?.body?.cancel();
          return new Response(stalled);
        },
      } as unknown as Cache;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const read = await timedRead(scopeId);

    expect(read.answer).toBeUndefined();
    expect(read.waited).toBeGreaterThanOrEqual(100);
    expect(read.waited).toBeLessThanOrEqual(110);
  });
});

/**
 * A read of a delivery record answered as `length` bytes long, whose body comes only once it is
 * let go: the room it takes in the isolate's budget is held until then.
 */
function stalledRecordRead(length: number) {
  const begun = Promise.withResolvers<undefined>();
  const stalled = Promise.withResolvers<undefined>();
  const answer = (): Response => {
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          begun.resolve(undefined);
          await stalled.promise;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { headers: { 'content-length': String(length) } });
  };
  return {
    answer,
    begun: begun.promise,
    letGo: () => {
      stalled.resolve(undefined);
    },
  };
}

/** Whether a read found the copy of `base64`, none, or another value: said short. */
function foundOf(found: unknown, base64: string): string {
  if (found === undefined) {
    return 'none';
  }
  const value = (found as { readonly value?: { readonly base64?: string } }).value;
  return value?.base64 === base64 ? 'the copy' : 'another value';
}

/** The isolate's room left once a record read holds `HOLDING` of its 32 MiB: half a MiB. */
const HOLDING = 31.5 * MIB;

/**
 * What another isolate of the data center, whose KV has none of the key, reads of the copy of
 * `base64` while a record read holds `HOLDING` of the isolate's room, its body stalled — `times`
 * reads one after another — and once that read is done.
 */
async function readBeside(scopeId: string, base64: string, times = 1) {
  const read = stalledRecordRead(HOLDING);
  const authority = await authorityOf(scopeId);
  const host = hostOf(scopeId, async (request) => {
    const { pathname } = new URL(request.url);
    return pathname.endsWith('/record') ? read.answer() : authority.fetchImpl(request);
  });
  const get = async (): Promise<string> =>
    foundOf(await host.getData({ key: KEY, kind: 'data:fetch' }), base64);
  return inRequest(async () => {
    const reading = host.readRecord('an entry');
    // Its room is taken before its body is asked for.
    await read.begun;
    const meanwhile: string[] = [];
    for (let index = 0; index < times; index += 1) {
      meanwhile.push(await get());
    }
    read.letGo();
    await reading;
    return { meanwhile, after: await get() };
  });
}

/** Have the data center's copies answer without saying how long they are. */
function copiesSayingNoLength(): void {
  const open = caches.open.bind(caches);
  vi.spyOn(caches, 'open').mockImplementation(async (name: string) => {
    const cache = await open(name);
    const spied = {
      match: async (key: RequestInfo | URL) => {
        const hit = await cache.match(key);
        if (hit === undefined) {
          return hit;
        }
        const headers = new Headers(hit.headers);
        headers.delete('content-length');
        return new Response(hit.body, { headers });
      },
    };
    return spied as unknown as Cache;
  });
}

/**
 * A copy is read whole, and every read KV has none for reads one: an isolate reads no more of them
 * at once than it has room for, in the 32 MiB it reads records and artifacts in. A copy waits for
 * its room no longer than its read is given.
 */
describe('the room an isolate reads copies of values in', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is waited for, and a copy that has none in time is not read', async () => {
    const base64 = 'A'.repeat(600 * 1024);
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {}, { base64 });

    // A copy of some 600 KiB would not fit in the half MiB left.
    const read = await readBeside(scopeId, base64);

    expect(read).toStrictEqual({ meanwhile: ['none'], after: 'the copy' });
  });

  it('is given back once a copy is read, for the reads after it', async () => {
    const base64 = 'A'.repeat(200 * 1024);
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {}, { base64 });

    // Three copies of some 200 KiB in the half MiB left: past it, had each kept its room.
    const read = await readBeside(scopeId, base64, 3);

    expect(read).toStrictEqual({
      meanwhile: ['the copy', 'the copy', 'the copy'],
      after: 'the copy',
    });
  });

  it('is the length a copy says, so that a short one is read beside a long read', async () => {
    const base64 = btoa('the value a render fetched');
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {}, { base64 });

    const read = await readBeside(scopeId, base64);

    expect(read).toStrictEqual({ meanwhile: ['the copy'], after: 'the copy' });
  });

  it('is the most a copy is read for where the copy does not say its length', async () => {
    const base64 = btoa('the value a render fetched');
    const scopeId = scopeOfItsOwn();
    await write(scopeId, {}, { base64 });
    copiesSayingNoLength();

    // 1 MiB would not fit in the half MiB left.
    const read = await readBeside(scopeId, base64);

    expect(read).toStrictEqual({ meanwhile: ['none'], after: 'the copy' });
  });
});
