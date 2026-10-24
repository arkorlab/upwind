import {
  deriveEntry,
  encodeGenerationPack,
  type GenerationPackHeader,
  PACK_SCHEMA_VERSION,
  packBodyDigests,
  policyFromCacheControl,
} from '@stayingupwind/core/cache';
import { toBase64 } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { turnsOfRequest } from '../../../cache/src/function/artifacts.ts';
import { withClock } from '../../src/cache/clock.ts';
import type { CacheHost, FetchLike } from '../../src/cache/host.ts';
import { installRequestContext, withRequestContext } from '../../src/request-context.ts';
import { createCacheHost } from '../function-cache-host.ts';

/**
 * What a deployment's Worker keeps of the delivery records its commits wrote
 * (`upwind/packages/cache/src/function/record-copies.ts`): the authority hands a published commit
 * the record its settle wrote, and the Worker keeps it in its data center's Cache API, for another
 * isolate there to read where KV — whose cache goes on answering with the generation it replaced,
 * or with none — is behind it. And what the host says of the entry's generation when it answers a
 * lease.
 *
 * Run inside workerd, since the Cache API is what is under test. The authority is a stand-in for the
 * routes these calls take. Each test works under a scope of its own, so no copy one test keeps is
 * found by another. A host made afresh stands for another isolate in the same data center.
 */

const GATEWAY_URL = 'https://authority.test';
const TOKEN = 'test-scope-token';
const NOW = 1_790_000_000_000;
const PAGE = { kind: 'app-page', route: '/page', pathname: '/page' } as const;

/** Each scope's real page identity, as the authority derives it. */
async function pageEntryId(scopeId: string): Promise<string> {
  return (await deriveEntry(scopeId, PAGE)).entryId;
}
const POLICY = policyFromCacheControl({ revalidate: 60, expire: 3600 });

function scopeOfItsOwn(): string {
  return `scope-${crypto.randomUUID()}`;
}

/**
 * A delivery record of the page's generation `seq`, as the authority lays one out, at record
 * revision `revision`.
 */
async function recordOf(
  scopeId: string,
  seq: number,
  html: string,
  revision = seq,
): Promise<Uint8Array> {
  const body = new TextEncoder().encode(html);
  const header: GenerationPackHeader = {
    schemaVersion: PACK_SCHEMA_VERSION,
    scopeId,
    entryId: await pageEntryId(scopeId),
    generationId: `generation-${String(seq)}`,
    seq,
    source: 'runtime',
    kind: 'app-page',
    route: '/page',
    pathname: '/page',
    cacheTimestamp: NOW,
    producedAt: NOW,
    policy: POLICY,
    status: 200,
    headers: {},
    tags: [],
    ...(await packBodyDigests(body, undefined)),
    artifacts: [],
    revision,
  };
  return encodeGenerationPack(header, body, undefined);
}

interface AuthorityAnswers {
  /** The record a commit is answered with; none where left out. */
  readonly record?: Uint8Array;
  readonly seq?: number;
  /** Where no record is, the revision the authority says the entry's record stands at. */
  readonly recordRevision?: number;
  /** What a lease is answered with: held by this attempt, or by another. */
  readonly lease?: 'leased' | 'busy';
  /** The record a lease's answer carries, of a later generation than the one judged. */
  readonly leaseRecord?: Uint8Array;
  /** Where each lease asked for is told, as the authority reads it. */
  readonly asked?: unknown[];
  /** The commit's answer never comes: the authority fails it. */
  readonly commitLost?: boolean;
}

const CURRENT = {
  generationId: 'generation-4',
  seq: 4,
  cacheTimestamp: NOW,
  policy: POLICY,
  condemned: null,
  status: 200,
  location: null,
};

