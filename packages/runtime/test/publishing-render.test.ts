import {
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_ENTRY,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import { CACHE_OUTCOME_HEADER } from '@stayingupwind/core/paas';
import { afterEach, assert, describe, expect, it, type Mock, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { nowMs, withClock } from '../src/cache/clock.ts';
import { type RequestContext, withRequestContext } from '../src/cache/context.ts';
import { HeldTags } from '../src/cache/held-tags.ts';
import type { AttemptReason, FetchLike } from '../src/cache/host.ts';
import { answeringWhenSuperseded, givingBack, publishingKeyOf } from '../src/cache/publishing.ts';
import { regenerate, type RegenerationOutcome } from '../src/cache/regenerate.ts';
import {
  type CacheRuntime,
  createCacheRuntime,
  GIVEN_BACK_ENTRIES,
  PUBLISHING_BYTES,
  type Publishing,
} from '../src/cache/runtime.ts';
import type { TagHost } from '../src/cache/tags.ts';
import { type GenerationSource, serveFromGeneration } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { NEXT_CACHE_HEADER, type RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';
import { requestKeeping } from './request-context.ts';

// The time each test had where this suite ran before: it renders through the runtime and the
// function-side cache host, and several of its tests take a second or two on a quiet machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * A request of the isolate that is publishing an entry's regeneration, which would regenerate the
 * entry itself: answered from the render being published — the page every request after the publish
 * is answered with, carrying what the generation it publishes carries — and not with a page of its
 * own, while the lease that publish holds would have turned it away. At once within a hold of the
 * view of the tags the render read against; past it, once the host has turned the request away for
 * the publish's own lease and the request's own pull has brought the view up to the host's — though
 * the view has moved past the render's revision, where the delta brought nothing of a tag the
 * render carries: a lease or a commit of the scope, or another page's tag. Only a regeneration a
 * judgement of the entry asked for — not one `revalidate()` or an invalidation did. Not where the
 * view says the render missed an invalidation — a tag the render carries was invalidated here,
 * reported by another read, or brought by the delta past the render's revision — nor where the view
 * has let go of a mark of a tag the render carries, which it can then say nothing of since, nor
 * where the render's own pull did not answer, nor where its publish refuses it for its tags, nor
 * once the entry's lease has been taken again, nor half a minute after the render was made, nor
 * once the publish has settled, nor where the render is larger than all the isolate keeps of the
 * renders it publishes. Where the host leases the entry naming the generation the render's own
 * publish just committed — its answer still on its way — the render answers, though the view has
 * moved on for another page's tag; so it does a request leased the entry in turn meanwhile, and one
 * the host turns away for the lease the first gave back once its own pull is in. Not where the host
 * names another generation, or where an invalidation of a tag of the render is known here meanwhile
 * — made here, or brought by that pull. Once a lease of the entry has been handed out, the render
 * answers no request at once.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_publishingRenderTest0';
const T0 = 1_800_000_000_000;
const SECOND = 1000;
/** How long the isolate holds a view of the tags it judges by: the runtime's default hold. */
const HOLD = 5 * SECOND;
/** The tag every render of the feed carries, besides the route's own. */
const FEED_TAG = 'feed';
/** A tag no render of the feed carries: another page's of the scope. */
const OTHER_TAG = 'elsewhere';
/** How many tags the isolate's view keeps (`MAX_TAGS_HELD`): a delta bringing more lets the first go. */
const TAGS_HELD = 4096;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const FEED: RouteEntryDescriptor = { kind: 'app-route', route: '/api/feed', pathname: '/api/feed' };
/** Nothing here runs a handler: the bridge that would is replaced, and says what it answers. */
const handler: NodeHandler = () => Promise.reject(new Error('the bridge is replaced'));

/**
 * Every render answered afresh, carrying `tags` (`FEED_TAG`), its body counting the renders made so
 * far, or `bytes` long.
 */
function rendering(bytes?: number, tags = FEED_TAG): void {
  let renders = 0;
  vi.mocked(invokeNodeHandler).mockImplementation(() => {
    renders += 1;
    return Promise.resolve(
      new Response(bytes === undefined ? `render ${String(renders)}` : new Uint8Array(bytes), {
        headers: {
          'cache-control': 's-maxage=900',
          'content-type': 'text/plain',
          'x-next-cache-tags': tags,
        },
      }),
    );
  });
}

/**
 * What the host says besides what the authority does: whether it turns a lease asked for away, as
 * one whose lease is held (`busy`), and what the scope's delta says — nothing new, an invalidation
 * of `FEED_TAG` or of `OTHER_TAG` at a later revision, or no answer at all.
 */
interface HostSays {
  busy: boolean;
  /** The attempt a lease turned away for is held by: the first publish's, unless said otherwise. */
  holder?: string;
  /** When that lease lapses: a minute on from the request, unless said otherwise. */
  holderUntil?: number;
  delta: 'quiet' | 'invalidated' | 'elsewhere' | 'failing';
  /** The delta's answer, held back until this settles: a pull still out. */
  deltaHeld?: Promise<unknown>;
  /** When the host stamped the delta's invalidation, by its clock: when the delta is read, unless said. */
  invalidatedAt?: number;
  /**
   * The answer to an attempt's end, held back until this settles: a lease given back that the host
   * has taken back, its answer still on its way.
   */
  failHeld?: Promise<unknown>;
  /** Whether the attempt's end is answered with a failure: a lease given back that the host may hold still. */
  failRefused?: boolean;
  /** The answer that turns a lease away, held back until this settles: still on its way. */
  busyHeld?: Promise<unknown>;
  /**
   * The next ask for a lease, held back before the host hears it until this settles: on its way to
   * the host. Told when it is held (`attemptReached`).
   */
  attemptHeld?: Promise<unknown> | undefined;
  attemptReached?: () => void;
  /**
   * The generation a lease handed out names as the entry's current one, and the answer that turns a
   * lease away does too: none, unless said.
   */
  current?: unknown;
  /** The current generation the answer that turns a lease away names instead, where said. */
  busyCurrent?: unknown;
  /** Told each time the host answers a pull of the scope's delta. */
  deltaAnswered?: () => void;
  /**
   * The answer to a commit the authority has taken, held back until this settles: the commit has
   * landed, and the lease is let go of, while its answer is still on its way. Without it, the commit
   * itself waits (`release`).
   */
  answerHeld?: Promise<unknown>;
}

/** The current generation the answer that turns a lease away names (`HostSays.busyCurrent`). */
function busyCurrentOf(says: HostSays): unknown {
  return 'busyCurrent' in says ? says.busyCurrent : (says.current ?? null);
}

/** A host that leases what it is asked for and whose delta says nothing new. */
function quietHost(): HostSays {
  return { busy: false, delta: 'quiet' };
}

function answer(result: unknown): Response {
  return Response.json({ ok: true, result });
}

/** The tag each delta that says something invalidates. */
const INVALIDATED_BY: Partial<Record<HostSays['delta'], string>> = {
  invalidated: FEED_TAG,
  elsewhere: OTHER_TAG,
};

/** The scope's delta as `says` has it, read at `now`. */
function deltaAnswer(says: HostSays, now: number): Response {
  if (says.delta === 'failing') {
    return Response.json(
      { ok: false, error: { code: 'internal', message: 'the delta was not read' } },
      { status: 500 },
    );
  }
  const invalidated = INVALIDATED_BY[says.delta];
  return answer({
    revision: invalidated === undefined ? 0 : 99,
    floor: 0,
    truncated: false,
    tags:
      invalidated === undefined
        ? []
        : [
            {
              tagId: `tag-${invalidated}`,
              kind: 'next-explicit',
              value: invalidated,
              revision: 99,
              staleAt: says.invalidatedAt ?? now,
              hardExpireAt: null,
              meaning: 'swr',
            },
          ],
  });
}

/**
 * The authority's calls, every commit held back until `release`: the publish is out, and the lease
 * it holds stands. What the host says of a lease and of the delta is `says`, which a test may change
 * between its requests; the authority hears every call.
 */
function holdingCommits(
  authority: FakeAuthority,
  says: HostSays = quietHost(),
): {
  readonly fetchImpl: FetchLike;
  readonly release: () => void;
} {
  const gate = Promise.withResolvers<true>();
  return {
    fetchImpl: async (request) => {
      const { pathname } = new URL(request.url);
      const asking = says.attemptHeld;
      if (asking !== undefined && pathname.endsWith('/attempts')) {
        says.attemptHeld = undefined;
        says.attemptReached?.();
        await asking;
      }
      const committing = pathname.endsWith('/commit');
      if (committing && says.answerHeld === undefined) {
        await gate.promise;
      }
      const answered = await authority.fetchImpl(request);
      if (committing && says.answerHeld !== undefined) {
        await says.answerHeld;
        return answered;
      }
      if (pathname.endsWith('/fail')) {
        await says.failHeld;
        return says.failRefused === true
          ? Response.json(
              { ok: false, error: { code: 'internal', message: 'the attempt was not ended' } },
              { status: 500 },
            )
          : answered;
      }
      if (pathname.endsWith('/tags/delta')) {
        await says.deltaHeld;
        says.deltaAnswered?.();
        return deltaAnswer(says, nowMs());
      }
      if (!says.busy && says.current !== undefined && pathname.endsWith('/attempts')) {
        const leased = (await answered.json()) as { readonly result: Record<string, unknown> };
        // A minute's lease, by the clock the request acts at.
        return answer({
          ...leased.result,
          current: says.current,
          leaseExpiresAt: nowMs() + 60 * SECOND,
        });
      }
      if (!says.busy || !pathname.endsWith('/attempts')) {
        return answered;
      }
      await says.busyHeld;
      const leased = (await answered.json()) as { readonly result: Record<string, unknown> };
      return answer({
        kind: 'busy',
        entryId: leased.result['entryId'],
        // The fake authority numbers its attempts from one: the first is the publish held here.
        attemptId: says.holder ?? 'attempt-1',
        leaseExpiresAt: says.holderUntil ?? nowMs() + 60 * SECOND,
        current: busyCurrentOf(says),
      });
    },
    release: () => {
      gate.resolve(true);
    },
  };
}

/**
 * The entry's current generation as a lease names it (`AttemptOutcome.current`), made of the first
 * commit the authority took, under `generationId`: fresh, and one a visitor may be answered with.
 */
function committedAs(generationId: string, authority: FakeAuthority): unknown {
  const committed = authority.commits[0]?.generation;
  return {
    generationId,
    seq: 1,
    cacheTimestamp: committed?.cacheTimestamp ?? null,
    policy: committed?.policy,
    condemned: null,
    status: 200,
    location: null,
  };
}

function runtimeFor(fetchImpl: FetchLike): CacheRuntime {
  // What the isolate keeps ages by the clock the request acts at, as the Function's does.
  const runtime = createCacheRuntime({ env: ENV, now: nowMs, fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

function attemptsAsked(authority: FakeAuthority): number {
  return authority.calls.filter((call) => call.endsWith('/attempts')).length;
}

function deltasAsked(authority: FakeAuthority): number {
  return authority.calls.filter((call) => call.includes('/tags/delta')).length;
}

/**
 * A host whose delta brings the view up to `revision`, with an invalidation of each of `tags`
 * recorded there, stamped a second on and with a window; where it brings none, what moved the scope
 * on was a lease or a commit.
 */
function deltaTo(runtime: CacheRuntime, revision: number, tags: readonly string[] = []): TagHost {
  return {
    getTags: async (...args) => runtime.host.getTags(...args),
    tagsDelta: () => {
      return Promise.resolve({
        tags: tags.map((value) => ({ value, staleAt: T0 + SECOND, hardExpireAt: null, revision })),
        revision,
        truncated: false,
      });
    },
  };
}

/** As many tags as the isolate's view keeps, none of them one a render of the feed carries. */
function othersHeld(): string[] {
  return Array.from({ length: TAGS_HELD }, (_, index) => `other-${String(index)}`);
}

/**
 * What a render that read nothing through the data cache held of its tags: each through the view it
 * read against (`HeldTags`), closed as a regeneration closes it once its render is over.
 */
function heldOfNoReads(): HeldTags {
  const held = new HeldTags();
  held.close();
  return held;
}

/** A render this isolate published as `generationId`, `bytes` long, as a lease given back keeps it. */
function keptRender(bytes: number, generationId = 'generation-1'): Publishing {
  return {
    render: {
      html: new Uint8Array(bytes),
      postponed: undefined,
      rscData: undefined,
      segments: new Map(),
      headers: {},
      status: 200,
      cacheControl: { revalidate: 900 },
      data: undefined,
    },
    attemptId: 'attempt-1',
    tags: [FEED_TAG],
    observedTagRevision: 0,
    observedLosses: 0,
    held: heldOfNoReads(),
    observedAt: T0,
    published: Promise.resolve({ kind: 'published', generationId }),
  };
}

/** Why a regeneration of the feed was asked for, and of which generation, where it says. */
interface Asked {
  readonly reason?: AttemptReason;
  /** The generation the request judged (`RegenerationTarget.replaces`). */
  readonly replaces?: string;
}

/** A regeneration of the feed at `at`, as `asked`, the work it hands on kept in `behind`. */
function regenerateFeed(
  runtime: CacheRuntime,
  behind: Promise<unknown>[],
  at = T0 + SECOND,
  { reason = 'expired', replaces }: Asked = {},
): Promise<RegenerationOutcome> {
  return withClock(at, () => {
    return regenerate({
      runtime,
      request: new Request('https://app.test/api/feed'),
      handler,
      target: { descriptor: FEED, reason, ...(replaces !== undefined && { replaces }) },
      previewToken: undefined,
      waitUntil: (promise) => {
        behind.push(promise);
      },
      run: (work) => work(),
    });
  });
}

describe('a regeneration the isolate is asked for while it publishes one of the entry', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
    vi.restoreAllMocks();
  });

  it('is answered with the render being published, asking the host nothing', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(first.kind).toBe('accepted');
    expect(second.kind).toBe('busy');
    // The render, with the headers its generation was committed with.
    expect(second.kind === 'busy' && second.publishing).toStrictEqual(
      first.kind === 'accepted' && {
        ...first.render,
        headers: authority.commits[0]?.generation.headers,
      },
    );
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(attemptsAsked(authority)).toBe(1);
    expect(authority.commits).toHaveLength(1);
  });

  it('asks the host once the publish has settled', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);
    const after = await regenerateFeed(runtime, behind);
    await Promise.all(behind);

    expect(after.kind === 'busy' && after.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
    expect(runtime.publishing.size).toBe(0);
  });

  it('is answered with the render though the isolate’s view of the tags has moved past the render’s, bringing nothing', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    // A lease or a commit of the scope: the publish's own lease, say, recorded once the pull the
    // render read against had answered.
    await runtime.tags.sync(deltaTo(runtime, 99), T0 + SECOND, { force: true });
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(runtime.tags.revision).toBe(99);
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(true);
    expect(attemptsAsked(authority)).toBe(1);
  });

  it('is answered with the render though the isolate’s view of the tags has moved past the render’s for another page’s tag', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await runtime.tags.sync(deltaTo(runtime, 99, [OTHER_TAG]), T0 + SECOND, { force: true });
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(true);
    expect(attemptsAsked(authority)).toBe(1);
  });

  it('asks the host once the isolate’s view of the tags has moved past the render’s with an invalidation of a tag it carries', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await runtime.tags.sync(deltaTo(runtime, 99, [FEED_TAG]), T0 + SECOND, { force: true });
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    // This authority leases every attempt: what matters is that the host was asked.
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  it('asks the host once the isolate’s view of the tags has let go of a mark of a tag the render carries', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];
    // An invalidation of the feed's tag from before the render: the view holds its mark, and the
    // render is made against it.
    await runtime.tags.sync(deltaTo(runtime, 1, [FEED_TAG]), T0, { force: true });

    await regenerateFeed(runtime, behind);
    // A delta of as many other tags as the view keeps lets the feed's go: what it knows of the tag
    // since is nothing, and no mark it holds says whether an invalidation of it came meanwhile.
    await runtime.tags.sync(deltaTo(runtime, 2, othersHeld()), T0 + SECOND, { force: true });
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(runtime.tags.holdsWhole(FEED_TAG)).toBe(false);
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  /**
   * Another read is told of an invalidation of the feed's tag at the host's revision of it, past the
   * view's, and the view lets that mark go with the tags read after it, its revision where it was:
   * what it knows of the tag reaches the revision it stands at, and says nothing of the mark.
   */
  it('asks the host once the view has let go of a mark of a tag the render carries that a read was told of past its revision', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];
    const told: TagHost = {
      getTags: (values) => {
        return Promise.resolve({
          tags: values.includes(FEED_TAG)
            ? [{ value: FEED_TAG, staleAt: T0 + SECOND, hardExpireAt: null, revision: 5 }]
            : [],
        });
      },
      tagsDelta: async (...args) => runtime.host.tagsDelta(...args),
    };

    await regenerateFeed(runtime, behind);
    await runtime.tags.syncLocal(told, [FEED_TAG], T0 + SECOND);
    await runtime.tags.syncLocal(told, othersHeld(), T0 + SECOND);
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(runtime.tags.revision).toBe(0);
    expect(runtime.tags.heldRevisionOf(FEED_TAG)).toBe(0);
    expect(runtime.tags.holdsWhole(FEED_TAG)).toBe(false);
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  /**
   * The isolate invalidates the feed's tag once the render is made, the host yet to answer, and lets
   * that mark go with as many invalidations of its own of other tags as it keeps of them
   * (`MAX_APPLIED_MARKS`, as many as `TAGS_HELD`); a lease of the scope then moves the view on. The
   * view holds the tag whole by the revisions it knows, and no mark of it any more.
   */
  it('asks the host once the view has let go of an invalidation made here of a tag the render carries', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    runtime.tags.applyLocal([FEED_TAG], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });
    runtime.tags.applyLocal(othersHeld(), { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });
    await runtime.tags.sync(deltaTo(runtime, 99), T0 + SECOND, { force: true });
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(runtime.tags.holdsWhole(FEED_TAG)).toBe(true);
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  it('asks the host once the isolate has invalidated a tag the render carries', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    // As `updateTag` leaves it, in force here before the delta says so.
    runtime.tags.applyLocal([FEED_TAG], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  it('is answered with the render where the isolate invalidated a tag it does not carry', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    runtime.tags.applyLocal(['another'], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(true);
    expect(attemptsAsked(authority)).toBe(1);
  });

  it('asks the host once another read has been told a tag the render carries was invalidated', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    // What a data-cache read asks of the tags it weighs, and the host answers of another isolate's
    // invalidation: the delta, and so the revision, says nothing of it yet.
    const invalidated = { tags: [{ value: FEED_TAG, staleAt: T0 + SECOND, hardExpireAt: null }] };
    const told: TagHost = {
      getTags: () => Promise.resolve(invalidated),
      tagsDelta: async (...args) => runtime.host.tagsDelta(...args),
    };
    await runtime.tags.syncLocal(told, [FEED_TAG], T0 + SECOND);
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(runtime.tags.revision).toBe(0);
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  it('asks the host past a hold of the view the render read against', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    // This authority leases every attempt: what matters is that the host was asked.
    expect(later.kind === 'busy' && later.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  it('past that hold, is answered with the render once the host turns the request away and the view is brought up', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    says.busy = true;
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(later.kind === 'busy' && later.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    expect(attemptsAsked(authority)).toBe(2);
    // The render's own pull, the one the request asked for with its lease, and the one it asked for
    // once the host had turned it away.
    expect(deltasAsked(authority)).toBe(3);
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  it('past that hold, is answered with the render though the pull brings the view past the render’s for another page’s tag', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    says.busy = true;
    says.delta = 'elsewhere';
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(runtime.tags.revision).toBe(99);
    expect(later.kind === 'busy' && later.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  it('past that hold, is not answered with the render where the lease is another attempt’s', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    // The publish's lease lapsed while it was out, and another isolate's attempt took the entry.
    says.busy = true;
    says.holder = 'attempt-elsewhere';
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(later.kind).toBe('busy');
    expect(later.kind === 'busy' && later.publishing).toBeUndefined();
  });

  it('past that hold, is not answered with the render where the publish’s lease lapses before the pull is in', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    // The host names the publish's own attempt, on a lease that has run out by the time the
    // request's pull is in: another attempt may hold the entry by then.
    says.busy = true;
    says.holderUntil = T0 + SECOND + HOLD;
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(later.kind).toBe('busy');
    expect(later.kind === 'busy' && later.publishing).toBeUndefined();
  });

  it('past that hold, is not answered with the render where the host does not say whose lease it is', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];
    // A host that turns a request away without naming the attempt holding the lease.
    const startAttempt = runtime.host.startAttempt.bind(runtime.host);
    vi.spyOn(runtime.host, 'startAttempt').mockImplementation(async (request) => {
      const outcome = await startAttempt(request);
      return outcome.kind === 'busy' ? { kind: 'busy', current: outcome.current } : outcome;
    });

    await regenerateFeed(runtime, behind);
    says.busy = true;
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(later.kind).toBe('busy');
    expect(later.kind === 'busy' && later.publishing).toBeUndefined();
  });

  it('past that hold, is not answered with the render where the pull brings an invalidation', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    says.busy = true;
    says.delta = 'invalidated';
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(later.kind).toBe('busy');
    expect(later.kind === 'busy' && later.publishing).toBeUndefined();
  });

  /**
   * The pull the request asked for with its lease may answer before the host records an invalidation
   * of the render's tag, and turns the request away after it: the request's pull is asked for again
   * once that answer is in.
   */
  it('past that hold, is not answered with the render where an invalidation lands between the request’s first pull and the host turning it away', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const busyIn = Promise.withResolvers<true>();
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];
    let pullsAnswered = 0;

    await regenerateFeed(runtime, behind);
    says.busy = true;
    says.busyHeld = busyIn.promise;
    says.deltaAnswered = () => {
      pullsAnswered += 1;
    };
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    await vi.waitFor(() => {
      expect([pullsAnswered, attemptsAsked(authority)]).toStrictEqual([1, 2]);
    });
    says.delta = 'invalidated';
    busyIn.resolve(true);
    const outcome = await later;
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind).toBe('busy');
    expect(outcome.kind === 'busy' && outcome.publishing).toBeUndefined();
  });

  it('past that hold, is not answered with the render where the pull fails', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    says.busy = true;
    says.delta = 'failing';
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(later.kind).toBe('busy');
    expect(later.kind === 'busy' && later.publishing).toBeUndefined();
  });

  it('is not answered with a render whose lease the isolate has since taken again', async () => {
    // The first render is published and held; the next, made under a later lease, has no lifetime
    // and so nothing to keep.
    vi.mocked(invokeNodeHandler)
      .mockResolvedValueOnce(
        new Response('render 1', {
          headers: { 'cache-control': 's-maxage=900', 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('render 2', { headers: { 'content-type': 'text/plain' } }),
      );
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    // Past the hold the host leases the entry again — the first publish's lease has lapsed — and
    // that attempt comes to nothing; then the host turns a request away for a lease of the entry.
    const again = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    says.busy = true;
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(again.kind).toBe('skipped');
    expect(later.kind).toBe('busy');
    expect(later.kind === 'busy' && later.publishing).toBeUndefined();
  });

  it('past that hold, is not answered with the render where its own pull fails, whatever another pull of the same moment did', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    // Another request's pull, answered, at the very moment the next request asks for its own.
    await runtime.tags.sync(runtime.host, T0 + SECOND + HOLD, { force: true });
    says.busy = true;
    says.delta = 'failing';
    const later = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD);
    commits.release();
    await Promise.all(behind);

    expect(later.kind).toBe('busy');
    expect(later.kind === 'busy' && later.publishing).toBeUndefined();
  });

  it.each([
    ['revalidate()', 'manual'],
    ['an invalidation', 'invalidated'],
  ] as const)(
    'asks the host for a regeneration %s asked for, and does not answer it with the render',
    async (_asker, reason) => {
      rendering();
      const authority = fakeAuthority(SCOPE);
      const says = quietHost();
      const commits = holdingCommits(authority, says);
      const runtime = runtimeFor(commits.fetchImpl);
      const behind: Promise<unknown>[] = [];

      await regenerateFeed(runtime, behind);
      const asked = await regenerateFeed(runtime, behind, T0 + SECOND, { reason });
      says.busy = true;
      const turnedAway = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD, { reason });
      commits.release();
      await Promise.all(behind);

      // This authority leases every attempt it is not told to turn away: the host was asked.
      expect(asked.kind).toBe('accepted');
      expect(turnedAway.kind).toBe('busy');
      expect(turnedAway.kind === 'busy' && turnedAway.publishing).toBeUndefined();
      expect(attemptsAsked(authority)).toBe(3);
    },
  );

  it('is answered with the render its own publish committed, where the host leases the entry before that commit’s answer is in', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    // The host has taken the commit and let go of the lease; its answer is still on its way.
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    // Past the hold, the next request asks the host, which leases the entry naming that generation.
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    answerIn.resolve(true);
    const outcome = await later;
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  it('is not answered with the render where the generation the host holds is another', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-9', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    answerIn.resolve(true);
    const outcome = await later;
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.publishing).toBeUndefined();
  });

  it('is not answered with the render its own publish committed where this isolate invalidated a tag of it meanwhile', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    // While the request waits for the publish's answer, an `updateTag` here expires the feed's tag.
    runtime.tags.applyLocal([FEED_TAG], {
      staleAt: T0 + SECOND + HOLD,
      hardExpireAt: T0 + SECOND + HOLD,
    });
    answerIn.resolve(true);
    const outcome = await later;
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.publishing).toBeUndefined();
  });

  it('is answered with the render its own publish committed though the view of the tags has moved on for another page’s tag', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    // A tag the render does not carry is invalidated, and this isolate's view takes it in: the
    // host's word on the generation it holds speaks for every invalidation it had recorded.
    says.delta = 'elsewhere';
    await runtime.tags.sync(runtime.host, T0 + SECOND + HOLD, { force: true });
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    answerIn.resolve(true);
    const outcome = await later;
    commits.release();
    await Promise.all(behind);

    expect(runtime.tags.revision).toBe(99);
    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
  });

  it('answers a request leased the entry in turn, while the first waits for that publish’s answer, with the render', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    // The first has given its lease back and waits; the host leases the entry to the next in turn.
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    const next = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(2);
    });
    answerIn.resolve(true);
    const outcomes = await Promise.all([later, next]);
    commits.release();
    await Promise.all(behind);

    expect(outcomes.map((outcome) => outcome.kind)).toStrictEqual(['superseded', 'superseded']);
    expect(
      outcomes.map((outcome) => outcome.kind === 'superseded' && outcome.publishing?.html),
    ).toStrictEqual(
      Array.from({ length: 2 }, () => first.kind === 'accepted' && first.render.html),
    );
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  /**
   * A request asks for the lease while nothing of the entry is being published, and another of the
   * isolate takes it first, renders and commits: the host names that one's generation to the first
   * as its answer comes in, and the first is answered from that render, kept since it asked.
   */
  it('answers a request whose lease was asked for before another of the isolate published, from that render', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const askIn = Promise.withResolvers<true>();
    const asked = Promise.withResolvers<undefined>();
    const says: HostSays = {
      ...quietHost(),
      answerHeld: answerIn.promise,
      attemptHeld: askIn.promise,
      attemptReached: () => {
        asked.resolve(undefined);
      },
    };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const early = regenerateFeed(runtime, behind, T0 + SECOND, { replaces: 'generation-0' });
    await asked.promise;
    const published = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    askIn.resolve(true);
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    answerIn.resolve(true);
    const outcome = await early;
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind === 'superseded' && outcome.publishing?.html).toStrictEqual(
      published.kind === 'accepted' && published.render.html,
    );
  });

  /**
   * A render the isolate kept when it asked for the lease, whose generation the host names, answers
   * though another render stands in its place by the time the lease comes in.
   */
  it('answers a superseded request from the render it kept on asking, though another stands in its place once the lease is in', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const askIn = Promise.withResolvers<true>();
    const asked = Promise.withResolvers<undefined>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    says.attemptHeld = askIn.promise;
    says.attemptReached = () => {
      asked.resolve(undefined);
    };
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await asked.promise;
    // Another render in its place, by the clock the request acts at.
    await withClock(T0 + SECOND + HOLD, async () => {
      const key = await publishingKeyOf(runtime, FEED);
      assert(key !== undefined);
      runtime.publishing.set(key, keptRender(1, 'generation-9'));
    });
    askIn.resolve(true);
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    answerIn.resolve(true);
    const outcome = await later;
    await Promise.all(behind);
    // The host turns the next request away for the lease given back: answered from the same render.
    says.busy = true;
    says.holder = 'attempt-2';
    const busy = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind === 'superseded' && outcome.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    expect(busy.kind === 'busy' && busy.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
  });

  /**
   * Of two renders a superseded request may be answered from, the one the host named answers once
   * the other is in, or a second on — and not where this isolate invalidated a tag of it meanwhile.
   */
  it('answers from the render the host named once the other is in, unless a tag of it was invalidated meanwhile', async () => {
    const runtime = runtimeFor(fakeAuthority(SCOPE).fetchImpl);
    const named = keptRender(1);
    const out = {
      ...keptRender(1),
      published: new Promise<never>(() => {
        // Still on its way.
      }),
    };
    const answerAfter = (invalidating: boolean) => {
      return withClock(T0 + 2 * SECOND, async () => {
        const answering = answeringWhenSuperseded(
          runtime,
          [out, named],
          { generationId: 'generation-1' },
          () => Promise.resolve(true),
        );
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        if (invalidating) {
          runtime.tags.applyLocal([FEED_TAG], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });
        }
        return answering;
      });
    };

    const answered = await answerAfter(false);
    const invalidated = await answerAfter(true);

    expect(answered).toBe(named.render);
    expect(invalidated).toBeUndefined();
  });

  it('answers a request the host turns away for the lease a superseded request gave back, with the render', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    // The host has yet to say it has the lease given back, while the next request is turned away.
    const returnIn = Promise.withResolvers<true>();
    const says: HostSays = {
      ...quietHost(),
      answerHeld: answerIn.promise,
      failHeld: returnIn.promise,
    };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    // The host has yet to have that lease back, and turns the next request away for it.
    says.busy = true;
    says.holder = 'attempt-2';
    const turnedAway = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(attemptsAsked(authority)).toBe(3);
    });
    answerIn.resolve(true);
    const [outcome, busy] = await Promise.all([later, turnedAway]);
    returnIn.resolve(true);
    commits.release();
    await Promise.all(behind);

    expect([outcome.kind, busy.kind]).toStrictEqual(['superseded', 'busy']);
    expect(busy.kind === 'busy' && busy.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  /** One with no render of its own to weigh — another isolate published — waits for nothing. */
  it('answers a superseded request with no render to weigh without waiting for its pull', async () => {
    const runtime = runtimeFor(fakeAuthority(SCOPE).fetchImpl);
    const pullOut = new Promise<boolean>(() => {
      // Still on its way.
    });
    const moment = new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve('still waiting');
      }, 200);
    });

    const answering = async (): Promise<string> => {
      await answeringWhenSuperseded(
        runtime,
        [undefined],
        { generationId: 'generation-1' },
        () => pullOut,
      );
      return 'answered';
    };

    const first = await Promise.race([answering(), moment]);

    expect(first).toBe('answered');
  });

  /** One whose renders are none of them the generation the host named waits for nothing more. */
  it('answers a superseded request none of whose renders the host named without waiting for its pull', async () => {
    const runtime = runtimeFor(fakeAuthority(SCOPE).fetchImpl);
    const pullOut = new Promise<boolean>(() => {
      // Still on its way.
    });
    const moment = new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve('still waiting');
      }, 200);
    });
    const answering = async (): Promise<string> => {
      await answeringWhenSuperseded(
        runtime,
        [keptRender(1, 'generation-9')],
        { generationId: 'generation-1' },
        () => pullOut,
      );
      return 'answered';
    };

    const first = await Promise.race([answering(), moment]);

    expect(first).toBe('answered');
  });

  /**
   * The pull a superseded request is answered from a render after is asked for once the lease is in:
   * the request's first pull, answered before the host recorded an invalidation of the render's tag,
   * says nothing of it, and nor does the host's word, given after.
   */
  it('does not answer a superseded request from the render where the host recorded an invalidation of its tag after its first pull', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const askIn = Promise.withResolvers<true>();
    const asked = Promise.withResolvers<undefined>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    says.attemptHeld = askIn.promise;
    says.attemptReached = () => {
      asked.resolve(undefined);
    };
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await asked.promise;
    // The request's first pull is in, and quiet, before the host records the invalidation.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    says.delta = 'invalidated';
    askIn.resolve(true);
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    answerIn.resolve(true);
    const outcome = await later;
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.publishing).toBeUndefined();
  });

  it('does not answer a superseded request from the render where its own pull brings an invalidation of the render’s tag', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const deltaIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    // Since the host named the generation, it has recorded an invalidation of the feed's tag: the
    // superseded request's own pull brings it, and is still out when the publish's answer comes in.
    says.delta = 'invalidated';
    says.deltaHeld = deltaIn.promise;
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    answerIn.resolve(true);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    deltaIn.resolve(true);
    const outcome = await later;
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.publishing).toBeUndefined();
  });

  it('does not answer a request turned away for the lease given back where its own pull brings an invalidation of the render’s tag', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    // The host has yet to say it has the lease given back, while the next request is turned away.
    const returnIn = Promise.withResolvers<true>();
    const says: HostSays = {
      ...quietHost(),
      answerHeld: answerIn.promise,
      failHeld: returnIn.promise,
    };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    // Since the host named the generation, it has recorded an invalidation of the feed's tag: the
    // next request's own pull brings it, and is still out when the publish's answer comes in.
    const deltaIn = Promise.withResolvers<true>();
    says.busy = true;
    says.holder = 'attempt-2';
    says.delta = 'invalidated';
    says.deltaHeld = deltaIn.promise;
    const turnedAway = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(attemptsAsked(authority)).toBe(3);
    });
    answerIn.resolve(true);
    await later;
    deltaIn.resolve(true);
    const busy = await turnedAway;
    returnIn.resolve(true);
    commits.release();
    await Promise.all(behind);

    expect(busy.kind).toBe('busy');
    expect(busy.kind === 'busy' && busy.publishing).toBeUndefined();
  });

  it('answers a request turned away for the lease given back from the render kept with it, after that render’s publish has settled', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const returnIn = Promise.withResolvers<true>();
    const says: HostSays = {
      ...quietHost(),
      answerHeld: answerIn.promise,
      failHeld: returnIn.promise,
    };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    // The publish's answer comes in, and its render goes from what the isolate is publishing; the
    // host has yet to say it has the lease given back, and turns the next request away for it.
    answerIn.resolve(true);
    const outcome = await later;
    says.busy = true;
    says.holder = 'attempt-2';
    const busy = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    const keptWhileOut = runtime.givenBack.size;
    returnIn.resolve(true);
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind).toBe('superseded');
    expect(busy.kind === 'busy' && busy.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    // Kept with the lease though the host has said it has it back, and let go of once it lapses.
    expect([keptWhileOut, runtime.givenBack.size]).toStrictEqual([1, 1]);
    await expect(
      withClock(T0 + SECOND + HOLD + 61 * SECOND, () =>
        Promise.resolve(runtime.givenBack.get('attempt-2')),
      ),
    ).resolves.toBeUndefined();
  });

  /**
   * Only while the lease given back stands by the time the request's own pull is in: one that has
   * lapsed meanwhile may have let another attempt take the entry and publish a later generation.
   */
  it('does not answer a request turned away for the lease given back from the render where that lease has lapsed by then', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    answerIn.resolve(true);
    const outcome = await later;
    says.busy = true;
    says.holder = 'attempt-2';
    says.holderUntil = T0 + SECOND + HOLD - 1;
    const busy = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    const kept = runtime.givenBack.size;
    commits.release();
    await Promise.all(behind);

    expect(outcome.kind).toBe('superseded');
    expect(kept).toBe(1);
    expect(busy.kind).toBe('busy');
    expect(busy.kind === 'busy' && busy.publishing).toBeUndefined();
  });

  /**
   * The pull a request turned away for the lease given back asked for with its lease may answer
   * before the host records an invalidation of the render's tag: the request's pull is asked for
   * again once the host's answer is in, beside the render's publish.
   */
  it('does not answer a request turned away for the lease given back from the render where an invalidation lands before the host turns it away', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const busyIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];
    let pullsAnswered = 0;

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    answerIn.resolve(true);
    await later;
    says.busy = true;
    says.holder = 'attempt-2';
    says.busyHeld = busyIn.promise;
    says.deltaAnswered = () => {
      pullsAnswered += 1;
    };
    const turnedAway = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect([pullsAnswered, attemptsAsked(authority)]).toStrictEqual([1, 3]);
    });
    says.delta = 'invalidated';
    busyIn.resolve(true);
    const busy = await turnedAway;
    commits.release();
    await Promise.all(behind);

    expect(busy.kind).toBe('busy');
    expect(busy.kind === 'busy' && busy.publishing).toBeUndefined();
  });

  /**
   * Nor where the host's answer that turns it away names the generation condemned since: an
   * invalidation the host recorded reached it.
   */
  it('does not answer a request turned away for the lease given back from the render where the host names its generation condemned', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    const named = committedAs('generation-1', authority);
    says.current = named;
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    answerIn.resolve(true);
    await later;
    says.busy = true;
    says.holder = 'attempt-2';
    says.busyCurrent = {
      ...(named as Record<string, unknown>),
      condemned: { revision: 99, staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND },
    };
    const busy = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    commits.release();
    await Promise.all(behind);

    expect(busy.kind).toBe('busy');
    expect(busy.kind === 'busy' && busy.publishing).toBeUndefined();
  });

  it('answers a request turned away for the lease given back whose answer comes in after the host has answered that lease’s return', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const returnIn = Promise.withResolvers<true>();
    const busyIn = Promise.withResolvers<true>();
    const says: HostSays = {
      ...quietHost(),
      answerHeld: answerIn.promise,
      failHeld: returnIn.promise,
    };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    // The host turns the next request away for that lease, and the answer that says so is still on
    // its way when the host's answer to the lease's return comes in.
    says.busy = true;
    says.holder = 'attempt-2';
    says.busyHeld = busyIn.promise;
    const turnedAway = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(attemptsAsked(authority)).toBe(3);
    });
    answerIn.resolve(true);
    returnIn.resolve(true);
    await later;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const keptWhileOut = runtime.givenBack.size;
    busyIn.resolve(true);
    const busy = await turnedAway;
    commits.release();
    await Promise.all(behind);

    expect(busy.kind === 'busy' && busy.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    expect([keptWhileOut, runtime.givenBack.size]).toStrictEqual([1, 1]);
  });

  it('keeps a given-back render until its lease lapses, though the host has it back and an answer to a lease asked for meanwhile never comes', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const returnIn = Promise.withResolvers<true>();
    const says: HostSays = {
      ...quietHost(),
      answerHeld: answerIn.promise,
      failHeld: returnIn.promise,
    };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    // The next request's lease is asked for, and its request ends before the answer: it never comes.
    says.busy = true;
    says.holder = 'attempt-2';
    says.busyHeld = new Promise<never>(() => {
      // Never settles.
    });
    const stalled = regenerateFeed(runtime, [], T0 + SECOND + HOLD, { replaces: 'generation-0' });
    await vi.waitFor(() => {
      expect(attemptsAsked(authority)).toBe(3);
    });
    answerIn.resolve(true);
    returnIn.resolve(true);
    await later;
    commits.release();
    await Promise.all(behind);

    expect(runtime.givenBack.size).toBe(1);
    // The minute's lease lapsed: the host can no longer name it.
    await expect(
      withClock(T0 + SECOND + HOLD + 61 * SECOND, () =>
        Promise.resolve(runtime.givenBack.get('attempt-2')),
      ),
    ).resolves.toBeUndefined();
    // That request is still waiting for an answer that never comes.
    await expect(Promise.race([stalled, Promise.resolve('waiting')])).resolves.toBe('waiting');
  });

  it('answers from the render with a lease given back for as long as the lease, past the hold, where the host did not answer its return', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise, failRefused: true };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];
    vi.spyOn(runtime, 'log').mockImplementation(vi.fn());

    const first = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    answerIn.resolve(true);
    await later;
    await Promise.all(behind);
    // Three holds on, within the minute's lease the host may still hold.
    says.busy = true;
    says.holder = 'attempt-2';
    const busy = await regenerateFeed(runtime, behind, T0 + SECOND + 3 * HOLD, {
      replaces: 'generation-0',
    });
    commits.release();
    await Promise.all(behind);

    expect(busy.kind === 'busy' && busy.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
  });

  /**
   * However many requests the host leased the entry to while its publish was out, each superseded
   * and giving its lease back with the one render: kept with every lease, the render takes its room
   * once, though it is larger than half of what the isolate keeps, and no count of leases pushes one
   * out.
   */
  it('keeps a render given back with many leases, in the room it takes once', async () => {
    const runtime = runtimeFor(fakeAuthority(SCOPE).fetchImpl);
    const kept = keptRender(Math.floor(PUBLISHING_BYTES * 0.6));

    await withClock(T0, () => {
      return Promise.all(
        Array.from({ length: 80 }, (_, index) => {
          return givingBack(
            runtime,
            [kept],
            {
              attemptId: `attempt-${String(index + 2)}`,
              leaseExpiresAt: T0 + 60 * SECOND,
              current: { generationId: 'generation-1' },
            },
            Promise.resolve(),
          );
        }),
      );
    });

    expect(runtime.givenBack.size).toBe(80);
  });

  /** The records of the leases given back are bounded themselves, whatever their render takes. */
  it('keeps no more leases given back than it counts, however little their render takes', async () => {
    const runtime = runtimeFor(fakeAuthority(SCOPE).fetchImpl);
    const kept = keptRender(1);

    await withClock(T0, () => {
      return Promise.all(
        Array.from({ length: GIVEN_BACK_ENTRIES + 4 }, (_, index) => {
          return givingBack(
            runtime,
            [kept],
            {
              attemptId: `attempt-${String(index + 2)}`,
              leaseExpiresAt: T0 + 60 * SECOND,
              current: { generationId: 'generation-1' },
            },
            Promise.resolve(),
          );
        }),
      );
    });

    expect(runtime.givenBack.size).toBe(GIVEN_BACK_ENTRIES);
  });

  it('keeps the render with a lease given back where the host did not answer its return', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise, failRefused: true };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];
    vi.spyOn(runtime, 'log').mockImplementation(vi.fn());

    const first = await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    says.current = committedAs('generation-1', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    answerIn.resolve(true);
    await later;
    await Promise.all(behind);
    // The host may hold that lease still, and turns the next request away for it.
    says.busy = true;
    says.holder = 'attempt-2';
    const busy = await regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    commits.release();
    await Promise.all(behind);

    expect(busy.kind === 'busy' && busy.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    expect(runtime.givenBack.size).toBe(1);
  });

  it('answers at once from a render whose own pull brought an invalidation of its tag stamped after the pull was asked for', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    // The host recorded the invalidation while the pull was on its way, and stamped it by its own
    // clock later than the moment the pull was asked for: the pull brings it all the same.
    const says: HostSays = {
      ...quietHost(),
      delta: 'invalidated',
      invalidatedAt: T0 + SECOND + 89,
    };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    const again = await regenerateFeed(runtime, behind, T0 + 2 * SECOND);
    commits.release();
    await Promise.all(behind);

    expect(again.kind).toBe('busy');
    expect(again.kind === 'busy' && again.publishing?.html).toStrictEqual(
      first.kind === 'accepted' && first.render.html,
    );
    expect(attemptsAsked(authority)).toBe(1);
  });

  it('answers no request at once from a render whose publish let go of its lease, though the hold still covers it', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const answerIn = Promise.withResolvers<true>();
    const says: HostSays = { ...quietHost(), answerHeld: answerIn.promise };
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    await vi.waitFor(() => {
      expect(authority.commits).toHaveLength(1);
    });
    // The host leases the entry, its lease let go of, naming a generation that is not the render's.
    says.current = committedAs('generation-9', authority);
    const later = regenerateFeed(runtime, behind, T0 + SECOND + HOLD, {
      replaces: 'generation-0',
    });
    await vi.waitFor(() => {
      expect(authority.failures).toHaveLength(1);
    });
    // A request within the hold of the render's pull, which would have been answered at once.
    const within = regenerateFeed(runtime, behind, T0 + 2 * SECOND, {
      replaces: 'generation-0',
    });
    answerIn.resolve(true);
    const outcomes = await Promise.all([later, within]);
    commits.release();
    await Promise.all(behind);

    expect(outcomes.map((outcome) => outcome.kind)).toStrictEqual(['superseded', 'superseded']);
    expect(
      outcomes.map((outcome) => outcome.kind === 'superseded' && outcome.publishing),
    ).toStrictEqual([undefined, undefined]);
  });

  it('is not answered with the render half a minute after it was made', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    await regenerateFeed(runtime, behind);
    says.busy = true;
    const later = await regenerateFeed(runtime, behind, T0 + 31 * SECOND);
    commits.release();
    await Promise.all(behind);

    expect(later.kind).toBe('busy');
    expect(later.kind === 'busy' && later.publishing).toBeUndefined();
  });

  it('goes to the host where the entry’s id cannot be derived, and its render answers the next', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('no digest here'));

    const first = await regenerateFeed(runtime, behind);
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(first.kind).toBe('accepted');
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(true);
    expect(attemptsAsked(authority)).toBe(1);
  });

  it('asks the host where the render’s own pull did not answer', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const says = quietHost();
    says.delta = 'failing';
    const commits = holdingCommits(authority, says);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    // The render goes ahead on the view the isolate held, as before, and is published; it is not
    // kept to answer, its view being older than the moment it asked for one.
    const first = await regenerateFeed(runtime, behind);
    const held = runtime.publishing.size;
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(first.kind).toBe('accepted');
    expect(held).toBe(0);
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  it('asks the host where the render carries more tags than a generation may', async () => {
    const tags = Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_tag, index) => `tag-${index}`);
    rendering(undefined, tags.join(','));
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    const held = runtime.publishing.size;
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(first.kind).toBe('accepted');
    // Each publish refuses its render before anything is sent.
    expect(authority.failures).toHaveLength(2);
    expect(held).toBe(0);
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });

  it('asks the host where the render carries a tag longer than a generation’s may be', async () => {
    rendering(undefined, `${FEED_TAG},${'t'.repeat(MAX_TAG_LENGTH + 1)}`);
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    const held = runtime.publishing.size;
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(first.kind).toBe('accepted');
    expect(held).toBe(0);
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    // Each publish refuses its render before anything is sent, and says why.
    expect(authority.uploads.size).toBe(0);
    expect(authority.failures.map((failure) => failure.error?.code)).toStrictEqual([
      'tag_too_long',
      'tag_too_long',
    ]);
  });

  it('asks the host where the render is larger than all the renders kept may hold', async () => {
    rendering(PUBLISHING_BYTES + 1);
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const behind: Promise<unknown>[] = [];

    const first = await regenerateFeed(runtime, behind);
    const held = runtime.publishing.size;
    const second = await regenerateFeed(runtime, behind);
    commits.release();
    await Promise.all(behind);

    expect(first.kind).toBe('accepted');
    expect(held).toBe(0);
    // This authority leases every attempt: what matters is that the host was asked.
    expect(second.kind === 'busy' && second.publishing !== undefined).toBe(false);
    expect(attemptsAsked(authority)).toBe(2);
  });
});

