import { sha256Hex } from '@stayingupwind/core/artifact';
import { encodeGenerationPack, kvGenerationKey, policyFromBuild } from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readGeneration } from '../src/cache/generation-loader.ts';
import type { DocumentInput } from '../src/handlers/document.ts';
import { type HostedDocumentInput, routeHostedDocument } from '../src/handlers/hosted-document.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import type { ShellLoadResult } from '../src/strategies/shell-loader.ts';

vi.mock(import('../src/handlers/document.ts'), () => {
  return {
    handleDocument: vi.fn((input: DocumentInput) => {
      input.onBuildServed?.();
      input.generation?.onServed?.();
      return Promise.resolve(
        new Response(input.generation?.pack.html ?? new TextEncoder().encode('build date')),
      );
    }),
  };
});
vi.mock(import('../src/handlers/middleware.ts'), async (original) => {
  const middleware = await original();
  return { ...middleware, middlewareMatches: vi.fn(() => false) };
});
vi.mock(import('../src/cache/regenerate.ts'), async (original) => {
  const regeneration = await original();
  return {
    ...regeneration,
    triggerDetached: vi.fn(() => ({ record: vi.fn() })),
    foregroundDocument: vi.fn(() => Promise.resolve(new Response('foreground regeneration'))),
  };
});
vi.mock(import('../src/strategies/shell-loader.ts'), async (original) => {
  return {
    ...(await original()),
    loadShell: vi.fn<() => Promise<ShellLoadResult>>(() => Promise.resolve({ kind: 'missing' })),
  };
});

const NOW = 1_800_000_000_000;
const SCOPE = 'dpl_build_current';
const ENTRY_ID = 'ent_build_current';
const KEY = { scopeId: SCOPE, entryId: ENTRY_ID };
const RECORD_KEY = kvGenerationKey(SCOPE, ENTRY_ID);
const ROUTE = '/partially-static';
const ENTRY: RouteEntry = {
  pathname: ROUTE,
  status: 200,
  shell: { sha256: 'a'.repeat(64), byteLength: 10, contentType: 'text/html', encoding: 'identity' },
  headers: {},
  prerenderId: ROUTE,
  cache: { entryId: ENTRY_ID, kind: 'app-page', delivery: 'resume' },
  bypassFor: [{ type: 'header', key: 'next-action' }],
};
const SETTINGS = DEFAULT_DELIVERY_POLICY.runtimeCache!;

async function record(
  revision = 1,
  entryId = ENTRY_ID,
  generationId = `gen_${revision}`,
  initialRevalidate = 1,
): Promise<ArrayBuffer> {
  const html = new TextEncoder().encode(`current date ${revision}`);
  return new Uint8Array(
    encodeGenerationPack(
      {
        schemaVersion: 1,
        scopeId: SCOPE,
        entryId,
        generationId,
        seq: revision,
        revision,
        source: 'runtime',
        kind: 'app-page',
        route: ROUTE,
        pathname: ROUTE,
        cacheTimestamp: NOW,
        producedAt: NOW,
        policy: policyFromBuild({ initialRevalidate, initialExpiration: 300 }),
        status: 200,
        headers: { 'content-type': 'text/html' },
        tags: [{ kind: 'next-explicit', value: 'posts' }],
        htmlSha256: await sha256Hex(html),
        htmlLength: html.byteLength,
        postponedSha256: null,
        postponedLength: 0,
        artifacts: [],
      },
      html,
      undefined,
    ),
  ).buffer;
}

function fixture(holdMs = SETTINGS.holdMs) {
  const tasks: Promise<unknown>[] = [];
  const clock = { now: NOW };
  const kv = vi.fn<() => Promise<ArrayBuffer | null>>(() => Promise.resolve(null));
  const currentRecord = vi.fn<
    (scope: string, entry: string, after: number) => Promise<ArrayBuffer | undefined>
  >(() => Promise.resolve(undefined));
  const manifest = buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    originHost: 'app.test',
    generatedAt: '2026-10-18T00:00:00.000Z',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-18T00:00:00.000Z' },
    app: { deploymentId: SCOPE, scriptName: 'app' },
    cache: { keySchemaVersion: 1, scopeId: SCOPE },
    routes: [ENTRY],
  });
  const edge = {
    env: { CACHE_STATE: { get: kv } },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    runtime: { now: () => clock.now, memory: createEdgeMemory(() => clock.now) },
    host: { currentRecord, credentials: { cookies: [], headers: [] } },
    policy: { ...DEFAULT_DELIVERY_POLICY, runtimeCache: { ...SETTINGS, holdMs } },
    app: manifest.app,
    manifestId: 'manifest',
    projectId: 'project',
    validated: false,
    cacheApi: false,
  } as unknown as EdgeContext;
  const passthrough = vi.fn(() => Promise.resolve(new Response('function')));
  const input = (init: RequestInit = {}): HostedDocumentInput => {
    const request = new Request(`https://app.test${ROUTE}`, init);
    return {
      request,
      url: new URL(request.url),
      edge,
      manifest,
      classification: { kind: 'document', entry: ENTRY },
      classifiedHeaders: request.headers,
      passthrough,
      resolved: { shell: { id: 'memory', getShell: vi.fn() } },
    } as unknown as HostedDocumentInput;
  };
  return {
    edge,
    input,
    tasks,
    clock,
    kv,
    currentRecord,
    drain: async () => {
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
    },
  };
}

