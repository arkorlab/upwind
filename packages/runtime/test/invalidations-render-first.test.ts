import { setImmediate } from 'node:timers/promises';

import {
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  invalidatedTagsValue,
} from '@stayingupwind/core/paas';
import { toBase64, TtlCache } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { asRegeneration, InvalidatedTags, requestContextFor } from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import type {
  CacheHost,
  DataRead,
  InvalidateOutcome,
  InvalidateRequest,
} from '../src/cache/host.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { INVALIDATIONS_RECORDED_WITHIN_MS } from '../src/serve.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * An invalidation a request asks for — as a Server Action's does, which Next.js applies before it
 * renders the action's page (`executeActionAndPrepareForRender`) — is answered once it is in force
 * in this isolate, and the render goes on while the host records it. The request's response waits
 * for the record all the same, for no longer than `INVALIDATIONS_RECORDED_WITHIN_MS`: the render and
 * the record side by side, where the record used to come first and the render after it. The router
 * and the runtime run for real; Next.js is the bridge, replaced by what each test says it does.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const NOW = 1_800_000_000_000;
const HOLD_MS = 5000;
const ENTRIES = 64;
const ORIGIN = 'https://app.test';
const ACTION = '/api/act';
const TAG = 'feed';
const KEY = 'cached-function';
/** The revision of the scope the host records each invalidation at. */
const REVISION = 7;

function frozen(): number {
  return NOW;
}

function unasked(): Promise<never> {
  return Promise.reject(new Error('not asked by an invalidation'));
}

/** A value a `use cache` function made a second before the invalidation, under `TAG`. */
function madeBefore(): DataRead {
  return {
    entryId: 'entry',
    generationId: 'generation',
    dependencyRevision: 0,
    entry: {
      kind: 'data:use-cache',
      handler: 'default',
      tags: [TAG],
      stale: 60,
      timestamp: NOW - 1000,
      expire: 600,
      revalidate: 60,
    },
    value: { kind: 'inline', base64: toBase64(new TextEncoder().encode('kept')) },
  };
}

/** An invalidation the host has been asked for, and how the test answers it. */
interface Asked {
  readonly request: InvalidateRequest;
  readonly answer: PromiseWithResolvers<InvalidateOutcome>;
}

/** What the host answers an invalidation of `tags` with: recorded at `REVISION`. */
function recorded(tags: readonly string[]): InvalidateOutcome {
  const mark = { staleAt: NOW, hardExpireAt: NOW, revision: REVISION };
  return { revision: REVISION, invalidations: tags.map((value) => ({ value, ...mark })) };
}

/**
 * A host that holds `madeBefore`, knows of no invalidation, and records one only once the test
 * answers it (`asked`).
 */
function cache(): { readonly runtime: CacheRuntime; readonly asked: Asked[] } {
  const asked: Asked[] = [];
  const host: CacheHost = {
    startAttempt: unasked,
    uploadArtifact: unasked,
    heartbeat: unasked,
    commit: unasked,
    fail: unasked,
    readRecord: () => Promise.resolve(undefined),
    readArtifact: () => Promise.resolve(undefined),
    getData: () => Promise.resolve(madeBefore()),
    setData: unasked,
    getTags: () => Promise.resolve({ tags: [] }),
    tagsDelta: () => Promise.resolve({ revision: 0, truncated: false, tags: [] }),
    invalidate: (request) => {
      const answer = Promise.withResolvers<InvalidateOutcome>();
      asked.push({ request, answer });
      return answer.promise;
    },
  };
  const runtime: CacheRuntime = {
    scopeId: 'render-first',
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
    log: vi.fn(),
  };
  configureCacheHandlers(runtime);
  return { runtime, asked };
}

/** A Server Action's request, with what it hands `waitUntil` collected in `kept`. */
function requestOf(runtime: CacheRuntime, kept: Promise<unknown>[]) {
  return requestContextFor({
    tables: { app: { entries: {} }, edge: { entries: {} } },
    runtime,
    request: new Request(`${ORIGIN}/`, { method: 'POST' }),
    startedAt: NOW,
    waitUntil: (promise) => {
      kept.push(promise);
    },
    clock: NOW,
  });
}

/**
 * Every handler Next.js has, handed an invalidation with no profile — `updateTag`, `revalidatePath`,
 * `revalidateTag` without one — in one turn, as `revalidateTags` hands it.
 */
function everyHandler(tags: string[]): Promise<unknown> {
  return Promise.all([
    useCacheHandler('default').updateTags(tags),
    useCacheHandler('remote').updateTags(tags),
    new PlatformFetchCache().revalidateTag(tags),
  ]);
}

/** Whether `work` settles, whichever way, before the next task: before any host could answer. */
function settledBeforeNextTask(work: Promise<unknown>): Promise<boolean> {
  const settled = async (): Promise<boolean> => {
    try {
      await work;
    } catch {
      // Settled all the same.
    }
    return true;
  };
  return Promise.race([settled(), setImmediate(false)]);
}