/** The authority's attempt routes, answered as `answers` says: each lease an attempt of its own. */
function authorityOf(scopeId: string, answers: AuthorityAnswers = {}): FetchLike {
  let attempts = 0;
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/fail')) {
      await request.body?.cancel();
      return Response.json({ ok: true, result: { regeneration: 'idle', nextRetryAt: null } });
    }
    if (pathname.endsWith('/commit') && answers.commitLost === true) {
      await request.body?.cancel();
      return Response.json(
        { ok: false, error: { code: 'internal', message: 'the commit was lost on the way' } },
        { status: 503 },
      );
    }
    if (pathname.endsWith('/commit')) {
      return Response.json({
        ok: true,
        result: {
          kind: 'published',
          generationId: `generation-${String(answers.seq ?? 1)}`,
          seq: answers.seq ?? 1,
          revision: 9,
          condemned: null,
          ...(answers.record !== undefined && { record: toBase64(answers.record) }),
          ...(answers.recordRevision !== undefined && { recordRevision: answers.recordRevision }),
        },
      });
    }
    if (pathname.endsWith('/attempts')) {
      if (answers.asked === undefined) {
        await request.body?.cancel();
      } else {
        answers.asked.push(await request.json());
      }
      attempts += 1;
      const carried =
        answers.leaseRecord === undefined ? {} : { record: toBase64(answers.leaseRecord) };
      return Response.json({
        ok: true,
        result:
          answers.lease === 'busy'
            ? {
                kind: 'busy',
                entryId: await pageEntryId(scopeId),
                attemptId: 'attempt-elsewhere',
                leaseExpiresAt: NOW + 60_000,
                current: CURRENT,
                ...carried,
              }
            : {
                kind: 'leased',
                attemptId: `attempt-${String(attempts)}`,
                entryId: await pageEntryId(scopeId),
                fencingToken: 1,
                dependencyRevision: 3,
                leaseExpiresAt: NOW + 60_000,
                current: CURRENT,
                ...carried,
              },
      });
    }
    return new Response('not an attempt route', { status: 500 });
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

/** Run `work` as the runtime runs a request, what it hands its `waitUntil` kept in `handed`. */
function inRequest<T>(work: () => Promise<T>, handed: Promise<unknown>[] = []): Promise<T> {
  installRequestContext();
  return withRequestContext(
    {
      headers: {},
      url: 'https://app.test/',
      waitUntil: (promise) => {
        handed.push(promise);
      },
    },
    async () => withClock(NOW, work),
  );
}

/** The page's generation, as a commit carries it. */
const COMMIT = {
  fencingToken: 1,
  observedTagRevision: 0,
  heldTagRevisions: {},
  generation: {
    cacheTimestamp: NOW,
    producedAt: NOW,
    policy: POLICY,
    status: 200,
    headers: {},
    tags: [],
    outputs: [],
    reason: 'expired',
  },
} as const;

/** A lease of the page. */
const PAGE_ATTEMPT = {
  entry: PAGE,
  reason: 'expired',
} as const;

/** A commit of the page's generation by one isolate, its answer carrying `answers`. */
function commit(scopeId: string, answers: AuthorityAnswers) {
  const host = hostOf(scopeId, authorityOf(scopeId, answers));
  return inRequest(async () => host.commit('attempt-1', COMMIT));
}

/** A lease of the page, then its commit, by one isolate, the authority answering as `answers` says. */
function leaseAndCommit(scopeId: string, answers: AuthorityAnswers) {
  const host = hostOf(scopeId, authorityOf(scopeId, answers));
  return inRequest(async () => {
    await host.startAttempt(PAGE_ATTEMPT);
    return host.commit('attempt-1', COMMIT);
  });
}

/** What another isolate of the data center finds later than generation `than`. */
function readElsewhere(
  scopeId: string,
  than: number,
  token = TOKEN,
): Promise<Uint8Array | undefined> {
  const host = hostOf(scopeId, authorityOf(scopeId), token);
  return inRequest(async () => host.readNewerRecord?.(await pageEntryId(scopeId), than));
}

