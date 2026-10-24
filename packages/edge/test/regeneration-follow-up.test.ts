// eslint-disable-next-line no-restricted-imports, import-x/no-nodejs-modules -- a synchronous SHA-256 keeps each record check within its turn; serving stays runtime-neutral.
import { createHash } from 'node:crypto';

import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  encodeGenerationPack,
  type GenerationPackHeader,
  kvGenerationKey,
  PACK_SCHEMA_VERSION,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContinuationHandle, ContinuationStart } from '../../host/src/delivery/strategy.ts';
import { claimBackgroundRecord } from '../src/cache/background-record-budget.ts';
import { takeInvalidation } from '../src/cache/condemned.ts';
import { readGeneration } from '../src/cache/generation-loader.ts';
import { type HostedDocumentInput, routeHostedDocument } from '../src/handlers/hosted-document.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import type { ShellLoadResult } from '../src/strategies/shell-loader.ts';

/**
 * The record a regeneration the edge asked for publishes, read for by the edge itself: the document
 * path as it runs — the record read, its
 * staleness judged, the ask made beside the resume or on its own, the splice — with only the
 * Function's answer and the authority's records made up, and the clock the test's.
 */

const startResume = vi.hoisted(() =>
  vi.fn<(input: ContinuationStart<EdgeContext>) => ContinuationHandle>(),
);
vi.mock(import('../src/strategies/continuation-resume.ts'), () => {
  const resumeContinuation = { start: startResume };
  return { resumeContinuation };
});
vi.mock(import('../src/handlers/middleware.ts'), async (original) => {
  const middleware = await original();
  return { ...middleware, middlewareMatches: vi.fn(() => false) };
});
vi.mock(import('../src/strategies/shell-loader.ts'), async (original) => {
  return {
    ...(await original()),
    loadShell: vi.fn<() => Promise<ShellLoadResult>>(() => Promise.resolve({ kind: 'missing' })),
  };
});

const T0 = 1_800_000_000_000;
const SCOPE = 'dpl_follow_up';
const ENTRY_ID = 'ent_follow_up';
const KEY = { scopeId: SCOPE, entryId: ENTRY_ID };
const RECORD_KEY = kvGenerationKey(SCOPE, ENTRY_ID);
const ROUTE = '/partially-static';
const SETTINGS = DEFAULT_DELIVERY_POLICY.runtimeCache!;
/** When the authority holds the regenerated record, and when the next visitor comes after it. */
const COMMITTED_AT = T0 + 1200;
const NEXT_VISIT_AT = T0 + 1600;
/** Long after everything a visit set off is over. */
const LATER = T0 + 10_000;
const SUFFIX = '<script>resumed()</script></body></html>';
const OUTCOME_HEADER = 'x-arkor-cache-outcome';
const REGENERATE_HEADER = 'x-arkor-regenerate';
/** A tag of the application's own, which an invalidation of every tag reaches. */
const TAGS: GenerationPackHeader['tags'] = [{ kind: 'next-explicit', value: 'posts' }];
const MIB = 1024 * 1024;
/** The largest record the edge holds from the authority (`MAX_RECORD_BYTES`). */
const MAX_RECORD_BYTES = 4 * MIB;
/** Where a pack names its version: after its magic, `PPRG`. */
const PACK_MAGIC_LENGTH = 4;

function entryOf(delivery: 'resume' | 'complete'): RouteEntry {
  return {
    pathname: ROUTE,
    status: 200,
    shell: {
      sha256: 'a'.repeat(64),
      byteLength: 10,
      contentType: 'text/html',
      encoding: 'identity',
    },
    headers: {},
    prerenderId: ROUTE,
    cache: { entryId: ENTRY_ID, kind: 'app-page', delivery },
  };
}

/** What a record carries besides the page's date. */
interface RecordOptions {
  readonly tags?: GenerationPackHeader['tags'];
  /** Bytes of whitespace after the date, which weigh the record as a heavy page's. */
  readonly padding?: number;
}

/**
 * The page's record at `revision`, rendered at `cacheTimestamp` and revalidated a second on: a shell
 * with the state its resume completes, or a document complete in itself.
 */