describe('an invalidation a request asks for', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  it('is answered once it is in force here, with the host yet to record it', async () => {
    const { runtime, asked } = cache();
    const kept: Promise<unknown>[] = [];
    const context = requestOf(runtime, kept);
    const read = (): Promise<unknown> => context.run(() => useCacheHandler('default').get(KEY, []));

    await expect(read()).resolves.toBeDefined();

    const invalidating = context.run(() => everyHandler([TAG]));

    await expect(settledBeforeNextTask(invalidating)).resolves.toBe(true);
    // Asked once for every handler, and held for the response and in `waitUntil`.
    expect(asked.map((call) => call.request)).toStrictEqual([
      { tags: [TAG], api: 'updateTag', inForceAt: NOW },
    ]);
    expect(context.invalidated.pending).toBe(true);
    expect(kept).toHaveLength(1);
    // What the tag carried, made before it, is not served here while the host has yet to answer.
    await expect(read()).resolves.toBeUndefined();
  });

  it('is told on the response at the revision the host recorded it at, once the host has', async () => {
    const { runtime, asked } = cache();
    const context = requestOf(runtime, []);
    await context.run(() => everyHandler([TAG]));

    expect(context.invalidated.tags.size).toBe(0);

    asked[0]?.answer.resolve(recorded([TAG]));
    await context.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);

    expect(context.invalidated.pending).toBe(false);
    expect([...context.invalidated.tags]).toStrictEqual([TAG]);
    expect(context.invalidated.revision).toBe(REVISION);
  });

  it('logs one the host could not record, fails nothing, and holds it in force here', async () => {
    const { runtime, asked } = cache();
    const context = requestOf(runtime, []);
    await context.run(() => everyHandler([TAG]));

    asked[0]?.answer.reject(new Error('the host is down'));
    await context.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);

    expect(runtime.log).toHaveBeenCalledExactlyOnceWith('tag invalidation failed', {
      tags: TAG,
      detail: 'the host is down',
    });
    expect(context.invalidated.pending).toBe(false);
    expect(context.invalidated.tags.size).toBe(0);
    await expect(
      context.run(() => useCacheHandler('default').get(KEY, [])),
    ).resolves.toBeUndefined();
  });

  /**
   * The request goes on while the call is out: an invalidation of the same tags asked for later is
   * one made at a later moment, which the call before — recorded already, maybe — does not stand for.
   */
  it('asks the host again for the same tags in a later turn, with the call before still out', async () => {
    const { runtime, asked } = cache();
    const context = requestOf(runtime, []);

    await context.run(async () => {
      await everyHandler([TAG]);
      await setImmediate();
      await everyHandler([TAG]);
    });

    expect(asked).toHaveLength(2);
    expect(context.invalidated.pending).toBe(true);
  });

  it('is waited for in a regeneration, whose response is held for nothing', async () => {
    const { runtime, asked } = cache();
    const kept: Promise<unknown>[] = [];
    const context = requestOf(runtime, kept);

    const invalidating = context.run(() => asRegeneration(() => everyHandler([TAG])));

    await expect(settledBeforeNextTask(invalidating)).resolves.toBe(false);
    expect(asked).toHaveLength(1);
    expect(context.invalidated.pending).toBe(false);
    expect(kept).toHaveLength(1);

    asked[0]?.answer.resolve(recorded([TAG]));

    await expect(invalidating).resolves.toBeDefined();
  });

  it('is waited for outside any request, which has no response to hold', async () => {
    const { asked } = cache();

    const invalidating = useCacheHandler('default').updateTags([TAG]);

    await expect(settledBeforeNextTask(invalidating)).resolves.toBe(false);

    asked[0]?.answer.resolve(recorded([TAG]));

    await expect(invalidating).resolves.toBeUndefined();
  });
});

/** The deployment of one route, which each test has Next.js answer through the bridge. */
function deployment(): Store {
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [{ id: ACTION, kind: 'app-route', pathname: ACTION }],
    },
    pathnames: [ACTION],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    renderedPages: new Set(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

const route: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [ACTION]: () => ({ handler: route }) } };

/** What the requests of a test handed to `waitUntil`. */
const pending: Promise<unknown>[] = [];

function keep(work: Promise<unknown>): void {
  pending.push(work);
}

/** The Function asked to run the action, with the cache `runtime` it was given. */
function act(runtime: CacheRuntime, invalidated?: InvalidatedTags): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`${ORIGIN}${ACTION}`, { method: 'POST' }),
    cache: runtime,
    waitUntil: keep,
    clock: NOW,
    invalidated,
  });
}

/** Next.js running a Server Action: what it invalidated applied, then its page rendered. */
function acting(rendered: { done: boolean }): () => Promise<Response> {
  return async () => {
    await everyHandler([TAG]);
    rendered.done = true;
    return new Response('rendered');
  };
}

