import {
  type DecodedGenerationPack,
  kvGenerationKey,
  MAX_TAG_LENGTH,
} from '@stayingupwind/core/cache';
import { parseScopeRevision, SCOPE_REVISION_HEADER } from '@stayingupwind/core/paas';
import {
  MAX_RECENT_INVALIDATIONS,
  type ScopeSignals,
  type TagDeltaEntry,
} from '@stayingupwind/host/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { condemnationOf } from '../src/cache/condemned.ts';
import { decideGeneration } from '../src/cache/decision.ts';
import { lookAtScope, withScopeRevision } from '../src/cache/scope-signal.ts';
import type { EdgeHost, ScopeSignalSource } from '../src/edge-host.ts';
import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';

/**
 * Where a scope stands, as every isolate of the edge comes to know it (`cache/scope-signal.ts`): the
 * authority's answer taken in and kept as the data center's copy, which another isolate takes in
 * without asking; a copy gone — purged — asked again, and one nothing purges once it is a moment
 * old, behind the request, which waits for neither, by one isolate of the data center at a time.
 * What a window allows goes to the Function rather than being served, and the Functions are told
 * where the scope stands.
 *
 * Run inside workerd, since the Cache API is what is under test. Each test keeps its copies in a
 * cache of its own, and a runtime made afresh stands for another isolate of the data center.
 */

const SECOND = 1000;
/**
 * How many scopes, each with every tag invalidated, fill what an isolate holds of invalidations (a
 * MiB, at 64 bytes a scope): one more forgets the oldest.
 */
const SCOPES_FILLING_MEMORY = 16_384;

function scopeOfItsOwn(): string {
  return `dpl_${crypto.randomUUID().replaceAll('-', '')}`;
}

function now(): number {
  return Date.now();
}

function runtimeOf(): EdgeRuntime {
  return {
    fetchImpl: (request) => fetch(request),
    now,
    memory: createEdgeMemory(now),
    dispatchApp: undefined,
    transformImage: undefined,
    blobWorker: undefined,
  };
}

function hostOf(signalCache: string, source: ScopeSignalSource | undefined): EdgeHost {
  return {
    names: {
      cacheKeyHost: 'cache.test.invalid',
      assetCache: 'assets',
      imageCache: 'images',
      imageKeyOrigin: 'https://images.test.invalid',
      recordCache: 'records',
      signalCache,
    },
    sharedDomain: 'invalid',
    ownDomains: [],
    credentials: { cookies: [], headers: [] },
    functionGone: () => false,
    observer: { metric: vi.fn(), recordServed: vi.fn(), imageTransformed: vi.fn() },
    ...(source !== undefined && { scopeSignals: source }),
  };
}

function tagged(value: string, revision: number, hardExpireAt: number | null): TagDeltaEntry {
  return {
    tagId: `tag-${value}`,
    kind: 'next-explicit',
    value,
    revision,
    staleAt: Date.now() - SECOND,
    hardExpireAt,
    meaning: hardExpireAt === null ? 'swr' : 'immediate',
  };
}

interface Authority {
  readonly source: ScopeSignalSource;
  readonly asked: () => number;
}

/** The authority, answering `signals` for every question, each held until `gate` resolves. */
function authority(
  signals: () => ScopeSignals,
  gate: Promise<unknown> = Promise.resolve(),
): Authority {
  let asked = 0;
  return {
    asked: () => asked,
    source: {
      scopeSignals: async () => {
        asked += 1;
        await gate;
        return signals();
      },
      cacheTagOf: (scopeId) => `test-signal-${scopeId}`,
    },
  };
}

/**
 * The purge of a scope's signal tag: what carries it goes — the data center's copy, and the claim
 * of the question that brought it.
 */
async function purge(cache: string, scopeId: string): Promise<void> {
  const copies = await caches.open(cache);
  const key = `https://cache.test.invalid/scope-signals/${scopeId}`;
  await Promise.all([copies.delete(key), copies.delete(`${key}/claim`)]);
}

