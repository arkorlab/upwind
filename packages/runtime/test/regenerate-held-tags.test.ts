import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { withClock } from '../src/cache/clock.ts';
import { configureCacheHandlers, PlatformFetchCache } from '../src/cache/handlers.ts';
import type {
  CacheHost,
  CommitRequest,
  DataRead,
  TagDelta,
  TagInvalidation,
} from '../src/cache/host.ts';
import { answeringAtOnce, publishingKeyOf } from '../src/cache/publishing.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';

/**
 * What a regeneration commits of what its render's view held of each tag (`heldTagRevisions`), as
 * the render reads the data cache through the fetch cache's handler: the bridge Next.js renders
 * through is replaced by a route handler that reads what each test says and answers, and the host
 * is one in memory that keeps the commit it is sent.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'scope-held-tags';
const NOW = 1_800_000_000_000;
const SECOND = 1000;
const HOLD_MS = 5000;
const ENTRIES = 64;
/** How many tags a view keeps (`MAX_TAGS_HELD`): one pull bringing more lets the first go. */
const TAGS_HELD = 4096;
const FEED: RouteEntryDescriptor = { kind: 'app-route', route: '/feed', pathname: '/feed' };
/** What the route handler answers with: a lifetime, so that its render is kept. */
const CACHE_CONTROL = 's-maxage=60, stale-while-revalidate=600';
const TAG = 'product-1';
/** A tag of the generation no read of the render is made under. */
const UNREAD = 'listing';
/** The revision `TAG` was invalidated at, at once, and when that took effect. */
const INVALIDATED = 5;
const INVALIDATED_AT = NOW - 10 * SECOND;
/** The revision the delta is read at: the view's, which the commit says it was brought up to. */
const REVISION = 10;
/** A revision of the scope past the view's, which the host's copy of a tag may say. */
const PAST_THE_VIEW = 12;

/** A read the route handler makes through the fetch cache: its key, under its tags. */
interface Read {
  readonly key: string;
  readonly tags: readonly string[];
}

/** What a host keeps, and how its regeneration's render reads it. */
interface Scenario {
  /** How many other tags the delta brings after `TAG`'s invalidation, in the same pull. */
  readonly later: number;
  /** What the host's copy of the tags says of each tag it is asked of. */
  readonly copies: readonly TagInvalidation[];
  /** The data-cache entries the host keeps, by key. */
  readonly entries: Readonly<Record<string, DataRead>>;
  /** What the render reads, in order, and the tags it leaves on the generation. */
  readonly reads: readonly Read[];
  readonly tags: readonly string[];
  /** What it reads behind its answer, in work handed to `waitUntil`, once the render is over. */
  readonly behind?: readonly Read[] | undefined;
}

/** The moment every clock of these tests reads: the isolate's, and what a request acts at. */
function frozen(): number {
  return NOW;
}

/** `count` tags no read of these tests is under. */
function othersOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `other-${String(index)}`);
}

/** A value of the fetch cache made at `timestamp` under `tags`, as the host answers a read of it. */
function entryOf(tags: readonly string[], timestamp: number): DataRead {
  const value = { kind: 'FETCH', data: { body: 'kept' }, revalidate: 60 };
  return {
    entryId: `entry-${tags.join(',')}`,
    generationId: `generation-${tags.join(',')}`,
    dependencyRevision: 1,
    entry: { kind: 'data:fetch', tags, stale: 0, timestamp, expire: 31_536_000, revalidate: 60 },
    value: { kind: 'inline', base64: btoa(JSON.stringify(value)) },
  };
}

/** What the host answers a call no regeneration makes. */
function unasked(): Promise<never> {
  return Promise.reject(new Error('not asked of a regeneration'));
}

/** What the host waits for: the work behind the render's answer, and what is asked at its commit. */
interface Hooks {
  /** Told once the render is over, as its uploads begin. */
  readonly rendered: () => void;
  /** The work behind the render's answer, which the uploads wait for. */
  readonly done: Promise<unknown>;
  /** What is asked while the publish is out, as its commit comes in. */
  readonly committing: () => Promise<void>;
}