/** A render's own time, `ms`, by the timers the test moves on. */
function slept(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Real turns, until a bound's timer runs: the request has asked the host for what it invalidated. */
async function untilTheBoundRuns(): Promise<void> {
  for (let turn = 0; turn < 100 && vi.getTimerCount() === 0; turn += 1) {
    await setImmediate();
  }
}

describe('a Server Action that invalidates, answered by the Function', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    vi.mocked(invokeNodeHandler).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    configureCacheHandlers(undefined);
    pending.length = 0;
  });

  it('renders while the host records the invalidation, and answers once it has, saying so', async () => {
    const { runtime, asked } = cache();
    const rendered = { done: false };
    vi.mocked(invokeNodeHandler).mockImplementation(acting(rendered));

    const answering = act(runtime);
    await vi.waitFor(() => {
      expect(rendered.done).toBe(true);
    });

    await expect(settledBeforeNextTask(answering)).resolves.toBe(false);

    asked[0]?.answer.resolve(recorded([TAG]));
    const response = await answering;

    expect(asked).toHaveLength(1);
    expect(response.headers.get(INVALIDATED_TAGS_HEADER)).toBe(invalidatedTagsValue([TAG]));
    expect(response.headers.get(INVALIDATED_REVISION_HEADER)).toBe(String(REVISION));
    await expect(response.text()).resolves.toBe('rendered');
  });

  it('answers once the bound has gone by, saying nothing of what the host has yet to record', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { runtime, asked } = cache();
    const rendered = { done: false };
    vi.mocked(invokeNodeHandler).mockImplementation(acting(rendered));

    const answering = act(runtime);
    await untilTheBoundRuns();
    await vi.advanceTimersByTimeAsync(INVALIDATIONS_RECORDED_WITHIN_MS - 1);

    expect(rendered.done).toBe(true);
    await expect(settledBeforeNextTask(answering)).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await answering;

    expect(response.headers.has(INVALIDATED_TAGS_HEADER)).toBe(false);
    await expect(response.text()).resolves.toBe('rendered');

    // The call goes on behind the response, in `waitUntil`, and stands once the host answers.
    asked[0]?.answer.resolve(recorded([TAG]));
    await Promise.all(pending);

    expect(runtime.tags.knownRevisionOf(TAG)).toBe(REVISION);
  });

  /**
   * The bound is the call's own, from the moment the request asked for it: the render goes on while
   * the host records, and the response waits for what is left of the bound once the render has
   * answered — not for the bound again, after the render.
   */
  it('answers once the bound from the call has gone by, however long the render took', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { runtime } = cache();
    vi.mocked(invokeNodeHandler).mockImplementation(async () => {
      await everyHandler([TAG]);
      await slept(1500);
      return new Response('rendered');
    });
    const invalidated = new InvalidatedTags();

    const answering = act(runtime, invalidated);
    await untilTheBoundRuns();
    await vi.advanceTimersByTimeAsync(INVALIDATIONS_RECORDED_WITHIN_MS - 1);

    await expect(settledBeforeNextTask(answering)).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(settledBeforeNextTask(answering)).resolves.toBe(true);
    // Only the wait for it ends with its bound: the call is out still.
    expect(invalidated.pending).toBe(true);
  });

  it('waits for a call the request asked for later in the render for its own bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { runtime } = cache();
    vi.mocked(invokeNodeHandler).mockImplementation(async () => {
      await everyHandler([TAG]);
      await slept(1400);
      await everyHandler(['posts']);
      await slept(100);
      return new Response('rendered');
    });

    const answering = act(runtime);
    await untilTheBoundRuns();
    await vi.advanceTimersByTimeAsync(1400 + INVALIDATIONS_RECORDED_WITHIN_MS - 1);

    await expect(settledBeforeNextTask(answering)).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(settledBeforeNextTask(answering)).resolves.toBe(true);
  });

  it('answers a failure once the host has recorded what the action invalidated, and with it', async () => {
    const { runtime, asked } = cache();
    vi.mocked(invokeNodeHandler).mockImplementation(async () => {
      await everyHandler([TAG]);
      throw new Error('the render failed');
    });
    const invalidated = new InvalidatedTags();

    const answering = act(runtime, invalidated);
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
    });

    await expect(settledBeforeNextTask(answering)).resolves.toBe(false);

    asked[0]?.answer.resolve(recorded([TAG]));

    await expect(answering).rejects.toThrow('the render failed');
    expect([...invalidated.tags]).toStrictEqual([TAG]);
    expect(invalidated.revision).toBe(REVISION);
  });

  it('answers once the host has failed to record it, saying nothing of it', async () => {
    const { runtime, asked } = cache();
    const rendered = { done: false };
    vi.mocked(invokeNodeHandler).mockImplementation(acting(rendered));

    const answering = act(runtime);
    await vi.waitFor(() => {
      expect(rendered.done).toBe(true);
    });
    asked[0]?.answer.reject(new Error('the host is down'));
    const response = await answering;

    expect(response.status).toBe(200);
    expect(response.headers.has(INVALIDATED_TAGS_HEADER)).toBe(false);
    expect(runtime.log).toHaveBeenCalledWith(
      'tag invalidation failed',
      expect.objectContaining({ tags: TAG }),
    );
  });
});