/** A look at the scope, and whatever it left behind once that has settled. */
async function look(
  runtime: EdgeRuntime,
  host: EdgeHost,
  scopeId: string,
  behind: Promise<unknown>[] = [],
): Promise<void> {
  const waitUntil = (work: Promise<unknown>): void => {
    behind.push(work);
  };
  await lookAtScope({ runtime, host, waitUntil }, scopeId);
}

/** A record of the scope carrying `tag`, written at `revision`, as far as a judgement reads it. */
function recordOf(scopeId: string, tag: string, revision: number): DecodedGenerationPack {
  return {
    header: {
      scopeId,
      entryId: `entry-${tag}`,
      revision,
      status: 200,
      tags: [{ kind: 'next-explicit', value: tag }],
      policy: {
        revalidateAfter: { kind: 'never' },
        expireAfter: { kind: 'never' },
        clientStale: { kind: 'unknown' },
        source: 'build-output',
      },
      cacheTimestamp: Date.now() - 10 * SECOND,
    },
  } as unknown as DecodedGenerationPack;
}

/** Where a scope stands that nothing was invalidated in. */
const UNMOVED: ScopeSignals = {
  revision: 1,
  invalidatedAt: null,
  tags: [],
  truncated: false,
  announced: true,
};

/** A record as a read of it loads. */
function loaded(pack: DecodedGenerationPack) {
  return { kind: 'generation', pack, source: 'kv', readBytes: 1, lookupMs: 0 } as const;
}

