import {
  type DecodedGenerationPack,
  decodeGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  type GenerationPackHeader,
  PACK_SCHEMA_VERSION,
  packBodyDigests,
  policyFromCacheControl,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import { CACHE_OUTCOME_HEADER } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import { withRequestContext } from '../src/cache/context.ts';
import { currentGeneration } from '../src/cache/current.ts';
import { readData, readNewerData, writeData } from '../src/cache/data.ts';
import { configureCacheHandlers, useCacheHandler } from '../src/cache/handlers.ts';
import { heldIn, laterIfAny, type Weighing } from '../src/cache/held-reads.ts';
import { HeldTags } from '../src/cache/held-tags.ts';
import { type HeldValue, heldOut, keepWrite, tableOf } from '../src/cache/held-writes.ts';
import type { CacheHost, CurrentSummary, DataRead, FetchLike } from '../src/cache/host.ts';
import { regenerate, type RegenerationOutcome } from '../src/cache/regenerate.ts';
import { type CacheRuntime, createCacheRuntime, type DataMemo } from '../src/cache/runtime.ts';
import { type GenerationSource, serveFromGeneration } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';
import { requestKeeping } from './request-context.ts';

// The time each test had where this suite ran before: it renders through the runtime and the
// function-side cache host, and several of its tests take a second or two on a quiet machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * A generation another isolate published, read by one whose host answers with what a later one
 * replaced — or with none — for as long as the host's cache keeps that answer: a host that keeps the
 * later one nearer (`readNewerRecord`, `getNewerData`) is asked for it, where the read found the
 * entry missing or no longer fresh, and never where it found it fresh. A regeneration that finds a
 * later generation standing gives its lease back rather than replace it with a render of the same
 * thing; the isolate that publishes holds the record its commit handed back; and the answer made
 * from a regeneration ends once its publish has landed.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_laterGenerationsTest0';
const T0 = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE_MS = 60 * SECOND;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const PAGE: RouteEntryDescriptor = { kind: 'app-page', route: '/page', pathname: '/page' };
const PAGE_TAG = '_N_T_/page';
const FEED: RouteEntryDescriptor = { kind: 'app-route', route: '/api/feed', pathname: '/api/feed' };
const LIFETIME = policyFromCacheControl({ revalidate: 900, expire: 31_536_000 });
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Nothing here runs a handler: the bridge that would is replaced, and says what it answers. */
const handler: NodeHandler = () => Promise.reject(new Error('the bridge is replaced'));

/** A request's turn among its calls to the host that makes each call at once. */
function atOnce<T>(call: () => Promise<T>): Promise<T> {
  return call();
}

function ignore(): void {
  /* The reads a test makes are awaited by the test itself. */
}

/** A delivery record of `descriptor`'s generation `seq`, made at `at`, holding `html`. */
async function recordOf(
  descriptor: RouteEntryDescriptor,
  generation: {
    readonly seq: number;
    readonly at: number;
    readonly html: string;
    readonly status?: number;
    readonly source?: 'build' | 'runtime';
  },
): Promise<Uint8Array> {
  const body = encoder.encode(generation.html);
  const { entryId } = await deriveEntry(SCOPE, descriptor);
  const header: GenerationPackHeader = {
    schemaVersion: PACK_SCHEMA_VERSION,
    scopeId: SCOPE,
    entryId,
    generationId: `generation-later-${String(generation.seq)}`,
    seq: generation.seq,
    source: generation.source ?? 'runtime',
    kind: descriptor.kind,
    route: descriptor.route,
    pathname: descriptor.pathname,
    cacheTimestamp: generation.at,
    producedAt: generation.at,
    policy: LIFETIME,
    status: generation.status ?? 200,
    headers: {},
    tags: [{ kind: 'next-implicit', value: PAGE_TAG }],
    ...(await packBodyDigests(body, undefined)),
    artifacts: [],
    revision: generation.seq,
  };
  return encodeGenerationPack(header, body, undefined);
}

/** A clock that stays at `T0`, as the runtime's tests mostly need. */
const STILL = { now: T0 } as const;

/**
 * What a render that read nothing through the data cache held of its tags: each through the view it
 * read against (`HeldTags`), closed as a regeneration closes it once its render is over.
 */
function heldOfNoReads(): HeldTags {
  const held = new HeldTags();
  held.close();
  return held;
}

function runtimeFor(fetchImpl: FetchLike, clock: { readonly now: number } = STILL): CacheRuntime {
  const runtime = createCacheRuntime({ env: ENV, now: () => clock.now, fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

/** A weighing that judges every value fresh, and finds `now` where it reads the key again. */
function holding(now: HeldValue | undefined): Weighing {
  return { judge: () => Promise.resolve('fresh'), reread: () => Promise.resolve(now) };
}

/** The value a read found, as a read holds it. */
function heldFrom(memo: DataMemo): HeldValue {
  const held = heldIn(memo);
  if (held === undefined) {
    throw new Error('the value was not read');
  }
  return held;
}

/** `runtime` with its host's calls named in `over` answered there, and the rest as before. */
function hostedBy(runtime: CacheRuntime, over: Partial<CacheHost>): CacheRuntime {
  const host = new Proxy(runtime.host, {
    get(target, property) {
      if (Object.hasOwn(over, property)) {
        return Reflect.get(over, property) as unknown;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { ...runtime, host };
}

/** An authority holding the page's build generation, seq 1, made at `T0`. */
async function authorityWithPage(): Promise<FakeAuthority> {
  const authority = fakeAuthority(SCOPE);
  await authority.record(
    PAGE,
    {
      cacheTimestamp: T0,
      policy: LIFETIME,
      status: 200,
      headers: {},
      tags: [{ kind: 'next-implicit', value: PAGE_TAG }],
    },
    encoder.encode('<html>build</html>'),
    'build',
  );
  return authority;
}

function recordReads(authority: FakeAuthority): number {
  return authority.calls.filter((call) => call.endsWith('/record')).length;
}

async function htmlAt(runtime: CacheRuntime, now: number) {
  const lookup = await currentGeneration(runtime, PAGE, now, ignore);
  return lookup.kind === 'generation'
    ? { html: decoder.decode(lookup.current.pack.html), validity: lookup.current.validity }
    : { html: undefined, validity: lookup.kind };
}

describe('a record the host keeps later than the one read', () => {
  it('answers an entry the read found none of, and is held for the requests after', async () => {
    const authority = fakeAuthority(SCOPE);
    const later = await recordOf(PAGE, { seq: 2, at: T0, html: '<html>published</html>' });
    const asked: number[] = [];
    const runtime = hostedBy(runtimeFor(authority.fetchImpl), {
      readNewerRecord: (_entryId, than) => {
        asked.push(than);
        return Promise.resolve(later);
      },
    });

    const first = await htmlAt(runtime, T0 + SECOND);
    const second = await htmlAt(runtime, T0 + SECOND);

    expect(first).toStrictEqual({ html: '<html>published</html>', validity: 'fresh' });
    expect(second).toStrictEqual(first);
    expect(asked).toStrictEqual([0]);
    expect(recordReads(authority)).toBe(1);
  });

  it('answers in place of a record an invalidation expired, made after it', async () => {
    const authority = await authorityWithPage();
    const later = await recordOf(PAGE, {
      seq: 2,
      at: T0 + 3 * SECOND,
      html: '<html>published</html>',
    });
    const runtime = hostedBy(runtimeFor(authority.fetchImpl), {
      readNewerRecord: (_entryId, than) => Promise.resolve(than < 2 ? later : undefined),
    });
    runtime.tags.applyLocal([PAGE_TAG], {
      staleAt: T0 + 2 * SECOND,
      hardExpireAt: T0 + 2 * SECOND,
    });

    await expect(htmlAt(runtime, T0 + 4 * SECOND)).resolves.toStrictEqual({
      html: '<html>published</html>',
      validity: 'fresh',
    });
  });

  it('is passed over where a visitor may not be answered with it', async () => {
    const authority = fakeAuthority(SCOPE);
    // A redirect that says not where it leads.
    const nowhere = await recordOf(PAGE, { seq: 2, at: T0, html: '', status: 307 });
    const runtime = hostedBy(runtimeFor(authority.fetchImpl), {
      readNewerRecord: () => Promise.resolve(nowhere),
    });

    await expect(htmlAt(runtime, T0 + SECOND)).resolves.toStrictEqual({
      html: undefined,
      validity: 'none',
    });
  });

  it('gives way to a later generation this isolate came to hold while the host was asked', async () => {
    const authority = fakeAuthority(SCOPE);
    const published = packOf(await recordOf(PAGE, { seq: 3, at: T0, html: '<html>three</html>' }));
    const base = runtimeFor(authority.fetchImpl);
    const { entryId } = await deriveEntry(SCOPE, PAGE);
    const runtime = hostedBy(base, {
      readNewerRecord: () => {
        // Another request's commit lands while this one asks, and the host keeps nothing nearer.
        base.recordMemo.set(entryId, published);
        return Promise.resolve(undefined);
      },
    });

    await expect(htmlAt(runtime, T0 + SECOND)).resolves.toStrictEqual({
      html: '<html>three</html>',
      validity: 'fresh',
    });
  });

  it('answers with a servable later record where the isolate holds a later one no visitor may have', async () => {
    const authority = fakeAuthority(SCOPE);
    const nowhere = packOf(await recordOf(PAGE, { seq: 4, at: T0, html: '', status: 307 }));
    const later = await recordOf(PAGE, { seq: 3, at: T0, html: '<html>three</html>' });
    const base = runtimeFor(authority.fetchImpl);
    const { entryId } = await deriveEntry(SCOPE, PAGE);
    const runtime = hostedBy(base, {
      readNewerRecord: () => {
        // Another request's read leaves the isolate holding a redirect that says not where to.
        base.recordMemo.set(entryId, nowhere);
        return Promise.resolve(later);
      },
    });

    const first = await htmlAt(runtime, T0 + SECOND);
    const next = await htmlAt(runtime, T0 + SECOND);

    expect(first).toStrictEqual({ html: '<html>three</html>', validity: 'fresh' });
    // Held for the requests after it too, in place of the redirect.
    expect(next).toStrictEqual(first);
    expect(base.recordMemo.get(entryId)?.header.seq).toBe(3);
  });

  it('is not asked for where the record read is fresh', async () => {
    const authority = await authorityWithPage();
    const readNewerRecord = vi.fn(() => Promise.resolve(undefined));
    const runtime = hostedBy(runtimeFor(authority.fetchImpl), { readNewerRecord });

    await expect(htmlAt(runtime, T0 + SECOND)).resolves.toStrictEqual({
      html: '<html>build</html>',
      validity: 'fresh',
    });
    expect(readNewerRecord).not.toHaveBeenCalled();
  });

  /** A commit of this isolate's can land while the later record is being read. */
  it('gives way to a later generation this isolate came to hold meanwhile', async () => {
    const authority = await authorityWithPage();
    const copied = await recordOf(PAGE, { seq: 2, at: T0 + 3 * SECOND, html: '<html>two</html>' });
    const published = await recordOf(PAGE, {
      seq: 3,
      at: T0 + 3 * SECOND,
      html: '<html>three</html>',
    });
    const base = runtimeFor(authority.fetchImpl);
    const { entryId } = await deriveEntry(SCOPE, PAGE);
    const runtime = hostedBy(base, {
      readNewerRecord: () => {
        const pack = decodeGenerationPack(published);
        if (pack.kind === 'ok') {
          base.recordMemo.set(entryId, pack.pack);
        }
        return Promise.resolve(copied);
      },
    });
    runtime.tags.applyLocal([PAGE_TAG], {
      staleAt: T0 + 2 * SECOND,
      hardExpireAt: T0 + 2 * SECOND,
    });

    await expect(htmlAt(runtime, T0 + 4 * SECOND)).resolves.toStrictEqual({
      html: '<html>three</html>',
      validity: 'fresh',
    });
  });

  it('is passed over where it is no later than the one read, or another entry’s', async () => {
    const authority = await authorityWithPage();
    const same = await recordOf(PAGE, { seq: 1, at: T0 + 3 * SECOND, html: '<html>same</html>' });
    const other = await recordOf(FEED, { seq: 9, at: T0 + 3 * SECOND, html: '<html>feed</html>' });
    const expire = (runtime: CacheRuntime): CacheRuntime => {
      runtime.tags.applyLocal([PAGE_TAG], {
        staleAt: T0 + 2 * SECOND,
        hardExpireAt: T0 + 2 * SECOND,
      });
      return runtime;
    };
    const behindIt = expire(
      hostedBy(runtimeFor(authority.fetchImpl), {
        readNewerRecord: () => Promise.resolve(same),
      }),
    );
    const elsewhere = expire(
      hostedBy(runtimeFor(authority.fetchImpl), {
        readNewerRecord: () => Promise.resolve(other),
      }),
    );

    await expect(htmlAt(behindIt, T0 + 4 * SECOND)).resolves.toStrictEqual({
      html: '<html>build</html>',
      validity: 'expired',
    });
    await expect(htmlAt(elsewhere, T0 + 4 * SECOND)).resolves.toStrictEqual({
      html: '<html>build</html>',
      validity: 'expired',
    });
  });
});

/** A delivery record, decoded as the isolate holds one. */
function packOf(bytes: Uint8Array): DecodedGenerationPack {
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') {
    throw new Error('the record does not decode');
  }
  return decoded.pack;
}

/** A delivery record of the feed's generation `seq`, decoded as the isolate holds one. */
async function heldFeed(seq: number): Promise<DecodedGenerationPack> {
  return packOf(await recordOf(FEED, { seq, at: T0, html: 'feed' }));
}

/** The feed as a render answers it, afresh each time: a body is read once. */
function regenerated(): Promise<Response> {
  return Promise.resolve(
    new Response('regenerated', { headers: { 'cache-control': 's-maxage=900' } }),
  );
}

/** The bridge answering every render with the feed, made afresh each time. */
function rendering(): void {
  vi.mocked(invokeNodeHandler).mockImplementation(regenerated);
}

/** A regeneration of the feed, for `reason`, in place of `replaces`, at `T0 + SECOND`. */
async function regenerateFeed(
  runtime: CacheRuntime,
  target: { readonly reason: 'expired' | 'manual'; readonly replaces?: string | null },
): Promise<{ readonly outcome: RegenerationOutcome; readonly behind: Promise<unknown>[] }> {
  const behind: Promise<unknown>[] = [];
  const outcome = await withClock(T0 + SECOND, () => {
    return regenerate({
      runtime,
      request: new Request('https://app.test/api/feed'),
      handler,
      target: { descriptor: FEED, ...target },
      previewToken: undefined,
      waitUntil: (promise) => {
        behind.push(promise);
      },
      run: (work) => work(),
    });
  });
  await Promise.all(behind);
  return { outcome, behind };
}

/**
 * `runtime`, its leases answered with `current` as the entry's generation, and with `record` as that
 * generation's record where one is given (`AttemptOutcome.record`).
 */
function standing(
  runtime: CacheRuntime,
  current: CurrentSummary,
  record?: Uint8Array,
): CacheRuntime {
  return hostedBy(runtime, {
    startAttempt: async (request) => {
      const outcome = await runtime.host.startAttempt(request);
      return outcome.kind === 'leased'
        ? { ...outcome, current, ...(record !== undefined && { record }) }
        : outcome;
    },
  });
}

const LATER: CurrentSummary = {
  generationId: 'generation-9',
  seq: 9,
  cacheTimestamp: T0,
  policy: LIFETIME,
  condemned: null,
  status: 200,
  location: null,
};

/** The generation the host names for the record `recordOf` makes of generation 9. */
const CARRIED: CurrentSummary = { ...LATER, generationId: 'generation-later-9', seq: 9 };

describe('a regeneration that finds a later generation standing', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('gives the lease back, and renders and publishes nothing', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const runtime = standing(runtimeFor(authority.fetchImpl), LATER);

    const { outcome } = await regenerateFeed(runtime, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect(outcome.kind).toBe('superseded');
    expect(invokeNodeHandler).not.toHaveBeenCalled();
    expect(authority.commits).toHaveLength(0);
    expect(authority.failures).toMatchObject([{ outcome: 'skipped' }]);
  });

  it('gives it back where the request found the entry missing as well', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const runtime = standing(runtimeFor(authority.fetchImpl), LATER);

    const { outcome } = await regenerateFeed(runtime, { reason: 'expired', replaces: null });

    expect(outcome.kind).toBe('superseded');
  });

  it('renders where what stands is the generation judged, or one an invalidation expired', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const judged = standing(runtimeFor(authority.fetchImpl), LATER);
    const condemned = standing(runtimeFor(authority.fetchImpl), {
      ...LATER,
      condemned: { revision: 10, staleAt: T0, hardExpireAt: T0 },
    });

    const same = await regenerateFeed(judged, { reason: 'expired', replaces: 'generation-9' });
    const expired = await regenerateFeed(condemned, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect([same.outcome.kind, expired.outcome.kind]).toStrictEqual(['accepted', 'accepted']);
    expect(authority.commits).toHaveLength(2);
  });

  it('renders where what stands answers no visitor, or the host says not whether it does', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const nowhere = standing(runtimeFor(authority.fetchImpl), { ...LATER, status: 307 });
    const unsaid = standing(runtimeFor(authority.fetchImpl), {
      generationId: LATER.generationId,
      seq: LATER.seq,
      cacheTimestamp: LATER.cacheTimestamp,
      policy: LATER.policy,
      condemned: null,
    });

    const redirect = await regenerateFeed(nowhere, { reason: 'expired', replaces: 'generation-1' });
    const silent = await regenerateFeed(unsaid, { reason: 'expired', replaces: 'generation-1' });

    expect([redirect.outcome.kind, silent.outcome.kind]).toStrictEqual(['accepted', 'accepted']);
  });

  it('keeps a record of what stands that the isolate learned meanwhile, and no earlier one', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const { entryId } = await deriveEntry(SCOPE, FEED);
    const learned = standing(runtimeFor(authority.fetchImpl), LATER);
    const judged = standing(runtimeFor(authority.fetchImpl), LATER);
    learned.recordMemo.set(entryId, await heldFeed(LATER.seq));
    judged.recordMemo.set(entryId, await heldFeed(1));

    await regenerateFeed(learned, { reason: 'expired', replaces: 'generation-1' });
    await regenerateFeed(judged, { reason: 'expired', replaces: 'generation-1' });

    expect(learned.recordMemo.get(entryId)?.header.seq).toBe(LATER.seq);
    expect(judged.recordMemo.get(entryId)).toBeUndefined();
  });

  /**
   * Another isolate published it, and nothing of it is here yet — not a render, not a record — so
   * the record the host's answer carried (`AttemptOutcome.record`) is what the request is answered
   * with, and what the requests after it find, rather than a page of the visitor's own.
   */
  it('comes back with the later generation the host’s answer carried, held for the requests after', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const { entryId } = await deriveEntry(SCOPE, FEED);
    const record = await recordOf(FEED, { seq: 9, at: T0, html: 'later feed' });
    const runtime = standing(runtimeFor(authority.fetchImpl), CARRIED, record);

    const { outcome } = await regenerateFeed(runtime, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.current?.pack.header.seq).toBe(9);
    expect(outcome.kind === 'superseded' && outcome.current?.validity).toBe('fresh');
    expect(runtime.recordMemo.get(entryId)?.header.seq).toBe(9);
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('passes over a carried record that is not the generation the host names', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const record = await recordOf(FEED, { seq: 8, at: T0, html: 'earlier feed' });
    const runtime = standing(runtimeFor(authority.fetchImpl), CARRIED, record);

    const { outcome } = await regenerateFeed(runtime, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.current).toBeUndefined();
  });

  /**
   * Nor where what this isolate knows of its tags says it is no longer fresh: an invalidation of its
   * own, in force here at once, that the host's answer could not speak for.
   */
  it('passes over a carried record this isolate knows an invalidation of', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const record = await recordOf(FEED, { seq: 9, at: T0, html: 'later feed' });
    const runtime = standing(runtimeFor(authority.fetchImpl), CARRIED, record);
    runtime.tags.applyLocal([PAGE_TAG], { staleAt: T0 + 1, hardExpireAt: null });

    const { outcome } = await regenerateFeed(runtime, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect(outcome.kind).toBe('superseded');
    expect(outcome.kind === 'superseded' && outcome.current).toBeUndefined();
  });

  /**
   * Taken once a pull of the tags asked for after the host's answer is in: an invalidation of its
   * tags the host recorded since keeps it from the request, as one it had recorded by then would.
   */
  it('passes over a carried record an invalidation recorded since the host’s answer reaches', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const record = await recordOf(FEED, { seq: 9, at: T0, html: 'later feed' });
    const base = standing(runtimeFor(authority.fetchImpl), CARRIED, record);
    let pulls = 0;
    const runtime = hostedBy(base, {
      tagsDelta: async (since) => {
        pulls += 1;
        return pulls === 1
          ? base.host.tagsDelta(since)
          : {
              revision: 99,
              truncated: false,
              tags: [{ value: PAGE_TAG, staleAt: T0 + 1, hardExpireAt: null, revision: 99 }],
            };
      },
    });

    const { outcome } = await regenerateFeed(runtime, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect(pulls).toBe(2);
    expect(outcome.kind === 'superseded' && outcome.current).toBeUndefined();
  });

  it('asks for no pull of its own where the host’s answer carried no record', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const base = standing(runtimeFor(authority.fetchImpl), CARRIED);
    let pulls = 0;
    const runtime = hostedBy(base, {
      tagsDelta: (since) => {
        pulls += 1;
        return base.host.tagsDelta(since);
      },
    });

    await regenerateFeed(runtime, { reason: 'expired', replaces: 'generation-1' });

    expect(pulls).toBe(1);
  });

  /** A render of this isolate's being published that no visitor may be answered with answers none. */
  it('comes back with the carried generation where the render being published may not answer', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const { entryId } = await deriveEntry(SCOPE, FEED);
    const record = await recordOf(FEED, { seq: 9, at: T0, html: 'later feed' });
    const runtime = hostedBy(runtimeFor(authority.fetchImpl), {
      startAttempt: () => {
        return Promise.resolve({
          kind: 'busy',
          current: CARRIED,
          record,
          attemptId: 'attempt-publishing',
          leaseExpiresAt: T0 + 60 * SECOND,
        });
      },
    });
    // A redirect that says not where to, its publish still out, its pull past the hold.
    runtime.publishing.set(entryId, {
      render: {
        html: new Uint8Array(),
        postponed: undefined,
        rscData: undefined,
        segments: new Map(),
        headers: {},
        status: 307,
        cacheControl: { revalidate: 900 },
        data: undefined,
      },
      attemptId: 'attempt-publishing',
      tags: [PAGE_TAG],
      observedTagRevision: runtime.tags.revision,
      observedLosses: runtime.tags.losses.count,
      held: heldOfNoReads(),
      observedAt: T0 - 10 * SECOND,
      published: new Promise(() => {
        // Still out.
      }),
    });

    const { outcome } = await regenerateFeed(runtime, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect(outcome.kind === 'busy' && outcome.publishing?.status).toBe(307);
    expect(outcome.kind === 'busy' && outcome.current?.pack.header.seq).toBe(9);
  });

  /**
   * So too where the render this isolate published of that generation may not answer: a redirect
   * that says not where to is no page to answer with.
   */
  it('comes back with the carried generation where its own render of it may not answer', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const { entryId } = await deriveEntry(SCOPE, FEED);
    const record = await recordOf(FEED, { seq: 9, at: T0, html: 'later feed' });
    const runtime = standing(runtimeFor(authority.fetchImpl), CARRIED, record);
    runtime.publishing.set(entryId, {
      render: {
        html: new Uint8Array(),
        postponed: undefined,
        rscData: undefined,
        segments: new Map(),
        headers: {},
        status: 307,
        cacheControl: { revalidate: 900 },
        data: undefined,
      },
      attemptId: 'attempt-published',
      tags: [PAGE_TAG],
      observedTagRevision: runtime.tags.revision,
      observedLosses: runtime.tags.losses.count,
      held: heldOfNoReads(),
      observedAt: T0 - 10 * SECOND,
      published: Promise.resolve({ kind: 'published', generationId: CARRIED.generationId }),
    });

    const { outcome } = await regenerateFeed(runtime, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect(outcome.kind === 'superseded' && outcome.publishing?.status).toBe(307);
    expect(outcome.kind === 'superseded' && outcome.current?.pack.header.seq).toBe(9);
  });

  /** A lease turned away, where the host's answer names a later generation and carries its record. */
  it('comes back with the later generation a busy answer carried', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const record = await recordOf(FEED, { seq: 9, at: T0, html: 'later feed' });
    const runtime = hostedBy(runtimeFor(authority.fetchImpl), {
      startAttempt: () => {
        return Promise.resolve({
          kind: 'busy',
          current: CARRIED,
          record,
          attemptId: 'attempt-elsewhere',
          leaseExpiresAt: T0 + 60 * SECOND,
        });
      },
    });

    const { outcome } = await regenerateFeed(runtime, {
      reason: 'expired',
      replaces: 'generation-1',
    });

    expect(outcome.kind).toBe('busy');
    expect(outcome.kind === 'busy' && outcome.current?.pack.header.seq).toBe(9);
  });

  it('asks for the lease with the generation it judged, and with none for `revalidate()`', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const asked: unknown[] = [];
    const base = runtimeFor(authority.fetchImpl);
    const runtime = hostedBy(base, {
      startAttempt: (request) => {
        asked.push(request.replaces);
        return base.host.startAttempt(request);
      },
    });

    await regenerateFeed(runtime, { reason: 'expired', replaces: 'generation-1' });
    await regenerateFeed(runtime, { reason: 'expired', replaces: null });
    await regenerateFeed(runtime, { reason: 'manual' });

    expect(asked).toStrictEqual(['generation-1', null, undefined]);
  });

  it('renders for `revalidate()`, and where the request named nothing it replaces', async () => {
    rendering();
    const authority = fakeAuthority(SCOPE);
    const runtime = standing(runtimeFor(authority.fetchImpl), LATER);

    const manual = await regenerateFeed(runtime, { reason: 'manual', replaces: 'generation-1' });
    const unnamed = await regenerateFeed(runtime, { reason: 'expired' });

    expect([manual.outcome.kind, unnamed.outcome.kind]).toStrictEqual(['accepted', 'accepted']);
  });
});