/**
 * A host that leases the entry, keeps the commit it is sent in `commits`, and answers the delta and
 * the reads as `scenario` says. Its uploads, which come once the render is over, wait for the work
 * behind the render's answer, and its commit for what is asked as it comes in (`hooks`).
 */
function hostOf(scenario: Scenario, commits: CommitRequest[], hooks: Hooks): CacheHost {
  const delta: TagDelta = {
    revision: REVISION,
    truncated: false,
    tags: [
      { value: TAG, staleAt: INVALIDATED_AT, hardExpireAt: INVALIDATED_AT, revision: INVALIDATED },
      ...othersOf(scenario.later).map((value) => {
        return {
          value,
          staleAt: INVALIDATED_AT,
          hardExpireAt: null,
          revision: 6,
        };
      }),
    ],
  };
  const past: TagDelta = { revision: REVISION, truncated: false, tags: [] };
  return {
    startAttempt: () => {
      return Promise.resolve({
        kind: 'leased',
        attemptId: 'attempt',
        entryId: 'entry',
        fencingToken: 1,
        leaseExpiresAt: NOW + 60 * SECOND,
        current: null,
      });
    },
    uploadArtifact: async (upload) => {
      hooks.rendered();
      await hooks.done;
      return { sha256: '0'.repeat(64), byteLength: upload.bytes.byteLength };
    },
    heartbeat: () => Promise.resolve(),
    commit: async (_attemptId, request) => {
      await hooks.committing();
      commits.push(request);
      return { kind: 'published', generationId: 'generation' };
    },
    fail: () => Promise.resolve(),
    readRecord: () => Promise.resolve(undefined),
    readArtifact: () => Promise.resolve(undefined),
    getData: (request) => Promise.resolve(scenario.entries[request.key]),
    setData: unasked,
    getTags: (values) =>
      Promise.resolve({ tags: scenario.copies.filter((tag) => values.includes(tag.value)) }),
    tagsDelta: (since) => Promise.resolve(since < REVISION ? delta : past),
    invalidate: unasked,
  };
}

/** The cache runtime of an isolate that has read nothing yet, over `host`, logging to `logged`. */
function runtimeOf(host: CacheHost, logged: string[]): CacheRuntime {
  return {
    scopeId: SCOPE,
    host,
    tags: new TagState({ holdMs: HOLD_MS }),
    holdMs: HOLD_MS,
    clockOf: frozen,
    dataMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    dataStates: new TtlCache(Infinity, ENTRIES, frozen),
    dataWrites: new Map(),
    entryIds: new TtlCache(Infinity, ENTRIES, frozen),
    recordMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    recordReads: new Map(),
    regenerationMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    publishing: new TtlCache(HOLD_MS, ENTRIES, frozen),
    letGo: new WeakSet(),
    givenBack: new TtlCache(HOLD_MS, ENTRIES, frozen),
    artifactMemo: new TtlCache(Infinity, ENTRIES, frozen),
    log: (message) => {
      logged.push(message);
    },
  };
}

/** Each of `reads` through the fetch cache, as Next.js asks of it: what each was answered with. */
async function readEach(reads: readonly Read[]): Promise<unknown[]> {
  const cache = new PlatformFetchCache();
  const answers: unknown[] = [];
  for (const read of reads) {
    answers.push(await cache.get(read.key, { kind: 'FETCH', tags: [...read.tags], softTags: [] }));
  }
  return answers;
}

/**
 * What a regeneration came to: the commit it sent, its render's answers, what it logged, and whether
 * another request of the isolate for the entry was answered from the render while its publish was
 * out (`answeringAtOnce`).
 */
interface Regenerated {
  readonly commit: CommitRequest | undefined;
  readonly answers: unknown[];
  readonly logged: readonly string[];
  readonly answeredAtOnce: boolean | undefined;
}