describe('where a scope stands, as the edge comes to know it', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is asked of the authority, taken in, and kept for the data center’s other isolates', async () => {
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const answered = authority(() => {
      return {
        revision: 5,
        invalidatedAt: Date.now(),
        tags: [tagged('posts', 5, Date.now() - SECOND)],
        truncated: false,
        announced: true,
      };
    });
    const first = runtimeOf();
    const other = runtimeOf();
    const behind: Promise<unknown>[] = [];

    await look(first, hostOf(cache, answered.source), scopeId, behind);
    await Promise.all(behind);
    await look(other, hostOf(cache, answered.source), scopeId);

    expect(answered.asked()).toBe(1);

    for (const isolate of [first, other]) {
      expect(isolate.memory.invalidations.of(scopeId)?.tags.get('posts')).toBe(5);
      expect(isolate.memory.scopes.get(scopeId)?.revision).toBe(5);
    }
  });

  it('is asked again where the copy the data center had is gone', async () => {
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    let revision = 5;
    const answered = authority(() => {
      return {
        revision,
        invalidatedAt: Date.now(),
        tags: [tagged('posts', revision, Date.now() - SECOND)],
        truncated: false,
        announced: true,
      };
    });
    const behind: Promise<unknown>[] = [];
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId, behind);
    await Promise.all(behind);

    revision = 9;
    await purge(cache, scopeId);
    const next = runtimeOf();
    const asked: Promise<unknown>[] = [];
    await look(next, hostOf(cache, answered.source), scopeId, asked);
    await Promise.all(asked);

    expect(answered.asked()).toBe(2);
    expect(next.memory.invalidations.of(scopeId)?.tags.get('posts')).toBe(9);
  });

  /**
   * As many invalidations as the authority tells of, of tags as long as a tag may be in the
   * characters JSON writes longest: well past 64 KiB as the data center keeps it, and taken in from
   * that copy by an isolate that does not ask, as any other answer is.
   */
  it('is taken in from the copy however long an answer of the authority’s is', async () => {
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const tags = Array.from({ length: MAX_RECENT_INVALIDATIONS }, (_, index) => {
      const name = String(index).padStart(3, '0');
      const value = `${name}${'\0'.repeat(MAX_TAG_LENGTH - name.length)}`;
      return { ...tagged(value, index + 1, Date.now() - SECOND), tagId: `tag_${name}` };
    });
    const signals: ScopeSignals = {
      revision: MAX_RECENT_INVALIDATIONS,
      invalidatedAt: Date.now(),
      tags,
      truncated: false,
      announced: true,
    };
    const answered = authority(() => signals);
    const behind: Promise<unknown>[] = [];
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId, behind);
    await Promise.all(behind);
    const other = runtimeOf();
    await look(other, hostOf(cache, answered.source), scopeId);

    expect(new TextEncoder().encode(JSON.stringify(signals)).byteLength).toBeGreaterThan(65_536);
    expect(other.memory.scopes.get(scopeId)?.revision).toBe(MAX_RECENT_INVALIDATIONS);
    expect(answered.asked()).toBe(1);
  });

  /** A copy that cannot be read is none, as one that is gone is. */
  it('is asked where the copy the data center has cannot be read', async () => {
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const copies = await caches.open(cache);
    const keptAt = String(Date.now());
    const unreadable = new Response('not the signals', {
      headers: { 'cache-control': 'max-age=3600', 'x-arkor-kept-at': keptAt },
    });
    await copies.put(`https://cache.test.invalid/scope-signals/${scopeId}`, unreadable);
    const answered = authority(() => ({ ...UNMOVED, revision: 5 }));
    const runtime = runtimeOf();
    const behind: Promise<unknown>[] = [];

    await look(runtime, hostOf(cache, answered.source), scopeId, behind);
    await Promise.all(behind);

    expect(answered.asked()).toBe(1);
    expect(runtime.memory.scopes.get(scopeId)?.revision).toBe(5);
  });

  /**
   * A purge takes the claim of the question with the copy (`claimQuestion`): an isolate that left
   * the question to another's claim asks itself once the copy is gone, rather than once the claim
   * it saw would have lapsed.
   */
  it('is asked at once once a purge took the claim it left the question to', async () => {
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const never = Promise.withResolvers<true>();
    const answered = authority(() => ({ ...UNMOVED, revision: 5 }), never.promise);
    const host = hostOf(cache, answered.source);
    const firstBehind: Promise<unknown>[] = [];
    await look(runtimeOf(), host, scopeId, firstBehind);
    await vi.waitFor(() => {
      expect(answered.asked()).toBe(1);
    });
    const other = runtimeOf();
    const leftBehind: Promise<unknown>[] = [];
    await look(other, host, scopeId, leftBehind);
    await Promise.all(leftBehind);

    await purge(cache, scopeId);
    const askedBehind: Promise<unknown>[] = [];
    await look(other, host, scopeId, askedBehind);

    await vi.waitFor(() => {
      expect(answered.asked()).toBe(2);
    });
    never.resolve(true);
    await Promise.all(firstBehind);
    await Promise.all(askedBehind);
  });

  it('is not waited for by the request that asks', async () => {
    const scopeId = scopeOfItsOwn();
    const gate = Promise.withResolvers<true>();
    const answered = authority(() => {
      return {
        revision: 5,
        invalidatedAt: Date.now(),
        tags: [],
        truncated: false,
        announced: true,
      };
    }, gate.promise);
    const runtime = runtimeOf();
    const behind: Promise<unknown>[] = [];

    await look(runtime, hostOf(`signals-${crypto.randomUUID()}`, answered.source), scopeId, behind);
    const before = runtime.memory.scopes.get(scopeId);
    gate.resolve(true);
    await Promise.all(behind);

    expect(before).toBeUndefined();
    expect(runtime.memory.scopes.get(scopeId)?.revision).toBe(5);
  });

  it('is asked again behind the request once a copy nothing purges is a moment old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_000_000);
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const answered = authority(() => {
      return {
        revision: 5,
        invalidatedAt: Date.now(),
        tags: [],
        truncated: false,
        announced: false,
      };
    });
    const behind: Promise<unknown>[] = [];
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId, behind);
    await Promise.all(behind);

    vi.setSystemTime(1_790_000_000_000 + 2 * SECOND);
    const later: Promise<unknown>[] = [];
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId, later);
    await Promise.all(later);

    expect(answered.asked()).toBe(2);
  });

  /**
   * A purge that did not get through, or a host that has stopped purging, whose copies still say it
   * does, is made up for within the minute rather than the copy's hour.
   */
  it('is asked again behind the request once a copy the host purges is a minute old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_000_000);
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const answered = authority(() => UNMOVED);
    const behind: Promise<unknown>[] = [];
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId, behind);
    await Promise.all(behind);

    vi.setSystemTime(1_790_000_000_000 + 59 * SECOND);
    const early: Promise<unknown>[] = [];
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId, early);
    await Promise.all(early);
    const beforeTheMinute = answered.asked();
    vi.setSystemTime(1_790_000_000_000 + 60 * SECOND);
    const late: Promise<unknown>[] = [];
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId, late);
    await Promise.all(late);

    expect(beforeTheMinute).toBe(1);
    expect(answered.asked()).toBe(2);
  });

  it('is not waited for past a moment where the Cache API does not answer', async () => {
    const stalled = {
      match: () =>
        new Promise<never>(() => {
          // The lookup never answers.
        }),
      put: () => Promise.resolve(),
    };
    vi.spyOn(caches, 'open').mockResolvedValue(stalled as unknown as Cache);
    // The question never answers either: nothing it would keep outlives the test.
    const never = new Promise<never>(() => {
      // The authority never answers.
    });
    const answered = authority(() => UNMOVED, never);
    const host = hostOf(`signals-${crypto.randomUUID()}`, answered.source);
    const looking = look(runtimeOf(), host, scopeOfItsOwn());
    const timedOut = Symbol('timed out');

    const looked = await Promise.race([
      looking,
      new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => {
          resolve(timedOut);
        }, SECOND);
      }),
    ]);

    expect(looked).toBeUndefined();
  });

  it('takes away again a copy whose write ended too late for the second purge to reach it', async () => {
    const deleted: string[] = [];
    const slow = {
      match: () => Promise.resolve(undefined),
      put: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1600);
        });
      },
      delete: (key: string) => {
        deleted.push(key);
        return Promise.resolve(true);
      },
    };
    vi.spyOn(caches, 'open').mockResolvedValue(slow);
    const scopeId = scopeOfItsOwn();
    const answered = authority(() => UNMOVED);
    const host = hostOf(`signals-${crypto.randomUUID()}`, answered.source);
    const behind: Promise<unknown>[] = [];

    await look(runtimeOf(), host, scopeId, behind);
    await Promise.all(behind);

    expect(deleted).toStrictEqual([`https://cache.test.invalid/scope-signals/${scopeId}`]);
  });

  it('is not written once the question’s claim lapsed while the copy there was looked at', async () => {
    const puts: string[] = [];
    // Whatever the key holds says nothing of the scope, and takes past the claim to come back.
    const slowLook = {
      match: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1100);
        });
        return new Response('says nothing');
      },
      put: (key: string) => {
        puts.push(key);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(true),
    };
    vi.spyOn(caches, 'open').mockResolvedValue(slowLook);
    const scopeId = scopeOfItsOwn();
    const answered = authority(() => UNMOVED);
    const host = hostOf(`signals-${crypto.randomUUID()}`, answered.source);
    const behind: Promise<unknown>[] = [];

    await look(runtimeOf(), host, scopeId, behind);
    await Promise.all(behind);

    expect(answered.asked()).toBe(1);
    expect(puts).not.toContain(`https://cache.test.invalid/scope-signals/${scopeId}`);
  });

  it('is not taken back by an answer that comes back after a later one was kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_000_000);
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const late = Promise.withResolvers<true>();
    const slow = authority(() => ({ ...UNMOVED, revision: 5 }), late.promise);
    const fast = authority(() => ({ ...UNMOVED, revision: 9 }));
    const lateBehind: Promise<unknown>[] = [];
    const fastBehind: Promise<unknown>[] = [];

    // One isolate's question is out past its claim; another's is answered, and kept, meanwhile.
    await look(runtimeOf(), hostOf(cache, slow.source), scopeId, lateBehind);
    await vi.waitFor(() => {
      expect(slow.asked()).toBe(1);
    });
    vi.setSystemTime(1_790_000_000_000 + 2 * SECOND);
    await look(runtimeOf(), hostOf(cache, fast.source), scopeId, fastBehind);
    await Promise.all(fastBehind);
    late.resolve(true);
    await Promise.all(lateBehind);
    const another = runtimeOf();
    await look(another, hostOf(cache, fast.source), scopeId);

    expect(another.memory.scopes.get(scopeId)?.revision).toBe(9);
  });

  it('is asked by one isolate of a data center at a time, the others leaving the question to it', async () => {
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const gate = Promise.withResolvers<true>();
    const answered = authority(() => ({ ...UNMOVED, revision: 5 }), gate.promise);
    const firstBehind: Promise<unknown>[] = [];
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId, firstBehind);
    await vi.waitFor(() => {
      expect(answered.asked()).toBe(1);
    });

    // The question is out: the data center's other isolates find no copy, and the claim.
    const othersBehind: Promise<unknown>[] = [];
    for (const other of [runtimeOf(), runtimeOf()]) {
      await look(other, hostOf(cache, answered.source), scopeId, othersBehind);
    }
    gate.resolve(true);
    await Promise.all(firstBehind);
    await Promise.all(othersBehind);
    const later = runtimeOf();
    await look(later, hostOf(cache, answered.source), scopeId);

    expect(answered.asked()).toBe(1);
    expect(later.memory.scopes.get(scopeId)?.revision).toBe(5);
  });

  it('shares a question across request runtimes that serve the same isolate memory', async () => {
    // The Cache API has no compare-and-set: every concurrent claim may find nothing. The
    // isolate's own single flight must hold even where the data center's claim cannot help.
    const copies = {
      match: () => Promise.resolve(),
      put: () => Promise.resolve(),
    };
    vi.spyOn(caches, 'open').mockResolvedValue(copies as unknown as Cache);
    const scopeId = scopeOfItsOwn();
    const gate = Promise.withResolvers<true>();
    const answered = authority(() => ({ ...UNMOVED, revision: 5 }), gate.promise);
    const host = hostOf(`signals-${crypto.randomUUID()}`, answered.source);
    const isolate = runtimeOf();
    const behind: Promise<unknown>[] = [];

    try {
      await Promise.all(
        Array.from({ length: 8 }, () => look({ ...isolate }, host, scopeId, behind)),
      );
      await vi.waitFor(() => {
        expect(answered.asked()).toBe(1);
      });

      // Every request returned while the authority still had no answer, whose I/O remains
      // owned by the request that asked and is kept alive by that request's waitUntil.
      expect(isolate.memory.scopes.get(scopeId)).toBeUndefined();
      expect(behind).toHaveLength(1);
    } finally {
      gate.resolve(true);
      await Promise.all(behind);
    }

    expect(isolate.memory.scopes.get(scopeId)?.revision).toBe(5);
  });

  it('keeps questions for different scopes or authorities separate in shared memory', async () => {
    const copies = {
      match: () => Promise.resolve(),
      put: () => Promise.resolve(),
    };
    vi.spyOn(caches, 'open').mockResolvedValue(copies as unknown as Cache);
    const scopeId = scopeOfItsOwn();
    const gate = Promise.withResolvers<true>();
    const first = authority(() => UNMOVED, gate.promise);
    const other = authority(() => UNMOVED, gate.promise);
    const isolate = runtimeOf();
    const cache = `signals-${crypto.randomUUID()}`;
    const behind: Promise<unknown>[] = [];

    try {
      await Promise.all([
        look({ ...isolate }, hostOf(cache, first.source), scopeId, behind),
        look({ ...isolate }, hostOf(cache, first.source), scopeOfItsOwn(), behind),
        look({ ...isolate }, hostOf(cache, other.source), scopeId, behind),
      ]);
      await vi.waitFor(() => {
        expect(first.asked()).toBe(2);
        expect(other.asked()).toBe(1);
      });
    } finally {
      gate.resolve(true);
      await Promise.all(behind);
    }
  });

  it('retries a failed question from the next request runtime sharing its memory', async () => {
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const read = vi
      .fn<ScopeSignalSource['scopeSignals']>()
      .mockRejectedValueOnce(new Error('authority unavailable'))
      .mockResolvedValue({ ...UNMOVED, revision: 5 });
    const source: ScopeSignalSource = {
      scopeSignals: read,
      cacheTagOf: (id) => `test-signal-${id}`,
    };
    const host = hostOf(cache, source);
    const isolate = runtimeOf();
    const failed: Promise<unknown>[] = [];

    await look({ ...isolate }, host, scopeId, failed);
    await Promise.all(failed);
    await purge(cache, scopeId);
    const retried: Promise<unknown>[] = [];
    await look({ ...isolate }, host, scopeId, retried);
    await Promise.all(retried);

    expect(read).toHaveBeenCalledTimes(2);
    expect(isolate.memory.scopes.get(scopeId)?.revision).toBe(5);
  });

  it('is asked again once a question claimed has gone unanswered past its claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_000_000);
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const never = Promise.withResolvers<true>();
    const answered = authority(() => UNMOVED, never.promise);
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId);
    await vi.waitFor(() => {
      expect(answered.asked()).toBe(1);
    });

    vi.setSystemTime(1_790_000_000_000 + 2 * SECOND);
    await look(runtimeOf(), hostOf(cache, answered.source), scopeId);

    await vi.waitFor(() => {
      expect(answered.asked()).toBe(2);
    });
  });

  it('is asked of nobody where the host keeps no signals', async () => {
    const runtime = runtimeOf();

    await look(runtime, hostOf(`signals-${crypto.randomUUID()}`, undefined), scopeOfItsOwn());

    expect(runtime.memory.scopes.size).toBe(0);
  });
});