function held(test: ReturnType<typeof fixture>) {
  return test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack;
}

describe('a build shell behind a negative regional KV lookup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('finishes the build response before authority answers and adopts the current date for later hits', async () => {
    const test = fixture();
    const pending = Promise.withResolvers<ArrayBuffer | undefined>();

    test.currentRecord.mockReturnValue(pending.promise);

    const response = await routeHostedDocument(test.input());

    await expect(response.text()).resolves.toBe('build date');
    expect(test.currentRecord).toHaveBeenCalledWith(SCOPE, ENTRY_ID, 0);
    expect(held(test)).toBeUndefined();

    pending.resolve(await record());

    await test.drain();

    expect(held(test)?.header.revision).toBe(1);

    const next = await routeHostedDocument(test.input());

    await expect(next.text()).resolves.toBe('current date 1');
    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(test.kv).toHaveBeenCalledTimes(1);
  });

  it('keeps the authority date across more than a minute of negative KV and renewed confirmations', async () => {
    const test = fixture();

    test.currentRecord.mockResolvedValue(await record());

    await routeHostedDocument(test.input());

    await test.drain();

    const observed: string[] = [];
    for (let refresh = 0; refresh < 13; refresh += 1) {
      test.clock.now += SETTINGS.holdMs + 1;

      const response = await routeHostedDocument(test.input());
      observed.push(await response.text());

      await test.drain();
    }

    expect(observed).toStrictEqual(Array.from({ length: 13 }, () => 'current date 1'));
    expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt).toBe(
      test.clock.now,
    );
    expect(test.currentRecord.mock.calls.every((args) => args[2] === 0)).toBe(true);
  });

  it.each([1, 2])(
    'retains and confirms revision %i after a configured sixty-second hold',
    async (revision) => {
      const test = fixture(60_000);

      test.currentRecord.mockResolvedValue(await record(1, ENTRY_ID, 'gen_1', 120));

      await routeHostedDocument(test.input());

      await test.drain();

      test.clock.now += 60_001;

      test.currentRecord.mockResolvedValue(
        await record(revision, ENTRY_ID, `gen_${revision}`, 120),
      );

      await routeHostedDocument(test.input());

      await test.drain();

      const next = await routeHostedDocument(test.input());

      await expect(next.text()).resolves.toBe(`current date ${revision}`);
      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt).toBe(
        test.clock.now,
      );
      expect(test.currentRecord).toHaveBeenLastCalledWith(SCOPE, ENTRY_ID, 0);
    },
  );

  it.each(['absent', 'error', 'timeout'] as const)(
    'lets authority grace expire when confirmation is %s',
    async (failure) => {
      const test = fixture();

      test.currentRecord.mockResolvedValue(await record());

      await routeHostedDocument(test.input());

      await test.drain();

      const confirmedAt =
        test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt;
      const pending = Promise.withResolvers<ArrayBuffer | undefined>();
      const confirmations = {
        absent: () => Promise.resolve(undefined),
        error: () => Promise.reject(new Error('authority unavailable')),
        timeout: () => pending.promise,
      };

      test.currentRecord.mockImplementation(confirmations[failure]);

      vi.useFakeTimers();
      const observed: string[] = [];
      for (let refresh = 0; refresh < 8; refresh += 1) {
        test.clock.now += SETTINGS.holdMs + 1;

        const response = await routeHostedDocument(test.input());
        observed.push(await response.text());
        await vi.advanceTimersByTimeAsync(1001);

        await test.drain();
      }

      expect(confirmedAt).toBe(NOW);
      expect(held(test)).toBeUndefined();
      expect(observed.slice(0, 7)).toStrictEqual(Array.from({ length: 7 }, () => 'current date 1'));
      expect(observed.at(-1)).toBe('build date');

      pending.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it.each(['absent', 'error', 'timeout'] as const)(
    'drops an unconfirmed long-held generation at the exact hold-plus-KV boundary after %s',
    async (failure) => {
      const test = fixture(60_000);

      test.currentRecord.mockResolvedValue(await record(1, ENTRY_ID, 'gen_1', 120));

      await routeHostedDocument(test.input());

      await test.drain();

      const pending = Promise.withResolvers<ArrayBuffer | undefined>();
      const confirmations = {
        absent: () => Promise.resolve(undefined),
        error: () => Promise.reject(new Error('authority unavailable')),
        timeout: () => pending.promise,
      };

      test.currentRecord.mockImplementation(confirmations[failure]);

      vi.useFakeTimers();

      test.clock.now += 60_001;

      const served = await routeHostedDocument(test.input());
      await vi.advanceTimersByTimeAsync(1001);

      await test.drain();

      await expect(served.text()).resolves.toBe('current date 1');
      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt).toBe(NOW);

      test.clock.now = NOW + 90_000;

      const expired = await readGeneration(test.edge, KEY, { ...SETTINGS, holdMs: 60_000 });

      expect(expired.kind).toBe('none');
      expect(held(test)).toBeUndefined();

      pending.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it('drops default-policy grace at the exact thirty-five-second boundary', async () => {
    const test = fixture();

    test.currentRecord.mockResolvedValue(await record());

    await routeHostedDocument(test.input());

    await test.drain();

    test.currentRecord.mockResolvedValue(undefined);

    test.clock.now = NOW + 34_999;

    await readGeneration(test.edge, KEY, SETTINGS);

    await test.drain();

    expect(held(test)?.header.revision).toBe(1);

    test.clock.now = NOW + 35_000;

    const expired = await readGeneration(test.edge, KEY, SETTINGS);

    expect(expired.kind).toBe('none');
    expect(held(test)).toBeUndefined();
  });

  it('does not keep the authority grace through a backwards request clock', async () => {
    const test = fixture();

    test.currentRecord.mockResolvedValue(await record());

    await routeHostedDocument(test.input());

    await test.drain();

    test.clock.now = NOW - 1;

    await readGeneration(test.edge, KEY, SETTINGS);

    expect(held(test)).toBeUndefined();
  });

  it('adopts a newer confirmed generation while preserving the response already being served', async () => {
    const test = fixture();

    test.currentRecord.mockResolvedValue(await record());

    await routeHostedDocument(test.input());

    await test.drain();

    test.clock.now += SETTINGS.holdMs + 1;

    test.currentRecord.mockResolvedValue(await record(2));

    const response = await routeHostedDocument(test.input());

    await test.drain();

    await expect(response.text()).resolves.toBe('current date 1');
    expect(held(test)?.header.revision).toBe(2);
    expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt).toBe(
      test.clock.now,
    );
  });

  it('does not extend grace through corrupt regional bytes or known invalidation', async () => {
    const corrupt = fixture();
    corrupt.currentRecord.mockResolvedValue(await record());
    await routeHostedDocument(corrupt.input());
    await corrupt.drain();
    corrupt.kv.mockResolvedValue(new ArrayBuffer(0));
    await readGeneration(corrupt.edge, KEY, SETTINGS);
    await corrupt.drain();
    const invalidated = fixture();
    invalidated.currentRecord.mockResolvedValue(await record());
    await routeHostedDocument(invalidated.input());
    await invalidated.drain();
    invalidated.edge.runtime.memory.invalidations.take(SCOPE, ['posts'], 2);
    await readGeneration(invalidated.edge, KEY, SETTINGS);
    await invalidated.drain();

    expect(held(corrupt)).toBeUndefined();
    expect(corrupt.currentRecord).toHaveBeenCalledTimes(1);
    expect(held(invalidated)).toBeUndefined();
    expect(invalidated.currentRecord).toHaveBeenCalledTimes(1);
  });

  it('does not renew confirmation for a different generation at the same revision', async () => {
    const test = fixture();

    test.currentRecord.mockResolvedValue(await record());

    await routeHostedDocument(test.input());

    await test.drain();

    test.clock.now += SETTINGS.holdMs + 1;

    test.currentRecord.mockResolvedValue(await record(1, ENTRY_ID, 'gen_impossible'));

    await routeHostedDocument(test.input());

    await test.drain();

    expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt).toBe(NOW);
    expect(held(test)?.header.generationId).toBe('gen_1');
  });

  it('checks equal-revision identity again after authority digest verification', async () => {
    const test = fixture();
    const original = await record();
    const conflicting = await record(1, ENTRY_ID, 'gen_conflict');
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('current date 1'),
    );

    test.currentRecord.mockResolvedValue(original);

    await routeHostedDocument(test.input());

    await test.drain();

    test.clock.now += SETTINGS.holdMs + 1;

    const gate = Promise.withResolvers<ArrayBuffer>();
    const verifying = Promise.withResolvers<undefined>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => {
      verifying.resolve(undefined);
      return gate.promise;
    });
    await routeHostedDocument(test.input());
    await verifying.promise;

    test.kv.mockResolvedValue(conflicting);

    await readGeneration(test.edge, KEY, SETTINGS);
    gate.resolve(digest);

    await test.drain();

    expect(held(test)?.header.generationId).toBe('gen_conflict');
    expect(
      test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt,
    ).toBeUndefined();
  });

  it('does not borrow authority grace for a record read only from KV', async () => {
    const test = fixture();

    test.kv.mockResolvedValue(await record());

    await readGeneration(test.edge, KEY, SETTINGS);

    test.kv.mockResolvedValue(null);

    await readGeneration(test.edge, KEY, SETTINGS);

    await test.drain();

    expect(held(test)).toBeUndefined();
    expect(test.currentRecord).not.toHaveBeenCalled();
  });

  it('keeps the hard-expiry foreground decision even while authority grace exists', async () => {
    const test = fixture();

    test.currentRecord.mockResolvedValue(await record());

    await routeHostedDocument(test.input());

    await test.drain();

    test.clock.now += 301_000;

    const response = await routeHostedDocument(test.input());

    await test.drain();

    await expect(response.text()).resolves.toBe('foreground regeneration');
  });

  it('does not invent a generation on authority absence and bounds retry cadence', async () => {
    const test = fixture();
    await routeHostedDocument(test.input());

    await test.drain();

    await routeHostedDocument(test.input());

    await test.drain();

    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(held(test)).toBeUndefined();

    test.clock.now += 1000;

    await routeHostedDocument(test.input());

    await test.drain();

    expect(test.currentRecord).toHaveBeenCalledTimes(2);
    expect(held(test)).toBeUndefined();
  });

  it('rejects authority bytes naming a different entry', async () => {
    const test = fixture();

    test.currentRecord.mockResolvedValue(await record(1, 'ent_different'));

    await routeHostedDocument(test.input());

    await test.drain();

    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(held(test)).toBeUndefined();
  });

  it('does not replace a later record learned while the background read was pending', async () => {
    const test = fixture();
    const pending = Promise.withResolvers<ArrayBuffer | undefined>();

    test.currentRecord.mockReturnValue(pending.promise);

    await routeHostedDocument(test.input());

    test.kv.mockResolvedValue(await record(2));

    await readGeneration(test.edge, KEY, SETTINGS);
    pending.resolve(await record());

    await test.drain();

    expect(held(test)?.header.revision).toBe(2);
    expect(
      test.edge.runtime.memory.generations.get(RECORD_KEY)?.authorityConfirmedAt,
    ).toBeUndefined();
  });

  it('does not adopt a record invalidated while the authority read was pending', async () => {
    const test = fixture();
    const pending = Promise.withResolvers<ArrayBuffer | undefined>();

    test.currentRecord.mockReturnValue(pending.promise);

    await routeHostedDocument(test.input());

    test.edge.runtime.memory.invalidations.take(SCOPE, ['posts'], 2);

    pending.resolve(await record());

    await test.drain();

    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(held(test)).toBeUndefined();
  });

  it('ignores authority bytes that arrive after the background deadline', async () => {
    const test = fixture();
    const next = await record();
    const pending = Promise.withResolvers<ArrayBuffer | undefined>();

    test.currentRecord.mockReturnValue(pending.promise);

    vi.useFakeTimers();
    await routeHostedDocument(test.input());
    await vi.advanceTimersByTimeAsync(1001);

    await test.drain();

    pending.resolve(next);
    await vi.advanceTimersByTimeAsync(0);

    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(held(test)).toBeUndefined();
  });

  it.each(['HEAD', 'validation', 'disabled', 'bypass'] as const)(
    'does not start an authority lookup for %s',
    async (kind) => {
      const test = fixture();
      const input = test.input(
        kind === 'HEAD'
          ? { method: 'HEAD' }
          : { headers: kind === 'bypass' ? { 'next-action': 'action' } : {} },
      );
      const overrides = {
        HEAD: {},
        validation: { validated: true },
        disabled: {
          policy: {
            ...test.edge.policy,
            runtimeCache: { ...SETTINGS, generations: 'off' as const },
          },
        },
        bypass: {},
      };
      await routeHostedDocument({ ...input, edge: { ...input.edge, ...overrides[kind] } });

      await test.drain();

      expect(test.currentRecord).not.toHaveBeenCalled();
    },
  );

  it('does not query authority when KV returns corrupt bytes', async () => {
    const test = fixture();

    test.kv.mockResolvedValue(new ArrayBuffer(0));

    await routeHostedDocument(test.input());

    await test.drain();

    expect(test.currentRecord).not.toHaveBeenCalled();
  });
});