async function record(
  revision: number,
  cacheTimestamp: number,
  resumed: boolean,
  options: RecordOptions = {},
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const date = `<p id="date">date ${revision}</p>${' '.repeat(options.padding ?? 0)}`;
  const html = encoder.encode(`<html><body>${date}${resumed ? '' : '</body></html>'}`);
  const state = resumed ? encoder.encode(`{"postponed":${revision}}`) : undefined;
  const header: GenerationPackHeader = {
    schemaVersion: 1,
    scopeId: SCOPE,
    entryId: ENTRY_ID,
    generationId: `gen_${revision}`,
    seq: revision,
    revision,
    source: 'runtime',
    kind: 'app-page',
    route: ROUTE,
    pathname: ROUTE,
    cacheTimestamp,
    producedAt: cacheTimestamp,
    policy: policyFromBuild({ initialRevalidate: 1, initialExpiration: 300 }),
    status: 200,
    headers: { 'content-type': 'text/html' },
    tags: options.tags ?? [],
    htmlSha256: await sha256Hex(html),
    htmlLength: html.byteLength,
    postponedSha256: state === undefined ? null : await sha256Hex(state),
    postponedLength: state?.byteLength ?? 0,
    artifacts: [],
  };
  return new Uint8Array(encodeGenerationPack(header, html, state)).buffer;
}

/**
 * `bytes` as a record of the next pack version, which this edge does not read: the byte after the
 * pack's magic, which names its version, set one past the edge's.
 */
function laterVersion(bytes: ArrayBuffer): ArrayBuffer {
  const pack = Uint8Array.from(new Uint8Array(bytes));
  pack[PACK_MAGIC_LENGTH] = PACK_SCHEMA_VERSION + 1;
  return pack.buffer;
}

/** The edge's clock: the test's, moved by its fake timers. */
function now(): number {
  return Date.now();
}

/** What the Function's answer says of the regeneration asked of it: `undefined` says nothing. */
function said(outcome: string | undefined): Record<string, string> {
  return outcome === undefined ? {} : { [OUTCOME_HEADER]: outcome };
}

/** A record the authority holds from `at` on, as the entry's current one. */
interface Published {
  readonly at: number;
  readonly revision: number;
  readonly bytes: ArrayBuffer;
}

/**
 * The authority as it answers a read of the entry's record: the latest of those it holds by now,
 * where that one is later than the revision the read asks after; nothing otherwise.
 */
function answering(
  published: readonly Published[],
): (scope: string, entry: string, after: number) => Promise<ArrayBuffer | undefined> {
  return (_scope, _entry, after) => {
    const latest = published.findLast((one) => now() >= one.at);
    return Promise.resolve(
      latest !== undefined && latest.revision > after ? latest.bytes : undefined,
    );
  };
}

interface FixtureOptions {
  readonly delivery?: 'resume' | 'complete';
  readonly outcome?: string | undefined;
  /** When the record KV answers with was rendered: two seconds before the first visit, stale. */
  readonly renderedAt?: number;
  readonly regenerateCooldownMs?: number;
}

/**
 * One isolate of the edge, whose KV keeps answering with the record rendered at `renderedAt`, and
 * whose authority holds what `published` says from when it says.
 */