/** A regeneration of the route, its render reading as `scenario` says. */
async function regenerated(scenario: Scenario): Promise<Regenerated> {
  const commits: CommitRequest[] = [];
  const logged: string[] = [];
  const rendered = Promise.withResolvers<undefined>();
  const done = Promise.withResolvers<undefined>();
  const asking: { runtime?: CacheRuntime; answered?: boolean } = {};
  const runtime = runtimeOf(
    hostOf(scenario, commits, {
      rendered: () => {
        rendered.resolve(undefined);
      },
      done: done.promise,
      committing: async () => {
        const made = asking.runtime;
        if (made !== undefined) {
          const entryId = await publishingKeyOf(made, FEED);
          asking.answered = answeringAtOnce(made, 'expired', entryId) !== undefined;
        }
      },
    }),
    logged,
  );
  asking.runtime = runtime;
  configureCacheHandlers(runtime);
  let answers: unknown[] = [];
  vi.mocked(invokeNodeHandler).mockImplementation(async (input) => {
    const run = input.run ?? ((work) => work());
    return run(async () => {
      answers = await readEach(scenario.reads);
      input.waitUntil(
        (async () => {
          await rendered.promise;
          await readEach(scenario.behind ?? []);
          done.resolve(undefined);
        })(),
      );
      return new Response('{}', {
        headers: { 'cache-control': CACHE_CONTROL, 'x-next-cache-tags': scenario.tags.join(',') },
      });
    });
  });
  const pending: Promise<unknown>[] = [];
  const outcome = await withClock(NOW, () => {
    return regenerate({
      runtime,
      request: new Request(`https://app.test${FEED.pathname}`),
      handler: () => Promise.reject(new Error('the bridge is replaced')),
      target: { descriptor: FEED, reason: 'expired' },
      previewToken: undefined,
      waitUntil: (promise) => {
        pending.push(promise);
      },
      run: (work) => work(),
    });
  });
  if (outcome.kind === 'accepted') {
    await outcome.published;
  }
  // The work behind the answer goes on once the uploads begin; a regeneration that never got to
  // them lets it go here, rather than leaving it to wait for good.
  rendered.resolve(undefined);
  await Promise.allSettled(pending);
  return { commit: commits[0], answers, logged, answeredAtOnce: asking.answered };
}