describe('the records a deployment has published', () => {
  it('are handed back with the commit, and kept for another isolate of the data center', async () => {
    const scopeId = scopeOfItsOwn();
    const record = await recordOf(scopeId, 5, '<html>five</html>');

    const published = await commit(scopeId, { record, seq: 5 });

    expect(published).toStrictEqual({ kind: 'published', generationId: 'generation-5', record });
    await expect(readElsewhere(scopeId, 4)).resolves.toStrictEqual(record);
  });

  it('answer only a read of an earlier generation than the one kept', async () => {
    const scopeId = scopeOfItsOwn();
    await commit(scopeId, { record: await recordOf(scopeId, 5, '<html>five</html>'), seq: 5 });

    await expect(readElsewhere(scopeId, 5)).resolves.toBeUndefined();
    await expect(readElsewhere(scopeId, 6)).resolves.toBeUndefined();
  });

  it('keep nothing where the commit handed no record back', async () => {
    const scopeId = scopeOfItsOwn();

    const published = await commit(scopeId, { seq: 5 });

    expect(published).toStrictEqual({ kind: 'published', generationId: 'generation-5' });
    await expect(readElsewhere(scopeId, 0)).resolves.toBeUndefined();
  });

  it('keep nothing a commit handed back that is no record', async () => {
    const scopeId = scopeOfItsOwn();

    const published = await commit(scopeId, {
      record: new TextEncoder().encode('not a record'),
      seq: 5,
    });

    expect(published).toStrictEqual({ kind: 'published', generationId: 'generation-5' });
    await expect(readElsewhere(scopeId, 0)).resolves.toBeUndefined();
  });

  /** A settle writes the entry's record as it stands, which can be a later generation's. */
  it('are kept as the generation the record says it is, whatever the commit was answered', async () => {
    const scopeId = scopeOfItsOwn();
    const record = await recordOf(scopeId, 7, '<html>seven</html>');

    await commit(scopeId, { record, seq: 5 });

    await expect(readElsewhere(scopeId, 6)).resolves.toStrictEqual(record);
  });

  it('let the copy go where a later commit hands back no record of its own', async () => {
    const scopeId = scopeOfItsOwn();
    await commit(scopeId, { record: await recordOf(scopeId, 5, '<html>five</html>'), seq: 5 });

    await leaseAndCommit(scopeId, { seq: 6 });

    await expect(readElsewhere(scopeId, 0)).resolves.toBeUndefined();
  });

  it('let the copy go where a later commit is never answered, and may have published', async () => {
    const scopeId = scopeOfItsOwn();
    // A copy no later than the generation that stood when the lease was granted (`CURRENT`).
    await commit(scopeId, { record: await recordOf(scopeId, 3, '<html>three</html>'), seq: 3 });

    await expect(leaseAndCommit(scopeId, { commitLost: true })).rejects.toThrow(
      'the commit was lost on the way',
    );
    await expect(readElsewhere(scopeId, 0)).resolves.toBeUndefined();
  });

  /**
   * A commit said again is answered with no record where a change has rewritten its generation's
   * since — an invalidation's, its write still on its way: the copy from before it goes too.
   */
  it('let the copy of the same generation go where a commit of it hands back no record', async () => {
    const scopeId = scopeOfItsOwn();
    await commit(scopeId, { record: await recordOf(scopeId, 5, '<html>five</html>'), seq: 5 });

    await leaseAndCommit(scopeId, { seq: 5 });

    await expect(readElsewhere(scopeId, 0)).resolves.toBeUndefined();
  });

  /**
   * The authority says where the entry's record stands where it hands none back: a copy behind it
   * goes, and one of it — the rewrite another commit handed back meanwhile — stays.
   */
  it('let go of a copy behind the record a commit with none says stands, and keep one of it', async () => {
    const behindScope = scopeOfItsOwn();
    const standingScope = scopeOfItsOwn();
    const rewritten = await recordOf(standingScope, 5, '<html>five, invalidated</html>', 2);
    await commit(behindScope, {
      record: await recordOf(behindScope, 5, '<html>five</html>', 1),
      seq: 5,
    });
    await commit(standingScope, { record: rewritten, seq: 5 });

    await leaseAndCommit(behindScope, { seq: 5, recordRevision: 2 });
    await leaseAndCommit(standingScope, { seq: 5, recordRevision: 2 });

    await expect(readElsewhere(behindScope, 4)).resolves.toBeUndefined();
    await expect(readElsewhere(standingScope, 4)).resolves.toStrictEqual(rewritten);
  });

  it('leave a later copy where an earlier commit hands back no record after it', async () => {
    const scopeId = scopeOfItsOwn();
    const later = await recordOf(scopeId, 7, '<html>seven</html>');
    await commit(scopeId, { record: later, seq: 7 });

    await leaseAndCommit(scopeId, { seq: 6 });

    await expect(readElsewhere(scopeId, 0)).resolves.toStrictEqual(later);
  });

  /** An invalidation rewrites a generation's record at a later revision, its sequence the same. */
  it('are replaced by a later revision of their generation’s record, and not an earlier', async () => {
    const scopeId = scopeOfItsOwn();
    const first = await recordOf(scopeId, 5, '<html>five</html>', 1);
    const rewritten = await recordOf(scopeId, 5, '<html>five, invalidated</html>', 2);
    await commit(scopeId, { record: first, seq: 5 });

    await commit(scopeId, { record: rewritten, seq: 5 });
    await commit(scopeId, { record: first, seq: 5 });

    await expect(readElsewhere(scopeId, 4)).resolves.toStrictEqual(rewritten);
  });

  it('are not replaced by an earlier commit’s record that lands after them', async () => {
    const scopeId = scopeOfItsOwn();
    const later = await recordOf(scopeId, 7, '<html>seven</html>');
    await commit(scopeId, { record: later, seq: 7 });

    await commit(scopeId, { record: await recordOf(scopeId, 6, '<html>six</html>'), seq: 6 });

    await expect(readElsewhere(scopeId, 0)).resolves.toStrictEqual(later);
  });

  /**
   * A write waits half its second for the request's turn at the Cache API: one another write holds
   * past that keeps no copy, and lets an earlier one go all the same.
   */
  it('let an earlier copy go where the request’s write turn does not come in time', async () => {
    const scopeId = scopeOfItsOwn();
    await commit(scopeId, { record: await recordOf(scopeId, 5, '<html>five</html>'), seq: 5 });
    const record = await recordOf(scopeId, 6, '<html>six</html>');
    const host = hostOf(scopeId, authorityOf(scopeId, { record, seq: 6 }));

    const held = await inRequest(async () => {
      // Another write of the request's holds its one turn throughout.
      const writes = turnsOfRequest()?.writes;
      const taken = await writes?.take(0);
      try {
        await host.commit('attempt-1', COMMIT);
      } finally {
        writes?.give();
      }
      return taken;
    });

    expect(held).toBe(true);
    await expect(readElsewhere(scopeId, 0)).resolves.toBeUndefined();
  });

  it('let the copy go for a lease long out, however many leases ended meanwhile', async () => {
    const scopeId = scopeOfItsOwn();
    await commit(scopeId, { record: await recordOf(scopeId, 5, '<html>five</html>'), seq: 5 });
    const host = hostOf(scopeId, authorityOf(scopeId, { seq: 6 }));

    await inRequest(async () => {
      const long = await host.startAttempt(PAGE_ATTEMPT);
      // More leases than a host remembers, each given up as a superseded one is.
      for (let index = 0; index < 300; index += 1) {
        const ended = await host.startAttempt(PAGE_ATTEMPT);
        if (ended.kind === 'leased') {
          await host.fail(ended.attemptId, { fencingToken: 1, outcome: 'skipped' });
        }
      }
      return long.kind === 'leased' ? host.commit(long.attemptId, COMMIT) : undefined;
    });

    await expect(readElsewhere(scopeId, 0)).resolves.toBeUndefined();
  });

  /**
   * Past the leases a host remembers, the one out longest is let go of though it is still out, and
   * its entry's copy with it: its commit may yet be answered with no record.
   */
  it('let the copy go for a lease long out, however many leases are out beside it', async () => {
    const scopeId = scopeOfItsOwn();
    // A copy no later than the generation that stood when the lease was granted (`CURRENT`).
    await commit(scopeId, { record: await recordOf(scopeId, 3, '<html>three</html>'), seq: 3 });
    const host = hostOf(scopeId, authorityOf(scopeId, { seq: 6 }));
    const handed: Promise<unknown>[] = [];

    await inRequest(async () => {
      const long = await host.startAttempt(PAGE_ATTEMPT);
      // More leases than a host remembers, every one of them still out.
      for (let index = 0; index < 300; index += 1) {
        await host.startAttempt(PAGE_ATTEMPT);
      }
      return long.kind === 'leased' ? host.commit(long.attemptId, COMMIT) : undefined;
    }, handed);
    await Promise.all(handed);

    await expect(readElsewhere(scopeId, 0)).resolves.toBeUndefined();
  });

  it('are found by no host that opens the scope with another token', async () => {
    const scopeId = scopeOfItsOwn();
    await commit(scopeId, { record: await recordOf(scopeId, 5, '<html>five</html>'), seq: 5 });

    await expect(readElsewhere(scopeId, 0, 'another-token')).resolves.toBeUndefined();
  });
});