async function fixture(options: FixtureOptions = {}) {
  const delivery = options.delivery ?? 'resume';
  const resumed = delivery === 'resume';
  const outcome = 'outcome' in options ? options.outcome : 'accepted';
  const regional = { bytes: await record(1, options.renderedAt ?? T0 - 2000, resumed) };
  const published: { at: number; bytes: ArrayBuffer | undefined } = {
    at: COMMITTED_AT,
    bytes: await record(2, COMMITTED_AT, resumed),
  };
  const tasks: Promise<unknown>[] = [];
  const kv = vi.fn<() => Promise<ArrayBuffer | null>>(() => Promise.resolve(regional.bytes));
  const currentRecord = vi.fn<
    (scope: string, entry: string, after: number) => Promise<ArrayBuffer | undefined>
  >(() => Promise.resolve(now() >= published.at ? published.bytes : undefined));
  // A detached ask is answered at once, and its regeneration begun as it is (`handleDetached`).
  const dispatchApp = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 202, headers: said(outcome) })),
  );
  // A resume is answered saying what became of the ask; the regeneration begins once its body ends.
  startResume.mockImplementation(() => {
    return {
      response: Promise.resolve(
        new Response(SUFFIX, { headers: { 'content-type': 'text/html', ...said(outcome) } }),
      ),
      abort: vi.fn(),
    };
  });
  const entry = entryOf(delivery);
  const manifest = buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    originHost: 'app.test',
    generatedAt: '2026-10-23T00:00:00.000Z',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-23T00:00:00.000Z' },
    app: { deploymentId: SCOPE, scriptName: 'app' },
    cache: { keySchemaVersion: 1, scopeId: SCOPE },
    routes: [entry],
  });
  const runtimeCache = {
    ...SETTINGS,
    regenerateCooldownMs: options.regenerateCooldownMs ?? SETTINGS.regenerateCooldownMs,
  };
  const edge = {
    env: { CACHE_STATE: { get: kv } },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    runtime: { now, memory: createEdgeMemory(now), dispatchApp },
    host: {
      currentRecord,
      names: {},
      credentials: { cookies: [], headers: [] },
      observer: { metric: vi.fn(), recordServed: vi.fn() },
    },
    forwarding: { previewDomain: 'invalid', previewHost: 'app.test', clientIp: undefined },
    policy: { ...DEFAULT_DELIVERY_POLICY, runtimeCache },
    app: manifest.app,
    manifestId: 'manifest',
    projectId: 'project',
    validated: false,
    privateDelivery: false,
    cspNonce: false,
    cacheApi: false,
    timings: {},
  } as unknown as EdgeContext;
  /** A visitor's request for the page, answered: its body not read. */
  const open = async (init: RequestInit = {}): Promise<Response> => {
    const request = new Request(`https://app.test${ROUTE}`, {
      ...init,
      headers: { 'accept-encoding': 'identity' },
    });
    return await routeHostedDocument({
      request,
      url: new URL(request.url),
      edge,
      manifest,
      classification: { kind: 'document', entry },
      classifiedHeaders: request.headers,
      passthrough: () => Promise.resolve(new Response('the Function', { status: 500 })),
      resolved: { policy: DEFAULT_DELIVERY_POLICY, shell: { id: 'memory', getShell: vi.fn() } },
    } as unknown as HostedDocumentInput);
  };
  /** A visitor's request for the page, read to its end, and what the response set off behind it. */
  const visit = async (init: RequestInit = {}): Promise<string> => {
    const body = await (await open(init)).text();
    // The splice's end sets off what follows the regeneration: let that run without moving time.
    await vi.advanceTimersByTimeAsync(0);
    return body;
  };
  return {
    edge,
    regional,
    published,
    currentRecord,
    dispatchApp,
    open,
    visit,
    held: () => edge.runtime.memory.generations.get(RECORD_KEY)?.pack.header.revision,
    /** Move the clock to `at`, running what falls due on the way. */
    until: async (at: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(at - Date.now());
    },
    drain: async (): Promise<void> => {
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
    },
  };
}

/** What each resume was told of a regeneration asked beside it. */
function regenerationsAsked(): (string | undefined)[] {
  return startResume.mock.calls.map(([input]) => input.headers?.[REGENERATE_HEADER]);
}

