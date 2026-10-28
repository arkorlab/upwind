// eslint-disable-next-line no-restricted-imports, import-x/no-nodejs-modules -- a synchronous SHA-256 keeps each record check within its turn; serving stays runtime-neutral.
import { createHash } from 'node:crypto';

import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  encodeGenerationPack,
  type GenerationPackHeader,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContinuationHandle, ContinuationStart } from '../../host/src/delivery/strategy.ts';
import { takeInvalidation } from '../src/cache/condemned.ts';
import { type HostedDocumentInput, routeHostedDocument } from '../src/handlers/hosted-document.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import type { ShellLoadResult } from '../src/strategies/shell-loader.ts';

/**
 * The record that replaces one the edge does not serve — past its expiry or condemned, rendered by
 * the Function in the foreground, or invalidated with a window and handed to it — read for at the
 * authority behind the response, while this data center's KV goes on answering with the record
 * replaced: the document path as it runs, with only the Function's answers, KV's and the
 * authority's records made up, and the clock the test's.
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
const SCOPE = 'dpl_replacement';
const ENTRY_ID = 'ent_replacement';
const RECORD_KEY = kvGenerationKey(SCOPE, ENTRY_ID);
const ROUTE = '/partially-static';
const SETTINGS = DEFAULT_DELIVERY_POLICY.runtimeCache!;
/** Past its five minutes by the first visit: expired. */
const EXPIRED_AT = T0 - 400_000;
/** Past its second by the first visit: stale, and within its five minutes. */
const STALE_AT = T0 - 2000;
/** When the authority holds the record that replaces it, and when the next visitor comes after. */
const COMMITTED_AT = T0 + 1200;
const NEXT_VISIT_AT = T0 + 1600;
/** Long after everything a visit set off is over. */
const LATER = T0 + 10_000;
const RENDERED = '<html><body>rendered</body></html>';
const SUFFIX = '<script>resumed()</script></body></html>';
const OUTCOME_HEADER = 'x-arkor-cache-outcome';
/** A tag of the application's own, which the invalidations below name. */
const TAG = 'posts';
const TAGS: GenerationPackHeader['tags'] = [{ kind: 'next-explicit', value: TAG }];

const ENTRY: RouteEntry = {
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
  cache: { entryId: ENTRY_ID, kind: 'app-page', delivery: 'resume' },
};

/** The page's record at `revision`, rendered at `cacheTimestamp`: a shell, and what resumes it. */
async function record(revision: number, cacheTimestamp: number): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const html = encoder.encode(`<html><body><p id="date">date ${revision}</p>`);
  const state = encoder.encode(`{"postponed":${revision}}`);
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
    tags: TAGS,
    htmlSha256: await sha256Hex(html),
    htmlLength: html.byteLength,
    postponedSha256: await sha256Hex(state),
    postponedLength: state.byteLength,
    artifacts: [],
  };
  return new Uint8Array(encodeGenerationPack(header, html, state)).buffer;
}

/** The edge's clock: the test's, moved by its fake timers. */
function now(): number {
  return Date.now();
}

/** What the Function's answer says of the regeneration asked of it: `undefined` says nothing. */
function said(outcome: string | undefined): Record<string, string> {
  return outcome === undefined ? {} : { [OUTCOME_HEADER]: outcome };
}

interface FixtureOptions {
  /** When the record KV keeps answering with was rendered: expired by the first visit. */
  readonly renderedAt?: number;
  /** What the Function's render in the foreground says of its regeneration. */
  readonly outcome?: string | undefined;
  /** From when the authority holds the record that replaces it, rendered then. */
  readonly publishedAt?: number;
  readonly holdMs?: number;
  /** A host whose records reach the edge only through KV. */
  readonly kvOnly?: boolean;
}

/**
 * One isolate of the edge, whose KV keeps answering with the record rendered at `renderedAt`, and
 * whose authority holds the record at revision 2 that replaces it from `publishedAt` on.
 */