const MIB = 1024 * 1024;

/**
 * A read of the entry's record answered as `length` bytes long, whose body comes only once it is
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

/** Whether a read found `record`, none, or other bytes: said short, as a record can be MiB long. */
function foundOf(found: Uint8Array | undefined, record: Uint8Array): string {
  if (found === undefined) {
    return 'none';
  }
  const same =
    found.byteLength === record.byteLength && found.every((byte, at) => byte === record[at]);
  return same ? 'the record' : 'other bytes';
}

/**
 * What another isolate of the data center finds of the copy of `record` while a read of the entry's
 * record holds `holding` bytes of the isolate's room, its body stalled — and once that read is done.
 */
function readBeside(scopeId: string, holding: number, record: Uint8Array) {
  const read = stalledRecordRead(holding);
  const authority = authorityOf(scopeId);
  const host = hostOf(scopeId, async (request) =>
    new URL(request.url).pathname.endsWith('/record') ? read.answer() : authority(request),
  );
  return inRequest(async () => {
    const reading = host.readRecord(await pageEntryId(scopeId));
    // Its room is taken before its body is asked for.
    await read.begun;
    const meanwhile = await host.readNewerRecord?.(await pageEntryId(scopeId), 0);
    read.letGo();
    await reading;
    const after = await host.readNewerRecord?.(await pageEntryId(scopeId), 0);
    return { meanwhile: foundOf(meanwhile, record), after: foundOf(after, record) };
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
 * A copy is read whole, as a record the gateway answers is, and a burst of reads KV is behind on
 * reads one each: an isolate reads no more of them at once than it has room for, 32 MiB of records,
 * copies and artifacts together. A copy waits for its room no longer than its read is given.
 */
describe('the room an isolate reads copies of records in', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is waited for, and a copy that has none in time is not read', async () => {
    const scopeId = scopeOfItsOwn();
    const record = await recordOf(scopeId, 5, 'x'.repeat(3 * MIB));
    await commit(scopeId, { record, seq: 5 });

    // Another 3 MiB beside the record read's 30 would not fit in the isolate's 32.
    const read = await readBeside(scopeId, 30 * MIB, record);

    expect(read).toStrictEqual({ meanwhile: 'none', after: 'the record' });
  });

  it('is given back once a copy is read, for the reads after it', async () => {
    const scopeId = scopeOfItsOwn();
    const record = await recordOf(scopeId, 5, 'x'.repeat(3 * MIB));
    await commit(scopeId, { record, seq: 5 });
    const host = hostOf(scopeId, authorityOf(scopeId));

    // Eleven reads of 3 MiB one after another: past the isolate's 32, had each kept its room.
    const found = await inRequest(async () => {
      const reads: string[] = [];
      const entryId = await pageEntryId(scopeId);
      for (let index = 0; index < 11; index += 1) {
        reads.push(foundOf(await host.readNewerRecord?.(entryId, 0), record));
      }
      return reads;
    });

    expect(found).toStrictEqual(Array.from({ length: 11 }, () => 'the record'));
  });

  it('is the length a copy says, so that a short one is read beside a long read', async () => {
    const scopeId = scopeOfItsOwn();
    const record = await recordOf(scopeId, 5, '<html>five</html>');
    await commit(scopeId, { record, seq: 5 });

    const read = await readBeside(scopeId, 30 * MIB, record);

    expect(read).toStrictEqual({ meanwhile: 'the record', after: 'the record' });
  });

  it('is the most a copy is read for where the copy does not say its length', async () => {
    const scopeId = scopeOfItsOwn();
    const record = await recordOf(scopeId, 5, '<html>five</html>');
    await commit(scopeId, { record, seq: 5 });
    copiesSayingNoLength();

    // 4 MiB beside the record read's 29 would not fit in the isolate's 32.
    const read = await readBeside(scopeId, 29 * MIB, record);

    expect(read).toStrictEqual({ meanwhile: 'none', after: 'the record' });
  });
});