describe('a regeneration the edge asked for, followed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // The digests a record is held to, computed at once: the checks of a read then end within the
    // turn its answer comes in, which a clock the test moves would otherwise outrun.
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      if (algorithm !== 'SHA-256') return digest(algorithm, data);
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      return Promise.resolve(Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('holds what the regeneration published before the next visitor, with none between', async () => {
    const test = await fixture();

    await expect(test.visit()).resolves.toContain('date 1');

    await test.until(NEXT_VISIT_AT);

    expect(test.held()).toBe(2);
    await expect(test.visit()).resolves.toContain('date 2');
    expect(test.currentRecord.mock.calls).toStrictEqual([
      [SCOPE, ENTRY_ID, 1],
      [SCOPE, ENTRY_ID, 1],
      [SCOPE, ENTRY_ID, 1],
    ]);
  });

  it('reads nothing of the authority behind the request that asks', async () => {
    const test = await fixture();

    await test.visit();

    await test.until(T0 + 799);

    expect(regenerationsAsked()).toStrictEqual(['background']);
    // What it asked for has not begun: a read now would find nothing of it.
    expect(test.currentRecord).not.toHaveBeenCalled();

    await test.until(LATER);

    await test.drain();
  });

  it("counts from the resume's end, where the runtime begins the regeneration", async () => {
    const test = await fixture();

    test.published.at = T0 + 2200;

    const ended = Promise.withResolvers<undefined>();
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode('<p>streamed</p>'));
          return;
        }
        await ended.promise;
        controller.enqueue(encoder.encode(SUFFIX));
        controller.close();
      },
    });
    startResume.mockImplementationOnce(() => {
      return {
        response: Promise.resolve(
          new Response(body, {
            headers: { 'content-type': 'text/html', [OUTCOME_HEADER]: 'accepted' },
          }),
        ),
        abort: vi.fn(),
      };
    });
    const visited = test.visit();

    await test.until(T0 + 1000);

    // Accepted at once, its body streaming still: the runtime has not begun the regeneration.
    expect(test.currentRecord).not.toHaveBeenCalled();

    ended.resolve(undefined);

    await expect(visited).resolves.toContain('date 1');

    await test.until(T0 + 1799);

    expect(test.currentRecord).not.toHaveBeenCalled();

    await test.until(T0 + 2500);

    expect(test.currentRecord).toHaveBeenCalledTimes(3);
    expect(test.held()).toBe(2);

    await test.until(LATER);

    await test.drain();
  });

  it('counts its four seconds from where a long resume ends, not from the ask', async () => {
    const test = await fixture();

    test.published.at = T0 + 4600;

    const ended = Promise.withResolvers<undefined>();
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode('<p>streamed</p>'));
          return;
        }
        await ended.promise;
        controller.enqueue(encoder.encode(SUFFIX));
        controller.close();
      },
    });
    startResume.mockImplementationOnce(() => {
      return {
        response: Promise.resolve(
          new Response(body, {
            headers: { 'content-type': 'text/html', [OUTCOME_HEADER]: 'accepted' },
          }),
        ),
        abort: vi.fn(),
      };
    });
    const visited = test.visit();

    // Past where four seconds from the ask would leave the follow-up no read at all.
    await test.until(T0 + 3500);

    ended.resolve(undefined);

    await expect(visited).resolves.toContain('date 1');

    await test.until(T0 + 4299);

    expect(test.currentRecord).not.toHaveBeenCalled();

    await test.until(T0 + 4900);

    // 0.8 s and 1.1 s from the resume's end, where the runtime began the regeneration.
    expect(test.currentRecord).toHaveBeenCalledTimes(2);
    expect(test.held()).toBe(2);

    await test.until(LATER);

    await test.drain();
  });

  it('follows an accepted resume whose visitor left before a splice held it', async () => {
    const test = await fixture();
    const visitor = new AbortController();

    startResume.mockImplementationOnce(() => {
      // Gone before the splice: the resume is released unread, which the runtime takes for done
      // with, and begins the regeneration it accepted.
      visitor.abort();
      return {
        response: Promise.resolve(
          new Response(SUFFIX, {
            headers: { 'content-type': 'text/html', [OUTCOME_HEADER]: 'accepted' },
          }),
        ),
        abort: vi.fn(),
      };
    });

    await test.visit({ signal: visitor.signal });

    await test.until(LATER);

    expect(test.currentRecord).toHaveBeenCalledTimes(3);
    expect(test.held()).toBe(2);

    await test.drain();
  });

  it('stops once the isolate holds a later record, however it came', async () => {
    const test = await fixture();

    await test.visit();

    await test.until(T0 + 500);

    // KV catches up, and a read of the entry brings the later record before the follow-up reads.
    test.regional.bytes = test.published.bytes!;

    await readGeneration(test.edge, KEY, SETTINGS);

    expect(test.held()).toBe(2);

    await test.until(LATER);

    expect(test.currentRecord).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('reads no more once it holds the record, and leaves nothing behind', async () => {
    const test = await fixture();

    await test.visit();

    await test.until(LATER);

    expect(test.held()).toBe(2);
    expect(test.currentRecord).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('stops at its bound when nothing is published: eleven reads, none four seconds on', async () => {
    const test = await fixture();

    test.published.bytes = undefined;

    const readAt: number[] = [];

    test.currentRecord.mockImplementation(() => {
      readAt.push(Date.now() - T0);
      return Promise.resolve(undefined);
    });

    await test.visit();

    await test.until(LATER);

    expect(readAt).toStrictEqual([800, 1100, 1400, 1700, 2000, 2300, 2600, 2900, 3200, 3500, 3800]);
    expect(test.held()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('reads on past a later record it will not hold, for the one the regeneration publishes', async () => {
    const test = await fixture();

    test.regional.bytes = await record(1, T0 - 2000, true, { tags: TAGS });

    // The authority holds a later record than the one served, which another isolate's regeneration
    // published before this one was asked for; what this one publishes comes after it.
    test.currentRecord.mockImplementation(
      answering([
        { at: T0, revision: 2, bytes: await record(2, T0 - 1000, true, { tags: TAGS }) },
        {
          at: COMMITTED_AT,
          revision: 4,
          bytes: await record(4, COMMITTED_AT, true, { tags: TAGS }),
        },
      ]),
    );

    await expect(test.visit()).resolves.toContain('date 1');

    await test.until(T0 + 500);

    // A response this isolate passes on says its request invalidated every tag at once, at
    // revision 3 — more of them than its header names: every tagged record of the scope from before
    // that is condemned here, the one served and the authority's, which nothing it invalidated
    // touched there.
    takeInvalidation(test.edge.runtime.memory, SCOPE, { value: '*', bound: '3' });

    await test.until(NEXT_VISIT_AT);

    expect(test.held()).toBe(4);
    await expect(test.visit()).resolves.toContain('date 4');
    // 0.8 s on, the authority's record, refused; then, asked after it, nothing 1.1 s on, and the
    // regeneration's 1.4 s on: the record refused is not sent again.
    expect(test.currentRecord.mock.calls).toStrictEqual([
      [SCOPE, ENTRY_ID, 1],
      [SCOPE, ENTRY_ID, 2],
      [SCOPE, ENTRY_ID, 2],
    ]);
    expect(test.currentRecord).toHaveNthResolvedWith(2, undefined);

    await test.drain();
  });

  it.each([
    ['past the largest the edge holds', { padding: MAX_RECORD_BYTES }, false],
    ['of a pack version this edge does not read', {}, true],
  ])(
    'reads no more once the authority answers with a record %s',
    async (_what, options, unread) => {
      const test = await fixture();
      const bytes = await record(2, T0 - 1000, true, options);

      // The authority holds it from before the follow-up's first read: a record no further read
      // could bring this isolate to hold, nor the one the regeneration publishes, of the same page
      // and from the same writer.
      test.published.at = T0;

      test.published.bytes = unread ? laterVersion(bytes) : bytes;

      await test.visit();

      await test.until(LATER);

      expect(test.currentRecord.mock.calls).toStrictEqual([[SCOPE, ENTRY_ID, 1]]);
      expect(test.held()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      await test.drain();
    },
  );

  it.each([
    ['skipped', 'skipped'],
    ['says nothing of it', undefined],
  ])(
    'follows nothing where the answer %s, and reads the authority once, as a request that asked for nothing would',
    async (_said, outcome) => {
      const test = await fixture({ outcome });

      await test.visit();

      await test.until(NEXT_VISIT_AT);

      // The read the asking request left to a follow-up that will not come, made as the answer came.
      expect(test.currentRecord).toHaveBeenCalledTimes(1);
      expect(test.held()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(test.visit()).resolves.toContain('date 1');

      await test.drain();
    },
  );

  it('follows an accepted resume whose answer came after its splice had ended', async () => {
    const test = await fixture();
    const answer = Promise.withResolvers<Response>();
    startResume.mockImplementationOnce(() => ({ response: answer.promise, abort: vi.fn() }));

    // The visitor goes before the resume answers: the splice ends, the answer not yet in.
    const response = await test.open();
    await response.body?.cancel();
    await vi.advanceTimersByTimeAsync(0);

    expect(test.currentRecord).not.toHaveBeenCalled();

    answer.resolve(
      new Response(SUFFIX, {
        headers: { 'content-type': 'text/html', [OUTCOME_HEADER]: 'accepted' },
      }),
    );

    await test.until(LATER);

    expect(test.currentRecord).toHaveBeenCalledTimes(3);
    expect(test.held()).toBe(2);

    await test.drain();
  });

  it('reads the authority once where the resume the regeneration rode failed before answering', async () => {
    const test = await fixture();
    startResume.mockImplementationOnce(() => {
      return {
        response: Promise.reject(new Error('the resume went nowhere')),
        abort: vi.fn(),
      };
    });

    await test.visit();

    await test.until(NEXT_VISIT_AT);

    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it.each([
    [
      'skipped',
      () => Promise.resolve(new Response(null, { status: 202, headers: said('skipped') })),
    ],
    ['could not be reached', () => Promise.reject(new Error('no such Worker'))],
  ])(
    'reads the authority once where a regeneration asked on its own %s',
    async (_what, answered) => {
      const test = await fixture({ delivery: 'complete' });

      test.dispatchApp.mockImplementationOnce(answered);

      await test.visit();

      await test.until(NEXT_VISIT_AT);

      expect(test.dispatchApp).toHaveBeenCalledTimes(1);
      expect(test.currentRecord).toHaveBeenCalledTimes(1);
      expect(test.held()).toBe(1);

      await test.drain();
    },
  );

  it('follows a regeneration asked on its own once its answer accepts it', async () => {
    const test = await fixture({ delivery: 'complete' });

    await expect(test.visit()).resolves.toContain('date 1');
    expect(test.dispatchApp).toHaveBeenCalledTimes(1);
    expect(test.currentRecord).not.toHaveBeenCalled();

    await test.until(NEXT_VISIT_AT);

    expect(test.held()).toBe(2);
    await expect(test.visit()).resolves.toContain('date 2');
  });

  it('adds no authority read to a fresh record', async () => {
    const test = await fixture({ renderedAt: T0 });

    await test.visit();

    await test.until(T0 + 900);

    await test.visit();

    await test.until(LATER);

    expect(test.currentRecord).not.toHaveBeenCalled();
    expect(regenerationsAsked()).toStrictEqual([undefined, undefined]);
  });

  it('leaves the reads behind later stale visitors to it while it waits', async () => {
    const test = await fixture();

    await test.visit();

    await test.until(T0 + 300);

    await test.visit();

    await test.until(T0 + 799);

    expect(test.currentRecord).not.toHaveBeenCalled();

    await test.until(T0 + 800);

    expect(test.currentRecord).toHaveBeenCalledTimes(1);

    await test.until(LATER);

    await test.drain();
  });

  it('follows one regeneration of an entry at a time', async () => {
    const test = await fixture({ regenerateCooldownMs: 1000 });

    test.published.bytes = undefined;

    await test.visit();

    await test.until(T0 + 1200);

    // Past the cooldown: asked for again, and accepted again, while the first is followed.
    await test.visit();

    await test.until(T0 + 2050);

    expect(regenerationsAsked()).toStrictEqual(['background', 'background']);
    // The first follow-up's reads alone, 0.8, 1.1, 1.4, 1.7 and 2 s on: the second would read
    // 2 s on as well.
    expect(test.currentRecord).toHaveBeenCalledTimes(5);

    await test.until(LATER);

    await test.drain();
  });

  it('gives its place to the follow-up of a later record asked for while it runs', async () => {
    const test = await fixture({ regenerateCooldownMs: 1000 });
    // Another isolate held the entry's lease: the regeneration this one asked for publishes
    // nothing, and that isolate's publishes a record, rendered before the first visit, a second on.
    const later = await record(2, T0 - 200, true);

    test.currentRecord.mockImplementation(
      answering([
        { at: T0 + 1000, revision: 2, bytes: later },
        { at: T0 + 2200, revision: 3, bytes: await record(3, T0 + 2200, true) },
      ]),
    );

    await test.visit();

    await test.until(T0 + 1000);

    // Between two of the follow-up's reads, a read of the entry brings that record.
    test.regional.bytes = later;

    await readGeneration(test.edge, KEY, SETTINGS);

    // Stale already, and past the cooldown: its own regeneration is asked for, and accepted.
    await expect(test.visit()).resolves.toContain('date 2');

    await test.until(T0 + 2600);

    expect(regenerationsAsked()).toStrictEqual(['background', 'background']);
    expect(test.held()).toBe(3);
    // The first follow-up read once, 0.8 s on, and no more; the one that took its place read 0.8,
    // 1.1 and 1.4 s from where its regeneration began.
    expect(test.currentRecord.mock.calls).toStrictEqual([
      [SCOPE, ENTRY_ID, 1],
      [SCOPE, ENTRY_ID, 2],
      [SCOPE, ENTRY_ID, 2],
      [SCOPE, ENTRY_ID, 2],
    ]);
    await expect(test.visit()).resolves.toContain('date 3');

    await test.until(LATER);

    await test.drain();
  });

  it('reads no more once its place is taken, whatever it would find', async () => {
    const test = await fixture({ regenerateCooldownMs: 1000 });
    const later = await record(2, T0 - 200, true, { tags: TAGS });

    test.currentRecord.mockImplementation(
      answering([
        { at: T0 + 1000, revision: 2, bytes: later },
        { at: T0 + 2200, revision: 4, bytes: await record(4, T0 + 2200, true, { tags: TAGS }) },
      ]),
    );

    await test.visit();

    await test.until(T0 + 1000);

    // As above: the later record is brought here, served stale, and its regeneration accepted.
    test.regional.bytes = later;

    await readGeneration(test.edge, KEY, SETTINGS);

    await test.visit();

    // Every tagged record of the scope from before revision 3 is condemned here, as a response that
    // invalidated more tags than its header names says: the record held is let go of, and the
    // authority's would be refused. The follow-up whose place was taken would see nothing held
    // later than the record it was for, and its reads would bring nothing it holds until the
    // regeneration publishes: it would read on beside the one that took its place.
    takeInvalidation(test.edge.runtime.memory, SCOPE, { value: '*', bound: '3' });

    await test.until(T0 + 2600);

    expect(test.held()).toBe(4);
    expect(test.currentRecord.mock.calls).toStrictEqual([
      [SCOPE, ENTRY_ID, 1],
      [SCOPE, ENTRY_ID, 2],
      [SCOPE, ENTRY_ID, 2],
      [SCOPE, ENTRY_ID, 2],
    ]);

    await test.until(LATER);

    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('claims a background slot for each read, and none while it waits', async () => {
    const test = await fixture();

    test.published.bytes = undefined;

    await test.visit();

    await test.until(T0 + 500);

    // Both of the isolate's slots are free while it waits: it holds neither.
    const first = claimBackgroundRecord(test.edge.runtime, 'other-a');
    const second = claimBackgroundRecord(test.edge.runtime, 'other-b');

    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');

    await test.until(T0 + 800);

    // Refused, its turn goes by without a read, and without waiting for a slot.
    expect(test.currentRecord).not.toHaveBeenCalled();

    first?.();
    const answer = Promise.withResolvers<ArrayBuffer | undefined>();

    test.currentRecord.mockReturnValueOnce(answer.promise);

    await test.until(T0 + 1100);

    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    // While it is out, the read holds the slot given back.
    expect(claimBackgroundRecord(test.edge.runtime, 'other-c')).toBeUndefined();

    // Its caller's deadline does not release an RPC that is still out.
    await test.until(T0 + 2200);

    expect(claimBackgroundRecord(test.edge.runtime, 'other-c')).toBeUndefined();

    answer.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    second?.();

    await test.until(LATER);

    await test.drain();
  });

  it('asks nothing when its follow-up timer wakes past the start deadline', async () => {
    const test = await fixture();

    test.published.bytes = undefined;

    await test.visit();

    // Move the clock without running timers, then let the first delayed turn wake.
    vi.setSystemTime(T0 + 4001);
    await vi.advanceTimersByTimeAsync(800);

    expect(test.currentRecord).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('gives back a read queued past the start deadline without dispatching it', async () => {
    const test = await fixture();

    test.published.bytes = undefined;

    await test.visit();

    const queued: (() => void)[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementationOnce((task) => {
      queued.push(task);
    });

    await test.until(T0 + 800);

    expect(queued).toHaveLength(1);
    expect(test.currentRecord).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 4001);
    queued[0]!();
    await vi.advanceTimersByTimeAsync(0);

    expect(test.currentRecord).not.toHaveBeenCalled();

    const released = claimBackgroundRecord(test.edge.runtime, RECORD_KEY);

    expect(released).toBeTypeOf('function');

    released?.();

    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });
});