describe('what a regeneration commits of what its render held of each tag', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    vi.mocked(invokeNodeHandler).mockReset();
  });

  /**
   * The pull that brought the view past the invalidation brought as many tags after it, which let
   * its mark go, and the host's copy of the tags says nothing of it yet: the fetch cache answers the
   * render with the value the invalidation expired, and the commit says nothing of the tag.
   */
  it('vouches for no invalidation of a tag the render read with its mark let go of', async () => {
    const { commit, answers, logged } = await regenerated({
      later: TAGS_HELD,
      copies: [],
      entries: { product: entryOf([TAG], INVALIDATED_AT - 10 * SECOND) },
      reads: [{ key: 'product', tags: [TAG] }],
      tags: [TAG, UNREAD],
    });

    expect(logged).toStrictEqual([]);
    expect(answers).toHaveLength(1);
    expect(answers[0]).not.toBeNull();
    expect(commit?.observedTagRevision).toBe(REVISION);
    expect(commit?.heldTagRevisions).toMatchObject({ [UNREAD]: REVISION });
    expect(commit?.heldTagRevisions).not.toHaveProperty(TAG);
  });

  /** The host's copy says an invalidation from before the one the view let go of the mark of. */
  it('holds a tag the render read with its mark let go of at what the host’s copy said of it', async () => {
    const { commit, answers } = await regenerated({
      later: TAGS_HELD,
      copies: [
        {
          value: TAG,
          staleAt: INVALIDATED_AT - 60 * SECOND,
          hardExpireAt: INVALIDATED_AT - 60 * SECOND,
          revision: 3,
        },
      ],
      entries: { product: entryOf([TAG], INVALIDATED_AT - 10 * SECOND) },
      reads: [{ key: 'product', tags: [TAG] }],
      tags: [TAG, UNREAD],
    });

    expect(answers[0]).not.toBeNull();
    expect(commit?.heldTagRevisions).toMatchObject({ [TAG]: 3, [UNREAD]: REVISION });
  });

  /** A view that let go of nothing of a tag knows the whole of it up to its revision. */
  it('holds a tag the render read with its mark kept through the view’s revision', async () => {
    const { commit, answers } = await regenerated({
      later: TAGS_HELD - 1,
      copies: [],
      entries: { product: entryOf([TAG], INVALIDATED_AT - 10 * SECOND) },
      reads: [{ key: 'product', tags: [TAG] }],
      tags: [TAG, UNREAD],
    });

    // A regeneration misses what the invalidation expired, and renders it afresh.
    expect(answers).toStrictEqual([null]);
    expect(commit?.heldTagRevisions).toMatchObject({ [TAG]: REVISION, [UNREAD]: REVISION });
  });

  /**
   * A read of the render that knew a mark past the view's revision says that revision; a read
   * behind its answer is none of the render's, whatever it knew — past the view's revision, or a
   * mark from long before it — and the tag it reads under is one the render read nothing under.
   */
  it('says nothing past the view’s revision, nor anything a read behind the answer knew', async () => {
    const copy = (value: string, revision: number): TagInvalidation => {
      return {
        value,
        staleAt: NOW - 60 * SECOND,
        hardExpireAt: null,
        revision,
      };
    };
    const { commit } = await regenerated({
      later: 0,
      copies: [copy('during', PAST_THE_VIEW), copy('after', PAST_THE_VIEW), copy('older', 3)],
      entries: {
        during: entryOf(['during'], NOW - SECOND),
        after: entryOf(['after'], NOW - SECOND),
        older: entryOf(['older'], NOW - SECOND),
      },
      reads: [{ key: 'during', tags: ['during'] }],
      behind: [
        { key: 'after', tags: ['after'] },
        { key: 'older', tags: ['older'] },
      ],
      tags: ['during', 'after', 'older'],
    });

    expect(commit?.heldTagRevisions).toMatchObject({
      during: REVISION,
      after: REVISION,
      older: REVISION,
    });
  });

  /**
   * While its publish is out, a render answers the isolate's other requests for the entry by what
   * its commit says it held: one it held a tag through less than its view of is one its reads may
   * have missed an invalidation of, which the host may refuse it for, and nothing this isolate
   * holds says so — it let go of the mark.
   */
  it('answers no other request of the isolate from a render that held a tag through less than its view', async () => {
    const { commit, answeredAtOnce } = await regenerated({
      later: TAGS_HELD,
      copies: [],
      entries: { product: entryOf([TAG], INVALIDATED_AT - 10 * SECOND) },
      reads: [{ key: 'product', tags: [TAG] }],
      tags: [TAG, UNREAD],
    });

    expect(commit?.heldTagRevisions).not.toHaveProperty(TAG);
    expect(answeredAtOnce).toBe(false);
  });

  /** A tag never invalidated is one the view knows the whole of, read or not. */
  it('answers another request of the isolate from a render that held each of its tags through its view', async () => {
    const { commit, answeredAtOnce } = await regenerated({
      later: TAGS_HELD - 1,
      copies: [],
      entries: {
        product: entryOf([TAG], INVALIDATED_AT - 10 * SECOND),
        catalog: entryOf(['catalog'], INVALIDATED_AT - 10 * SECOND),
      },
      reads: [
        { key: 'product', tags: [TAG] },
        { key: 'catalog', tags: ['catalog'] },
      ],
      tags: [TAG, 'catalog', UNREAD],
    });

    expect(commit?.heldTagRevisions).toMatchObject({
      [TAG]: REVISION,
      catalog: REVISION,
      [UNREAD]: REVISION,
    });
    expect(answeredAtOnce).toBe(true);
  });
});