async function fixture(options: FixtureOptions = {}) {
  const outcome = 'outcome' in options ? options.outcome : 'accepted';
  const regional = { bytes: await record(1, options.renderedAt ?? EXPIRED_AT) };
  const publishedAt = options.publishedAt ?? COMMITTED_AT;
  const published = { at: publishedAt, bytes: await record(2, publishedAt) };
  const tasks: Promise<unknown>[] = [];
  const kv = vi.fn<() => Promise<ArrayBuffer | null>>(() => Promise.resolve(regional.bytes));
  // The authority answers with its record where it is later than the revision asked after.
  const currentRecord = vi.fn<
    (scope: string, entry: string, after: number) => Promise<ArrayBuffer | undefined>
  >((_scope, _entry, after) =>
    Promise.resolve(now() >= published.at && after < 2 ? published.bytes : undefined),
  );
  // A regeneration in the foreground is answered with its render, saying what became of it.
  const dispatchApp = vi.fn(() => {
    const headers = { 'content-type': 'text/html', ...said(outcome) };
    return Promise.resolve(new Response(RENDERED, { headers }));
  });
  // A request handed to the Function whole, which runs it as it would any.
  const passthrough = vi.fn<(reason: string) => Promise<Response>>(() =>
    Promise.resolve(new Response('the Function')),
  );
  startResume.mockImplementation(() => {
    return {
      response: Promise.resolve(new Response(SUFFIX, { headers: { 'content-type': 'text/html' } })),
      abort: vi.fn(),
    };
  });
  const manifest = buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    originHost: 'app.test',
    generatedAt: '2026-10-28T00:00:00.000Z',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-28T00:00:00.000Z' },
    app: { deploymentId: SCOPE, scriptName: 'app' },
    cache: { keySchemaVersion: 1, scopeId: SCOPE },
    routes: [ENTRY],
  });
  const runtimeCache = { ...SETTINGS, holdMs: options.holdMs ?? SETTINGS.holdMs };
  const edge = {
    env: { CACHE_STATE: { get: kv } },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    runtime: { now, memory: createEdgeMemory(now), dispatchApp },
    host: {
      ...(options.kvOnly !== true && { currentRecord }),
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
  const open = async (method = 'GET'): Promise<Response> => {
    const request = new Request(`https://app.test${ROUTE}`, {
      method,
      headers: { 'accept-encoding': 'identity' },
    });
    return await routeHostedDocument({
      request,
      url: new URL(request.url),
      edge,
      manifest,
      classification: { kind: 'document', entry: ENTRY },
      classifiedHeaders: request.headers,
      passthrough,
      resolved: { policy: DEFAULT_DELIVERY_POLICY, shell: { id: 'memory', getShell: vi.fn() } },
    } as unknown as HostedDocumentInput);
  };
  return {
    edge,
    published,
    currentRecord,
    dispatchApp,
    passthrough,
    open,
    /** A visitor's request, read to its end, and what it set off behind it run without moving time. */
    visit: async (method = 'GET'): Promise<string> => {
      const body = await (await open(method)).text();
      await vi.advanceTimersByTimeAsync(0);
      return body;
    },
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A response passed through this isolate said its request invalidated the page's tag at once, at
 * revision 2: the record KV answers with, at revision 1, is condemned here, and the one the
 * authority holds at 2 is not.
 */
function invalidatedAtOnce(test: Fixture): void {
  takeInvalidation(test.edge.runtime.memory, SCOPE, { value: TAG, bound: '2' });
}

/**
 * The authority said the scope's signals invalidated the page's tag with a window at revision 2:
 * the record KV answers with is the Function's to serve stale and regenerate.
 */
function invalidatedWithAWindow(test: Fixture): void {
  test.edge.runtime.memory.invalidations.takeEach(SCOPE, {
    atOnce: [],
    windowed: [{ tag: TAG, revision: 2 }],
  });
}

/** Nothing told: a record past its expiry says so itself. */
function nothingTold(): void {
  // The record's own policy and timestamp put it past its expiry.
}

describe('the record that replaces one the edge does not serve, read for at the authority', () => {
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

  it.each([
    { record: 'past its expiry', renderedAt: EXPIRED_AT, prepare: nothingTold },
    { record: 'condemned at once', renderedAt: STALE_AT, prepare: invalidatedAtOnce },
  ])(
    'follows what the foreground regeneration of a record $record publishes, and serves it shell-first',
    async ({ renderedAt, prepare }) => {
      const test = await fixture({ renderedAt });

      prepare(test);

      await expect(test.visit()).resolves.toBe(RENDERED);
      // Its publish is behind the render answered with: a read now would find nothing of it.
      expect(test.currentRecord).not.toHaveBeenCalled();

      await test.until(NEXT_VISIT_AT);

      expect(test.held()).toBe(2);
      await expect(test.visit()).resolves.toBe(`<html><body><p id="date">date 2</p>${SUFFIX}`);
      // 0.8 s and 1.1 s on, nothing yet; 1.4 s on, the record it published.
      expect(test.currentRecord.mock.calls).toStrictEqual([
        [SCOPE, ENTRY_ID, 1],
        [SCOPE, ENTRY_ID, 1],
        [SCOPE, ENTRY_ID, 1],
      ]);
      expect(test.dispatchApp).toHaveBeenCalledTimes(1);

      await test.drain();
    },
  );

  it.each([
    {
      record: 'past its expiry',
      why: 'another render of it is under way',
      renderedAt: EXPIRED_AT,
      prepare: nothingTold,
      outcome: 'busy',
    },
    {
      record: 'past its expiry',
      why: 'the answer says nothing of it',
      renderedAt: EXPIRED_AT,
      prepare: nothingTold,
      outcome: undefined,
    },
    {
      record: 'condemned at once',
      why: 'the authority holds a later record',
      renderedAt: STALE_AT,
      prepare: invalidatedAtOnce,
      outcome: 'superseded',
    },
    {
      record: 'condemned at once',
      why: 'the answer says nothing of it',
      renderedAt: STALE_AT,
      prepare: invalidatedAtOnce,
      outcome: undefined,
    },
  ])(
    'reads the authority once as the answer comes, for a record $record whose regeneration was not accepted: $why',
    async ({ renderedAt, prepare, outcome }) => {
      const test = await fixture({ renderedAt, outcome, publishedAt: T0 });

      prepare(test);

      await expect(test.visit()).resolves.toBe(RENDERED);

      expect(test.currentRecord.mock.calls).toStrictEqual([[SCOPE, ENTRY_ID, 1]]);
      expect(test.held()).toBe(2);
      // Nothing follows it: no read is left to come.
      expect(vi.getTimerCount()).toBe(0);
      await expect(test.visit()).resolves.toContain('date 2');
      expect(test.dispatchApp).toHaveBeenCalledTimes(1);

      await test.drain();
    },
  );

  it('reads the authority once where the Function could not be reached for the regeneration', async () => {
    const test = await fixture({ renderedAt: STALE_AT, publishedAt: T0 });

    test.dispatchApp.mockRejectedValueOnce(new Error('no such Worker'));

    invalidatedAtOnce(test);

    const response = await test.open();
    await response.body?.cancel();
    await vi.advanceTimersByTimeAsync(0);

    expect(response.status).toBe(502);
    expect(test.currentRecord.mock.calls).toStrictEqual([[SCOPE, ENTRY_ID, 1]]);
    expect(test.held()).toBe(2);

    await test.drain();
  });

  it('reads the authority behind a record invalidated with a window once a second, and serves what replaces it shell-first', async () => {
    const test = await fixture({ renderedAt: T0 });

    invalidatedWithAWindow(test);

    await expect(test.visit()).resolves.toBe('the Function');

    await test.until(T0 + 500);

    // Within the second, another visitor's is handed on with no read of its own.
    await expect(test.visit()).resolves.toBe('the Function');
    expect(test.currentRecord).toHaveBeenCalledTimes(1);

    await test.until(T0 + 1300);

    // A second on, and once the authority holds the record that replaces it: read, and held.
    await expect(test.visit()).resolves.toBe('the Function');
    expect(test.held()).toBe(2);

    await test.until(NEXT_VISIT_AT);

    await expect(test.visit()).resolves.toBe(`<html><body><p id="date">date 2</p>${SUFFIX}`);
    expect(test.passthrough.mock.calls.map(([reason]) => reason)).toStrictEqual([
      'invalidated',
      'invalidated',
      'invalidated',
    ]);
    expect(test.currentRecord.mock.calls).toStrictEqual([
      [SCOPE, ENTRY_ID, 1],
      [SCOPE, ENTRY_ID, 1],
    ]);

    await test.drain();
  });

  it.each([
    {
      record: 'regenerated in the foreground',
      renderedAt: EXPIRED_AT,
      prepare: nothingTold,
      body: RENDERED,
      heldBefore: 1,
    },
    {
      record: 'invalidated with a window',
      renderedAt: T0,
      prepare: invalidatedWithAWindow,
      body: 'the Function',
      heldBefore: undefined,
    },
  ])(
    'answers for a record $record before the authority does',
    async ({ renderedAt, prepare, body, heldBefore }) => {
      const test = await fixture({ renderedAt, outcome: 'busy', publishedAt: T0 });
      const authority = Promise.withResolvers<ArrayBuffer | undefined>();

      prepare(test);

      test.currentRecord.mockReturnValueOnce(authority.promise);

      const response = await test.open();
      await vi.advanceTimersByTimeAsync(0);

      expect(test.currentRecord).toHaveBeenCalledTimes(1);
      await expect(response.text()).resolves.toBe(body);
      expect(test.held()).toBe(heldBefore);

      authority.resolve(test.published.bytes);
      await vi.advanceTimersByTimeAsync(0);

      expect(test.held()).toBe(2);

      await test.drain();
    },
  );

  it.each([
    { gate: 'under a hold of zero', record: 'expired', options: { holdMs: 0 }, method: 'GET' },
    { gate: 'without an authority', record: 'expired', options: { kvOnly: true }, method: 'GET' },
    { gate: 'behind a HEAD', record: 'expired', options: {}, method: 'HEAD' },
    { gate: 'under a hold of zero', record: 'invalidated', options: { holdMs: 0 }, method: 'GET' },
    {
      gate: 'without an authority',
      record: 'invalidated',
      options: { kvOnly: true },
      method: 'GET',
    },
    { gate: 'behind a HEAD', record: 'invalidated', options: {}, method: 'HEAD' },
  ])(
    'reads nothing of the authority $gate, for a record $record',
    async ({ record: kind, options, method }) => {
      const expired = kind === 'expired';
      const test = await fixture({
        ...options,
        renderedAt: expired ? EXPIRED_AT : T0,
        outcome: 'busy',
        publishedAt: T0,
      });

      (expired ? nothingTold : invalidatedWithAWindow)(test);

      await test.visit(method);

      await test.visit(method);

      await test.until(LATER);

      expect(test.currentRecord).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await test.drain();
    },
  );
});