/** A Pages Router member the build left to the first request for it: rendered, then kept. */
const POST: GenerationSource = {
  route: '/posts/[slug]',
  pathname: '/posts/a',
  url: '/posts/a',
  representation: 'html',
  onMiss: 'render',
};

/** A deployment whose one route is the post's, with its class's shell and nothing else. */
function postStore(): Store {
  const prerender = {
    id: POST.route,
    pathname: POST.route,
    route: POST.route,
    parentOutputId: POST.route,
    groupId: 1,
  };
  return {
    manifest: {
      buildId: 'build',
      entrypoints: [{ pathname: POST.route, kind: 'pages' }],
      config: { basePath: '', i18n: null },
    },
    prerendersByPathname: new Map(),
    shellsByRoute: new Map([
      [POST.route, { pages: new Map(), patterns: [{ pattern: /^\//u, prerender }] }],
    ]),
  } as unknown as Store;
}

/** The post as each render makes it, afresh, answered with `headers` besides its own. */
function renderingPosts(headers: Readonly<Record<string, string>> = {}): void {
  let renders = 0;
  vi.mocked(invokeNodeHandler).mockImplementation(() => {
    renders += 1;
    return Promise.resolve(
      new Response(`<html>post a, render ${String(renders)}</html>`, {
        headers: {
          'content-type': 'text/html',
          'cache-control': 's-maxage=60, stale-while-revalidate=31535940',
          ...headers,
        },
      }),
    );
  });
}

/**
 * A visitor's request for the post, served from the entry's generation as the Function serves it,
 * the work it hands on kept in `kept`.
 */
async function servePost(
  runtime: CacheRuntime,
  kept: Promise<unknown>[] = [],
  context: RequestContext = requestKeeping(runtime, kept),
): Promise<Response | undefined> {
  const input: RoutedInput = {
    app: { entries: {} },
    edge: { entries: {} },
    request: new Request(`https://app.test${POST.url}`),
    waitUntil: (promise) => {
      kept.push(promise);
    },
    cache: runtime,
    initURL: `https://app.test${POST.url}`,
    run: (work) => work(),
  };
  return withRequestContext(context, () =>
    withClock(T0, () => serveFromGeneration(input, postStore(), POST, handler)),
  );
}

/** What an answer carries besides where it says it came from: the outcome, and the cache's word. */
function carried(response: Response | undefined): Record<string, string> {
  const headers = new Headers(response?.headers);
  headers.delete(CACHE_OUTCOME_HEADER);
  headers.delete(NEXT_CACHE_HEADER);
  return Object.fromEntries(headers);
}

describe('a visitor of the isolate that is publishing the page they ask for', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('is answered with the page being published, and told so', async () => {
    renderingPosts();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);

    const first = await servePost(runtime);
    const second = await servePost(runtime);
    const renders = vi.mocked(invokeNodeHandler).mock.calls.length;
    commits.release();

    expect(first?.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
    expect(second?.headers.get(CACHE_OUTCOME_HEADER)).toBe('publishing');
    await expect(second?.text()).resolves.toBe(await first?.text());
    expect(renders).toBe(1);
  });

  it('is answered with the page being published, the end of the answer held for that publish as the first one’s is', async () => {
    renderingPosts();
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const kept: Promise<unknown>[] = [];
    const first = requestKeeping(runtime, kept);
    const second = requestKeeping(runtime, kept);

    await servePost(runtime, kept, first);
    const answered = await servePost(runtime, kept, second);
    // The post had no generation: both answers wait for the first one's publish to land, so that a
    // request after either finds it, in whatever isolate.
    const held = [first.writes.pending, second.writes.pending];
    commits.release();
    await Promise.all(kept);

    expect(answered?.headers.get(CACHE_OUTCOME_HEADER)).toBe('publishing');
    expect(held).toStrictEqual([true, true]);
  });

  it('is answered with what the page’s generation carries, not all its render did', async () => {
    renderingPosts({
      'set-cookie': 'visitor=first',
      'x-arkor-private': 'the-platform',
      'x-frame-options': 'DENY',
    });
    const authority = fakeAuthority(SCOPE);
    const commits = holdingCommits(authority);
    const runtime = runtimeFor(commits.fetchImpl);
    const kept: Promise<unknown>[] = [];

    const first = await servePost(runtime, kept);
    const second = await servePost(runtime, kept);
    commits.release();
    await Promise.all(kept);
    const published = await servePost(runtime, kept);

    // The render made them, and the visitor it was made for was answered with them.
    expect(first?.headers.get('set-cookie')).toBe('visitor=first');
    expect(first?.headers.get('x-arkor-private')).toBe('the-platform');
    expect(second?.headers.get(CACHE_OUTCOME_HEADER)).toBe('publishing');
    expect(second?.headers.has('set-cookie')).toBe(false);
    expect(second?.headers.has('x-arkor-private')).toBe(false);
    // The page's type, its lifetime and the rest as an answer from the generation carries them.
    expect(published?.headers.get(NEXT_CACHE_HEADER)).toBe('HIT');
    expect(published?.headers.get('x-frame-options')).toBe('DENY');
    expect(carried(second)).toStrictEqual(carried(published));
  });
});