describe('the record a commit hands back', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('is what the isolate that published answers the next request from, reading nothing', async () => {
    vi.mocked(invokeNodeHandler).mockImplementation(regenerated);
    const handing = fakeAuthority(SCOPE, { handsBackRecords: true });
    const silent = fakeAuthority(SCOPE);
    const held = runtimeFor(handing.fetchImpl);
    const reread = runtimeFor(silent.fetchImpl);

    await regenerateFeed(held, { reason: 'manual' });
    await regenerateFeed(reread, { reason: 'manual' });
    const answers = await Promise.all(
      [held, reread].map(async (runtime) => {
        const lookup = await currentGeneration(runtime, FEED, T0 + 2 * SECOND, ignore);
        return lookup.kind === 'generation' ? decoder.decode(lookup.current.pack.html) : undefined;
      }),
    );

    expect(answers).toStrictEqual(['regenerated', 'regenerated']);
    expect([recordReads(handing), recordReads(silent)]).toStrictEqual([0, 1]);
  });
});

/** The post's page as a render answers it, afresh each time: a body is read once. */
function postPage(): Promise<Response> {
  return Promise.resolve(
    new Response('<html>post a</html>', {
      headers: {
        'content-type': 'text/html',
        'cache-control': 's-maxage=60, stale-while-revalidate=31535940',
      },
    }),
  );
}

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