describe('what the authority says moved in a scope', () => {
  it('condemns a record an invalidation reached at once, and leaves one with a window to the Function', async () => {
    const scopeId = scopeOfItsOwn();
    const answered = authority(() => {
      return {
        revision: 7,
        invalidatedAt: Date.now(),
        tags: [tagged('posts', 6, Date.now() - SECOND), tagged('feed', 7, null)],
        truncated: false,
        announced: true,
      };
    });
    const runtime = runtimeOf();
    const behind: Promise<unknown>[] = [];
    await look(runtime, hostOf(`signals-${crypto.randomUUID()}`, answered.source), scopeId, behind);
    await Promise.all(behind);
    const condemned = (pack: DecodedGenerationPack): ReturnType<typeof condemnationOf> =>
      condemnationOf(runtime.memory, pack);
    const windowed = recordOf(scopeId, 'feed', 5);
    const decision = decideGeneration(loaded(windowed), Date.now(), condemned);

    expect(condemned(recordOf(scopeId, 'posts', 5))).toBe('expired');
    expect(condemned(windowed)).toBe('stale');
    expect(condemned(recordOf(scopeId, 'feed', 7))).toBeUndefined();
    expect(decision).toMatchObject({ kind: 'passthrough', reason: 'invalidated' });
  });

  it('condemns a record from before an at-once invalidation of a tag a windowed one followed', async () => {
    const scopeId = scopeOfItsOwn();
    const answered = authority(() => {
      return {
        revision: 7,
        invalidatedAt: Date.now(),
        tags: [tagged('posts', 5, Date.now() - SECOND), tagged('posts', 7, null)],
        truncated: false,
        announced: true,
      };
    });
    const runtime = runtimeOf();
    const behind: Promise<unknown>[] = [];
    await look(runtime, hostOf(`signals-${crypto.randomUUID()}`, answered.source), scopeId, behind);
    await Promise.all(behind);
    const condemned = (pack: DecodedGenerationPack): ReturnType<typeof condemnationOf> =>
      condemnationOf(runtime.memory, pack);

    expect(condemned(recordOf(scopeId, 'posts', 4))).toBe('expired');
    expect(condemned(recordOf(scopeId, 'posts', 6))).toBe('stale');
    expect(condemned(recordOf(scopeId, 'posts', 7))).toBeUndefined();
  });

  /** Memory keeps a window's revision, not its end, and nothing new comes to say it ended. */
  it('condemns at once, from its end, what a window it was told of before reached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_000_000);
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const ends = Date.now() + 10 * SECOND;
    const answered = authority(() => {
      return {
        revision: 7,
        invalidatedAt: Date.now(),
        tags: [tagged('feed', 7, ends)],
        truncated: false,
        announced: true,
      };
    });
    const runtime = runtimeOf();
    const behind: Promise<unknown>[] = [];
    await look(runtime, hostOf(cache, answered.source), scopeId, behind);
    await Promise.all(behind);
    const during = condemnationOf(runtime.memory, recordOf(scopeId, 'feed', 5));

    vi.setSystemTime(ends + SECOND);
    await look(runtime, hostOf(cache, answered.source), scopeId);

    expect(during).toBe('stale');
    expect(condemnationOf(runtime.memory, recordOf(scopeId, 'feed', 5))).toBe('expired');
    expect(answered.asked()).toBe(1);
  });

  /**
   * An isolate short of room forgets the oldest scope's invalidations, a window's among them
   * (`InvalidationMemory`), and with them where the scope stands: the authority's next answer, the
   * same as the one it forgot, is taken in whole, and what the window reached is not served again.
   * Still short of room, the isolate folds what it took in into a floor, which condemns it at once.
   */
  it('condemns again what a window an isolate short of room forgot reached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_000_000);
    const scopeId = scopeOfItsOwn();
    const cache = `signals-${crypto.randomUUID()}`;
    const answered = authority(() => {
      return {
        revision: 7,
        invalidatedAt: Date.now(),
        tags: [tagged('feed', 7, null)],
        truncated: false,
        announced: true,
      };
    });
    const runtime = runtimeOf();
    const behind: Promise<unknown>[] = [];
    await look(runtime, hostOf(cache, answered.source), scopeId, behind);
    await Promise.all(behind);
    for (let other = 0; other < SCOPES_FILLING_MEMORY; other += 1) {
      runtime.memory.invalidations.take(`dpl_other${String(other)}`, undefined, 1);
    }
    const forgotten = runtime.memory.invalidations.of(scopeId);

    vi.setSystemTime(1_790_000_000_000 + SECOND);
    await look(runtime, hostOf(cache, answered.source), scopeId);

    expect(forgotten).toBeUndefined();
    expect(condemnationOf(runtime.memory, recordOf(scopeId, 'feed', 5))).toBe('expired');
    expect(condemnationOf(runtime.memory, recordOf(scopeId, 'feed', 7))).toBeUndefined();
  });

  it('lets go of a record held that a window reached, so it is read again rather than held', async () => {
    const scopeId = scopeOfItsOwn();
    const answered = authority(() => {
      return {
        revision: 7,
        invalidatedAt: Date.now(),
        tags: [tagged('feed', 7, null)],
        truncated: false,
        announced: true,
      };
    });
    const runtime = runtimeOf();
    const windowed = recordOf(scopeId, 'feed', 5);
    const untouched = recordOf(scopeId, 'posts', 5);
    for (const pack of [windowed, untouched]) {
      const key = kvGenerationKey(scopeId, pack.header.entryId);
      runtime.memory.generations.set(key, { pack, readAt: Date.now(), bytes: 1 }, 1);
    }
    const behind: Promise<unknown>[] = [];

    await look(runtime, hostOf(`signals-${crypto.randomUUID()}`, answered.source), scopeId, behind);
    await Promise.all(behind);

    expect(runtime.memory.generations.get(kvGenerationKey(scopeId, 'entry-feed'))).toBeUndefined();
    expect(runtime.memory.generations.get(kvGenerationKey(scopeId, 'entry-posts'))?.pack).toBe(
      untouched,
    );
  });

  it('tells the Functions where the scope stands, once the isolate knows', async () => {
    const scopeId = scopeOfItsOwn();
    const at = Date.now();
    const answered = authority(() => {
      return {
        revision: 7,
        invalidatedAt: at,
        tags: [],
        truncated: false,
        announced: true,
      };
    });
    const runtime = runtimeOf();
    const untold = withScopeRevision(runtime, scopeId, new Request('https://app.test/'));
    const behind: Promise<unknown>[] = [];
    await look(runtime, hostOf(`signals-${crypto.randomUUID()}`, answered.source), scopeId, behind);
    await Promise.all(behind);

    const told = withScopeRevision(runtime, scopeId, new Request('https://app.test/'));

    expect(untold.headers.has(SCOPE_REVISION_HEADER)).toBe(false);
    expect(parseScopeRevision(told.headers.get(SCOPE_REVISION_HEADER))).toStrictEqual({
      revision: 7,
      invalidatedAt: at,
    });
  });
});