describe('a lease, as the host answers it', () => {
  it('says which generation of the entry is current, held or not', async () => {
    const scopeId = scopeOfItsOwn();
    const request = {
      entry: PAGE,
      reason: 'expired',
    } as const;

    const leased = await inRequest(async () =>
      hostOf(scopeId, authorityOf(scopeId)).startAttempt(request),
    );
    const busy = await inRequest(async () =>
      hostOf(scopeId, authorityOf(scopeId, { lease: 'busy' })).startAttempt(request),
    );

    expect(leased).toMatchObject({ kind: 'leased', current: CURRENT });
    expect(busy).toStrictEqual({
      kind: 'busy',
      current: CURRENT,
      attemptId: 'attempt-elsewhere',
      leaseExpiresAt: NOW + 60_000,
    });
  });

  /**
   * The record of a later generation than the one the runtime judged, where the authority's answer
   * carried it: handed to the runtime as it came, for it to check and answer from.
   */
  it('hands the runtime the record of a later generation the answer carried, held or not', async () => {
    const scopeId = scopeOfItsOwn();
    const later = await recordOf(scopeId, 4, 'generation four');
    const request = { ...PAGE_ATTEMPT, replaces: 'generation-3' } as const;

    const leased = await inRequest(async () =>
      hostOf(scopeId, authorityOf(scopeId, { leaseRecord: later })).startAttempt(request),
    );
    const busy = await inRequest(async () => {
      return hostOf(
        scopeId,
        authorityOf(scopeId, { lease: 'busy', leaseRecord: later }),
      ).startAttempt(request);
    });

    expect(leased).toMatchObject({ kind: 'leased', current: CURRENT, record: later });
    expect(busy).toMatchObject({ kind: 'busy', current: CURRENT, record: later });
  });

  it('asks with the generation the runtime judged, and hands back nothing that is no record', async () => {
    const scopeId = scopeOfItsOwn();
    const asked: unknown[] = [];
    const answers = { asked, leaseRecord: new TextEncoder().encode('no record') };

    const answer = await inRequest(async () => {
      return hostOf(scopeId, authorityOf(scopeId, answers)).startAttempt({
        ...PAGE_ATTEMPT,
        replaces: 'generation-3',
      });
    });

    expect(asked).toMatchObject([{ reason: 'expired', replaces: 'generation-3' }]);
    expect(answer).not.toHaveProperty('record');
  });
});