describe('an answer made from a regeneration', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('hands its publish to the request, whose answer ends once it has landed', async () => {
    vi.mocked(invokeNodeHandler).mockImplementation(postPage);
    const authority = fakeAuthority(SCOPE);
    const gate = Promise.withResolvers<true>();
    const runtime = runtimeFor(async (request) => {
      const answer = await authority.fetchImpl(request);
      if (new URL(request.url).pathname.endsWith('/commit')) {
        await gate.promise;
      }
      return answer;
    });
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);
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

    const response = await withRequestContext(context, () =>
      withClock(T0, () => serveFromGeneration(input, postStore(), POST, handler)),
    );
    const whileOut = context.writes.pending;
    gate.resolve(true);
    await context.writes.landed(10 * SECOND);

    expect(response?.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
    expect(whileOut).toBe(true);
    expect(context.writes.pending).toBe(false);
    expect(authority.commits).toHaveLength(1);
  });

  /**
   * A later generation another isolate published stands, and the host's answer for the lease
   * carried its record: the visitor is answered with it, as from a record read, rather than with a
   * render of their own that no other request is answered with.
   */
  it('answers with the later generation the host’s answer carried, rendering nothing', async () => {
    vi.mocked(invokeNodeHandler).mockImplementation(postPage);
    const authority = fakeAuthority(SCOPE);
    const descriptor = { kind: 'pages', route: POST.route, pathname: POST.pathname } as const;
    await authority.record(
      descriptor,
      {
        cacheTimestamp: T0 - 10 * SECOND,
        policy: LIFETIME,
        status: 200,
        headers: {},
        tags: [],
        invalidation: { revision: 1, staleAt: T0 - SECOND, hardExpireAt: T0 - SECOND },
      },
      encoder.encode('<html>post before</html>'),
      'runtime',
    );
    const record = await recordOf(descriptor, { seq: 9, at: T0, html: '<html>post later</html>' });
    const carrying = standing(runtimeFor(authority.fetchImpl), CARRIED, record);
    const silent = standing(runtimeFor(authority.fetchImpl), CARRIED);

    const answers = await Promise.all(
      [carrying, silent].map(async (runtime) => {
        const kept: Promise<unknown>[] = [];
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
        const response = await withRequestContext(requestKeeping(runtime, kept), () =>
          withClock(T0, () => serveFromGeneration(input, postStore(), POST, handler)),
        );
        await Promise.allSettled(kept);
        return [response?.headers.get(CACHE_OUTCOME_HEADER), await response?.text()];
      }),
    );

    expect(answers).toStrictEqual([
      ['superseded', '<html>post later</html>'],
      ['superseded', '<html>post a</html>'],
    ]);
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  /**
   * A carried generation the build made, which holds no output of the kind asked for, leaves the
   * build's own to answer, as a record read does, rather than a render of the request.
   */
  it('leaves the build’s output to answer where the carried generation holds none of the kind asked for', async () => {
    vi.mocked(invokeNodeHandler).mockImplementation(postPage);
    const authority = fakeAuthority(SCOPE);
    const descriptor = { kind: 'pages', route: POST.route, pathname: POST.pathname } as const;
    const { entryId } = await deriveEntry(SCOPE, descriptor);
    await authority.record(
      descriptor,
      {
        cacheTimestamp: T0 - 10 * SECOND,
        policy: LIFETIME,
        status: 200,
        headers: {},
        tags: [],
        invalidation: { revision: 1, staleAt: T0 - SECOND, hardExpireAt: T0 - SECOND },
      },
      encoder.encode('<html>post before</html>'),
      'runtime',
    );
    const record = await recordOf(descriptor, {
      seq: 9,
      at: T0,
      html: '<html>post later</html>',
      source: 'build',
    });
    const runtime = standing(runtimeFor(authority.fetchImpl), CARRIED, record);
    const kept: Promise<unknown>[] = [];
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

    const response = await withRequestContext(requestKeeping(runtime, kept), () => {
      return withClock(T0, () => {
        return serveFromGeneration(
          input,
          postStore(),
          { ...POST, representation: 'pages-data' },
          handler,
        );
      });
    });
    await Promise.allSettled(kept);

    expect(runtime.recordMemo.get(entryId)?.header.seq).toBe(9);
    expect(response).toBeUndefined();
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  /**
   * An expired entry's regeneration publishes behind its answer: the generation before it is there
   * to be judged, and a publish behind a broad invalidation waits for that invalidation's records to
   * be rewritten — a page held open meanwhile is one the browser has not finished loading.
   */
  it('ends without waiting for the publish where the entry had expired', async () => {
    vi.mocked(invokeNodeHandler).mockImplementation(postPage);
    const authority = fakeAuthority(SCOPE);
    await authority.record(
      { kind: 'pages', route: POST.route, pathname: POST.pathname },
      {
        cacheTimestamp: T0 - 10 * SECOND,
        policy: LIFETIME,
        status: 200,
        headers: {},
        tags: [],
        invalidation: { revision: 1, staleAt: T0 - SECOND, hardExpireAt: T0 - SECOND },
      },
      encoder.encode('<html>post before</html>'),
      'runtime',
    );
    const gate = Promise.withResolvers<true>();
    const runtime = runtimeFor(async (request) => {
      const answer = await authority.fetchImpl(request);
      if (new URL(request.url).pathname.endsWith('/commit')) {
        await gate.promise;
      }
      return answer;
    });
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);
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

    const response = await withRequestContext(context, () =>
      withClock(T0, () => serveFromGeneration(input, postStore(), POST, handler)),
    );
    const whileOut = context.writes.pending;
    gate.resolve(true);
    await Promise.allSettled(kept);

    expect(response?.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
    expect(whileOut).toBe(false);
    expect(authority.commits).toHaveLength(1);
  });
});

const PRODUCTS_KEY = 'products-key';
const { entryId: PRODUCTS_ENTRY_ID } = await deriveEntry(SCOPE, {
  kind: 'data:use-cache',
  handler: 'default',
  key: PRODUCTS_KEY,
});

describe('a value the host keeps later than the one read', () => {
  const KEY = PRODUCTS_KEY;
  const READ: DataRead = {
    entryId: PRODUCTS_ENTRY_ID,
    generationId: 'generation-3',
    dependencyRevision: 3,
    entry: {
      kind: 'data:use-cache',
      handler: 'default',
      tags: ['products'],
      stale: 0,
      timestamp: T0 - 10 * SECOND,
      expire: 31_536_000,
      revalidate: 900,
    },
    value: { kind: 'inline', base64: btoa('before') },
  };
  const LATER_VALUE: DataRead = {
    ...READ,
    generationId: 'generation-5',
    dependencyRevision: 5,
    entry: { ...READ.entry, timestamp: T0 - SECOND },
    value: { kind: 'inline', base64: btoa('after') },
  };

  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  const REQUEST = { key: KEY, kind: 'data:use-cache', handler: 'default' } as const;

  /** The authority's reads, KV holding `READ` for the key. */
  const answering: FetchLike = (request) => {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/tags/get')) {
      return Promise.resolve(Response.json({ ok: true, result: { tags: [] } }));
    }
    if (pathname.endsWith('/data/get')) {
      // As the gateway answers it, saying how much of the value's dependencies it covers.
      return Promise.resolve(
        Response.json({
          ok: true,
          result: { ...READ, entry: { ...READ.entry, dependencyCoverage: 'complete' } },
        }),
      );
    }
    return Promise.resolve(new Response('not a read', { status: 500 }));
  };

  /** What the default `use cache` handler answers for the key, KV holding `READ`. */
  async function readUseCache(
    over: Partial<CacheHost>,
    read: 'fresh' | 'stale' | 'expired',
  ): Promise<string | undefined> {
    const runtime = hostedBy(runtimeFor(answering), over);
    if (read !== 'fresh') {
      // The value read was written before an invalidation of its tag, outright or with a window.
      runtime.tags.applyLocal(['products'], {
        staleAt: T0 - 5 * SECOND,
        hardExpireAt: read === 'expired' ? T0 - 5 * SECOND : T0 + MINUTE_MS,
      });
    }
    configureCacheHandlers(runtime);
    const entry = await withClock(T0, () => useCacheHandler('default').get(KEY, []));
    return entry === undefined ? undefined : new Response(entry.value).text();
  }

  it('answers in place of a value an invalidation expired', async () => {
    const asked: number[] = [];
    const getNewerData = (_request: unknown, than: number): Promise<DataRead | undefined> => {
      asked.push(than);
      return Promise.resolve(LATER_VALUE);
    };

    await expect(readUseCache({ getNewerData }, 'expired')).resolves.toBe('after');
    expect(asked).toStrictEqual([3]);
  });

  /**
   * A read that judged its value expired computes it again otherwise, in front of the render, and so
   * waits longer for a later value than a read that judged its value stale, which answers with that
   * at once otherwise: the host can keep the later value in another region than the one it reads
   * from. A read of it that crosses there is past the stale read's wait, and within the expired's.
   */
  it('is waited for longer past an expired value than past a stale one', async () => {
    const CROSSING_MS = 300;
    const crossing = (): Promise<DataRead | undefined> => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(LATER_VALUE);
        }, CROSSING_MS);
      });
    };
    const nearby = vi.fn(() => Promise.resolve(LATER_VALUE));

    await expect(readUseCache({ getNewerData: crossing }, 'expired')).resolves.toBe('after');
    await expect(readUseCache({ getNewerData: nearby }, 'stale')).resolves.toBe('after');
    await expect(readUseCache({ getNewerData: crossing }, 'stale')).resolves.toBe('before');
  });

  /**
   * The host answers with the nearest value it keeps first — a copy beside its reads — which can
   * have been written before an invalidation the read knows of; asked past it, it answers with one
   * further off.
   */
  it('asks past a later value that stands no better than stale, once', async () => {
    const beforeInvalidation: DataRead = {
      ...LATER_VALUE,
      dependencyRevision: 4,
      entry: { ...READ.entry, timestamp: T0 - 7 * SECOND },
      value: { kind: 'inline', base64: btoa('copied') },
    };
    const asked: number[] = [];
    const getNewerData = (_request: unknown, than: number): Promise<DataRead | undefined> => {
      asked.push(than);
      return Promise.resolve(than < 4 ? beforeInvalidation : LATER_VALUE);
    };
    const everExpired: number[] = [];
    const neverFresh = (_request: unknown, than: number): Promise<DataRead | undefined> => {
      everExpired.push(than);
      return Promise.resolve({ ...beforeInvalidation, dependencyRevision: than + 1 });
    };

    await expect(readUseCache({ getNewerData }, 'expired')).resolves.toBe('after');
    expect(asked).toStrictEqual([3, 4]);
    await expect(readUseCache({ getNewerData: neverFresh }, 'expired')).resolves.toBeUndefined();
    expect(everExpired).toStrictEqual([3, 4]);
  });

  /**
   * A later value taken is kept only once nothing more is asked: a write of the key that begins
   * while the host is asked past it overtakes it, and what the isolate holds now is answered.
   */
  it('keeps no later value a write overtook while one past it was asked for', async () => {
    const isolate: { runtime?: CacheRuntime } = {};
    const stale: DataRead = { ...LATER_VALUE, dependencyRevision: 4 };
    const runtime = hostedBy(runtimeFor(answering), {
      getNewerData: (_request, than) => {
        if (than < 4) {
          return Promise.resolve(stale);
        }
        // The write is still out when the host answers: it fences the reads under way.
        if (isolate.runtime !== undefined) {
          const written = { key: KEY, entry: READ.entry, bytes: encoder.encode('written') };
          void writeData(isolate.runtime, written).catch(ignore);
        }
        return Promise.resolve(undefined);
      },
      setData: () => {
        return new Promise(() => {
          // The write never lands while the test looks.
        });
      },
    });
    isolate.runtime = runtime;
    const held = heldFrom(await withClock(T0, () => readData(runtime, REQUEST)));
    const written: HeldValue = { ...held, bytes: encoder.encode('written') };
    const weighing: Weighing = {
      judge: (value) => Promise.resolve(value.revision === 4 ? 'stale' : 'fresh'),
      reread: () => Promise.resolve(written),
    };

    const answered = await withClock(T0, () =>
      laterIfAny(runtime, REQUEST, { held, validity: 'expired' }, weighing),
    );

    expect(answered).toStrictEqual({ held: written, validity: 'fresh' });
  });

  /**
   * The value past the first is a probe: one that cannot be read whole, or stands worse than the
   * first, moves nothing of the key, and the first is kept as it would have been.
   */
  it('keeps the first where the one past it cannot be read whole, or stands worse', async () => {
    const stale: DataRead = { ...LATER_VALUE, dependencyRevision: 4 };
    const unreadable: DataRead = {
      ...LATER_VALUE,
      dependencyRevision: 6,
      value: { kind: 'ref', artifactId: 'artifact-later' },
    };
    const worse: DataRead = { ...LATER_VALUE, dependencyRevision: 6 };
    const weighing: Weighing = {
      judge: (value) => Promise.resolve(value.revision === 4 ? 'stale' : 'expired'),
      reread: () => Promise.resolve(undefined),
    };
    const answers = [];
    const remembered = [];
    for (const past of [unreadable, worse]) {
      const runtime = hostedBy(runtimeFor(answering), {
        getNewerData: (_request, than) => Promise.resolve(than < 4 ? stale : past),
        readArtifact: () => Promise.reject(new Error('storage is out')),
      });
      const held = heldFrom(await withClock(T0, () => readData(runtime, REQUEST)));
      answers.push(
        await withClock(T0, () =>
          laterIfAny(runtime, REQUEST, { held, validity: 'expired' }, weighing),
        ),
      );
      remembered.push(await withClock(T0, () => readData(runtime, REQUEST)));
    }

    expect(answers).toMatchObject([
      { held: { revision: 4 }, validity: 'stale' },
      { held: { revision: 4 }, validity: 'stale' },
    ]);
    expect(remembered).toMatchObject([
      { kind: 'found', response: { dependencyRevision: 4 } },
      { kind: 'found', response: { dependencyRevision: 4 } },
    ]);
  });

  /** What overtakes the first overtakes what is asked past it as well. */
  it('answers what the isolate holds where a write began while the first was judged', async () => {
    const isolate: { runtime?: CacheRuntime } = {};
    const stale: DataRead = { ...LATER_VALUE, dependencyRevision: 4 };
    const runtime = hostedBy(runtimeFor(answering), {
      getNewerData: (_request, than) => Promise.resolve(than < 4 ? stale : LATER_VALUE),
      setData: () => {
        return new Promise(() => {
          // The write never lands while the test looks.
        });
      },
    });
    isolate.runtime = runtime;
    const held = heldFrom(await withClock(T0, () => readData(runtime, REQUEST)));
    const written: HeldValue = { ...held, bytes: encoder.encode('written') };
    const weighing: Weighing = {
      judge: (value) => {
        if (value.revision !== 4) {
          return Promise.resolve('fresh');
        }
        if (isolate.runtime !== undefined) {
          const write = { key: KEY, entry: READ.entry, bytes: encoder.encode('written') };
          void writeData(isolate.runtime, write).catch(ignore);
        }
        return Promise.resolve('stale');
      },
      reread: () => Promise.resolve(written),
    };

    const answered = await withClock(T0, () =>
      laterIfAny(runtime, REQUEST, { held, validity: 'expired' }, weighing),
    );

    expect(answered).toStrictEqual({ held: written, validity: 'fresh' });
  });

  /**
   * A write handed over while the key's write before it is still out goes out only once that one
   * has, and is what a read of the key here answers with meanwhile: it overtakes the values asked
   * for as a write that goes out at once does.
   */
  it('answers a write handed over behind one still out while the first was judged', async () => {
    const stale: DataRead = { ...LATER_VALUE, dependencyRevision: 4 };
    const runtime = hostedBy(runtimeFor(answering), {
      getNewerData: (_request, than) => Promise.resolve(than < 4 ? stale : LATER_VALUE),
      setData: () => {
        return new Promise(() => {
          // The first write never lands while the test looks, and the second waits for it.
        });
      },
    });
    const writes = tableOf(runtime, 'test', 'test', () => atOnce);
    const handOver = (text: string): void => {
      const write = { key: KEY, entry: READ.entry, bytes: encoder.encode(text) };
      void keepWrite(runtime, writes, write).catch(ignore);
    };
    handOver('first');
    const held = heldFrom(await withClock(T0, () => readData(runtime, REQUEST)));
    const weighing: Weighing = {
      judge: (value) => {
        if (value.revision !== 4) {
          return Promise.resolve('fresh');
        }
        handOver('second');
        return Promise.resolve('stale');
      },
      reread: () => Promise.resolve(heldOut(writes, KEY)),
    };

    const answered = await withClock(T0, () =>
      laterIfAny(runtime, REQUEST, { held, validity: 'expired' }, weighing),
    );
    const remembered = await withClock(T0, () => readData(runtime, REQUEST));

    expect(answered).toStrictEqual({
      held: { entry: READ.entry, bytes: encoder.encode('second') },
      validity: 'fresh',
    });
    // Nothing later is remembered; nor is the host's answer, from before the value the first ask
    // learned of.
    expect(remembered).toStrictEqual({ kind: 'missing' });
  });

  /**
   * As a write that goes out at once does, a write handed over behind another forgets what was
   * remembered of the key as it is handed over: a read that does not answer from the write — a
   * regeneration's — asks the host, rather than answering with what was read before it.
   */
  it('forgets what was remembered of the key as a write is handed over behind another', async () => {
    const asked: string[] = [];
    const counted: FetchLike = (request) => {
      asked.push(new URL(request.url).pathname);
      return answering(request);
    };
    const runtime = hostedBy(runtimeFor(counted), {
      setData: () => {
        return new Promise(() => {
          // The first write never lands while the test looks, and the second waits for it.
        });
      },
    });
    const writes = tableOf(runtime, 'test', 'test', () => atOnce);
    const handOver = (text: string): void => {
      const write = { key: KEY, entry: READ.entry, bytes: encoder.encode(text) };
      void keepWrite(runtime, writes, write).catch(ignore);
    };
    const hostReads = (): number => asked.filter((path) => path.endsWith('/data/get')).length;
    handOver('first');
    // Read, and remembered, while the first write is out.
    await readData(runtime, REQUEST);
    const before = hostReads();

    handOver('second');
    const read = await readData(runtime, REQUEST);

    expect(hostReads() - before).toBe(1);
    expect(read).toMatchObject({ kind: 'found', response: { dependencyRevision: 3 } });
  });

  it('is passed over, and not remembered, where it stands worse than the value read', async () => {
    const expired: DataRead = {
      ...LATER_VALUE,
      invalidation: { revision: 6, staleAt: T0 - SECOND, hardExpireAt: T0 - SECOND },
    };
    const getNewerData = vi.fn((): Promise<DataRead | undefined> => Promise.resolve(expired));

    await expect(readUseCache({ getNewerData }, 'stale')).resolves.toBe('before');
    expect(getNewerData).toHaveBeenCalledTimes(1);
  });

  it('is passed over where its bytes cannot be read', async () => {
    const stored: DataRead = {
      ...LATER_VALUE,
      value: { kind: 'ref', artifactId: 'artifact-later' },
    };

    await expect(
      readUseCache(
        {
          getNewerData: () => Promise.resolve(stored),
          readArtifact: () => Promise.reject(new Error('storage is out')),
        },
        'expired',
      ),
    ).resolves.toBeUndefined();
  });

  it('is not asked for where the value read is fresh', async () => {
    const getNewerData = vi.fn(() => Promise.resolve(LATER_VALUE));

    await expect(readUseCache({ getNewerData }, 'fresh')).resolves.toBe('before');
    expect(getNewerData).not.toHaveBeenCalled();
  });

  it('gives way to what the isolate holds now where a write of the key began while it was read', async () => {
    const isolate: { runtime?: CacheRuntime } = {};
    const runtime = hostedBy(runtimeFor(answering), {
      getNewerData: () => {
        // The write is still out when the later value comes back: it fences the reads under way.
        if (isolate.runtime !== undefined) {
          const written = { key: KEY, entry: READ.entry, bytes: encoder.encode('written') };
          void writeData(isolate.runtime, written).catch(ignore);
        }
        return Promise.resolve(LATER_VALUE);
      },
      setData: () => {
        return new Promise(() => {
          // The write never lands while the test looks.
        });
      },
    });
    isolate.runtime = runtime;
    const held = heldFrom(await withClock(T0, () => readData(runtime, REQUEST)));
    const written: HeldValue = { ...held, bytes: encoder.encode('written') };

    const answered = await withClock(T0, () =>
      laterIfAny(runtime, REQUEST, { held, validity: 'stale' }, holding(written)),
    );
    const missed = await withClock(T0, () =>
      laterIfAny(runtime, REQUEST, { held, validity: 'stale' }, holding(undefined)),
    );

    expect(answered).toStrictEqual({ held: written, validity: 'fresh' });
    expect(missed).toBeUndefined();
  });

  it('is passed over where it cannot be judged in time', async () => {
    const runtime = hostedBy(runtimeFor(answering), {
      getNewerData: () => Promise.resolve(LATER_VALUE),
    });
    const held = heldFrom(await withClock(T0, () => readData(runtime, REQUEST)));
    const stalled: Weighing = {
      judge: () => {
        return new Promise(() => {
          // Its tags are never brought up to date.
        });
      },
      reread: () => Promise.resolve(undefined),
    };

    const judged = await withClock(T0, () =>
      laterIfAny(runtime, REQUEST, { held, validity: 'stale' }, stalled),
    );

    expect(judged).toStrictEqual({ held, validity: 'stale' });
  });

  it('orders the key from its revision though its bytes cannot be read', async () => {
    const clock = { now: T0 };
    const runtime = hostedBy(runtimeFor(answering, clock), {
      getNewerData: () =>
        Promise.resolve({ ...LATER_VALUE, value: { kind: 'ref', artifactId: 'artifact-later' } }),
      readArtifact: () => Promise.reject(new Error('storage is out')),
    });
    await readData(runtime, REQUEST);

    const later = await readNewerData(runtime, REQUEST, READ.dependencyRevision);
    // The value read is remembered no longer, and KV still answers with it.
    clock.now += MINUTE_MS;
    const again = await readData(runtime, REQUEST);

    expect(later).toBeUndefined();
    expect(again).toStrictEqual({ kind: 'missing' });
  });
});
