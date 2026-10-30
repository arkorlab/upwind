import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { RouteCache } from '@stayingupwind/core/manifest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type CachedDocumentInput, serveCachedDocument } from '../src/cache/document.ts';
import type { GenerationLoad } from '../src/cache/generation-loader.ts';
import { InvalidationMemory } from '../src/memory/invalidations.ts';

// This orchestration test runs under Node with every storage, document and dispatch boundary
// mocked. It exercises the real generation decision and build guard without starting a Worker.
const mocks = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    document: vi.fn((input: { generation?: unknown; onBuildServed?: (() => void) | undefined }) => {
      const body = input.generation === undefined ? 'old build' : 'fresh generation';
      const response = new Response(body);
      events.push('composed');
      input.onBuildServed?.();
      return Promise.resolve(response);
    }),
    regenerate: vi.fn(),
    refresh: vi.fn(() => {
      events.push('refresh');
    }),
  };
});

vi.mock(import('../src/handlers/document.ts'), () => ({ handleDocument: mocks.document }));
vi.mock(import('../src/cache/generation-hold.ts'), () => {
  const heldGeneration = vi.fn();
  return { heldGeneration, readServedAgain: vi.fn() };
});
vi.mock(import('../src/cache/generation-loader.ts'), () => ({ readGeneration: vi.fn() }));
vi.mock(import('../src/cache/generation-current.ts'), () => {
  const readAbsentRecordBehind = mocks.refresh;
  return { readAbsentRecordBehind };
});
vi.mock(import('../src/cache/member.ts'), () => {
  const memberInHand = vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined);
  return { memberInHand };
});
vi.mock(import('../src/cache/regenerate.ts'), () => {
  return {
    allowAnotherAsk: vi.fn(),
    foregroundDocument: mocks.regenerate,
    regenerationHeaders: vi.fn(),
    shouldAsk: vi.fn(),
    triggerDetached: vi.fn(),
  };
});
vi.mock(import('../src/preview/storage.ts'), () => ({ keptReadsOut: vi.fn() }));
vi.mock(import('../src/strategies/shell-loader.ts'), () => ({ loadShell: vi.fn() }));

const NOW = 1_800_000_000_000;
const KEY = { scopeId: 'scope', entryId: 'entry' };
const CACHE: RouteCache = {
  entryId: KEY.entryId,
  kind: 'app-page',
  delivery: 'complete',
  buildTags: [{ kind: 'next-explicit', value: 'test-update-tag' }],
};

function scenario(load: GenerationLoad) {
  const invalidations = new InvalidationMemory(() => NOW);
  const shell = Promise.resolve({ kind: 'missing' as const });
  const waitUntil = vi.fn();
  const passthrough = vi.fn(() => Promise.resolve(new Response('new runtime render')));
  const input: CachedDocumentInput = {
    request: new Request('https://app.example/update-tag-test'),
    entry: {
      pathname: '/update-tag-test',
      cache: CACHE,
      headers: {},
      status: 200,
      shell: {
        sha256: 'a'.repeat(64),
        byteLength: 1,
        contentType: 'text/html',
        encoding: 'identity',
      },
    },
    key: KEY,
    edge: {
      runtime: { now: () => NOW, memory: { invalidations } },
      ctx: { waitUntil },
      // The orchestration reads only these members; the other EdgeContext boundaries are mocked.
    } as unknown as CachedDocumentInput['edge'],
    generationRead: { load: Promise.resolve(load), shell },
    member: undefined,
    passthrough,
    settings: {} as CachedDocumentInput['settings'],
    manifest: {} as CachedDocumentInput['manifest'],
    resolved: {} as CachedDocumentInput['resolved'],
    middleware: undefined,
  };
  return { input, invalidations, passthrough, shell, waitUntil };
}

async function freshRecord(): Promise<Extract<GenerationLoad, { kind: 'generation' }>> {
  const html = new TextEncoder().encode('fresh generation');
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      ...KEY,
      generationId: 'generation',
      seq: 2,
      revision: 7,
      source: 'runtime',
      kind: 'app-page',
      route: '/update-tag-test',
      pathname: '/update-tag-test',
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: false }),
      status: 200,
      headers: {},
      tags: CACHE.buildTags ?? [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    html,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') {
    throw new Error('fresh generation fixture did not decode');
  }
  return {
    kind: 'generation',
    pack: decoded.pack,
    source: 'memory',
    lookupMs: 0,
    readBytes: undefined,
  };
}

describe('document selection with a negatively cached record after updateTag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
  });

  it.each([
    { kind: 'none', lookupMs: 4 },
    { kind: 'unusable', lookupMs: 4, reason: 'corrupt' },
    { kind: 'unavailable', lookupMs: 4, held: undefined, detail: 'storage down' },
  ] satisfies GenerationLoad[])(
    'renders in front instead of reviving the affected build after $kind',
    async (load) => {
      const test = scenario(load);

      test.invalidations.takeResponse(KEY.scopeId, ['test-update-tag'], 7);

      const response = await serveCachedDocument(test.input);

      await expect(response.text()).resolves.toBe('new runtime render');
      expect(test.passthrough).toHaveBeenCalledExactlyOnceWith(
        'build-invalidated',
        undefined,
        '/update-tag-test',
        // With the request's account of the shell it read and dropped (`withShellAccounting`).
        {
          recordLookupMs: 4,
          abandonedShells: expect.objectContaining({ ctx: test.input.edge.ctx }) as unknown,
        },
      );
      expect(mocks.document).not.toHaveBeenCalled();
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(test.waitUntil).toHaveBeenCalledExactlyOnceWith(test.shell);
    },
  );

  it.each([
    { notification: 'unrelated', tags: ['other-tag'], revision: 7 },
    { notification: 'legacy', tags: ['test-update-tag'], revision: undefined },
  ])(
    'keeps the build fallback for an $notification notification without dispatching',
    async ({ tags, revision }) => {
      const test = scenario({ kind: 'none', lookupMs: 4 });

      test.invalidations.takeResponse(KEY.scopeId, tags, revision);

      const response = await serveCachedDocument(test.input);

      await expect(response.text()).resolves.toBe('old build');
      expect(test.passthrough).not.toHaveBeenCalled();
      expect(mocks.document).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ generation: undefined }),
      );
    },
  );

  it('keeps a max-profile invalidation in the background without dispatching', async () => {
    const test = scenario({ kind: 'none', lookupMs: 4 });

    test.invalidations.takeEach(KEY.scopeId, {
      atOnce: [],
      windowed: [{ tag: 'test-update-tag', revision: 7 }],
    });

    const response = await serveCachedDocument(test.input);

    await expect(response.text()).resolves.toBe('old build');
    expect(test.passthrough).not.toHaveBeenCalled();
  });

  it('refreshes an uncondemned absent record exactly once after build composition', async () => {
    const test = scenario({ kind: 'none', lookupMs: 4 });

    const response = await serveCachedDocument(test.input);

    await expect(response.text()).resolves.toBe('old build');
    expect(mocks.events).toStrictEqual(['composed', 'refresh']);
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(
      { ...test.input.edge, abandonedShells: { ctx: test.input.edge.ctx } },
      KEY,
      test.input.settings,
    );
    expect(test.passthrough).not.toHaveBeenCalled();
  });

  it('does not schedule absent-record adoption for a HEAD build response', async () => {
    const test = scenario({ kind: 'none', lookupMs: 4 });
    const input = {
      ...test.input,
      request: new Request<unknown, IncomingRequestCfProperties>(test.input.request.url, {
        method: 'HEAD',
      }),
    };

    await serveCachedDocument(input);

    expect(mocks.events).toStrictEqual(['composed']);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('serves a generation published at the acknowledged revision with no dispatch or new wait', async () => {
    const test = scenario(await freshRecord());

    test.invalidations.takeResponse(KEY.scopeId, ['test-update-tag'], 7);

    const response = await serveCachedDocument(test.input);

    await expect(response.text()).resolves.toBe('fresh generation');
    expect(test.passthrough).not.toHaveBeenCalled();
    expect(mocks.regenerate).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(test.waitUntil).toHaveBeenCalledExactlyOnceWith(test.shell);
  });
});

describe('bounded publication admission', () => {
  const identity = 'a'.repeat(64);
  const requirement = { version: 1 as const, identities: [identity], routes: ['/update-tag-test'] };

  it.each(['none', 'unusable'] as const)(
    'never revives a protected build when a %s record has no grant',
    async (kind) => {
      vi.clearAllMocks();
      const load: GenerationLoad =
        kind === 'none' ? { kind, lookupMs: 0 } : { kind, reason: 'corrupt', lookupMs: 0 };
      const test = scenario(load);

      test.input.manifest.publication = requirement;

      await expect((await serveCachedDocument(test.input)).text()).resolves.toBe(
        'new runtime render',
      );
      expect(test.passthrough).toHaveBeenCalledTimes(1);
      expect(mocks.document).not.toHaveBeenCalled();
    },
  );

  it('keeps a host-proven independent static shell available', async () => {
    vi.clearAllMocks();
    const test = scenario({ kind: 'none', lookupMs: 0 });

    test.input.manifest.publication = { ...requirement, independentBuild: ['/update-tag-test'] };

    await expect((await serveCachedDocument(test.input)).text()).resolves.toBe('old build');
    expect(test.passthrough).not.toHaveBeenCalled();
  });

  it('checks the same grant again after response preparation without another lookup', async () => {
    vi.clearAllMocks();
    const load = await freshRecord();
    load.pack.header.tags = [
      { kind: 'next-explicit', value: `upwind:publication:v1:${identity}:${String(NOW + 1)}` },
    ];
    const test = scenario(load);

    test.input.manifest.publication = requirement;

    let now = NOW;
    Object.assign(test.input.edge.runtime, { now: () => now });
    mocks.document.mockImplementationOnce(() => {
      now = NOW + 1;
      return Promise.resolve(new Response('old'));
    });

    expect((await serveCachedDocument(test.input)).status).toBe(503);
    expect(test.passthrough).not.toHaveBeenCalled();
  });

  it('checks a shipped build grant again after asynchronous shell composition', async () => {
    vi.clearAllMocks();
    const test = scenario({ kind: 'none', lookupMs: 0 });
    const until = NOW + 1;

    test.input.manifest.publication = requirement;

    test.input.entry.cache = {
      ...CACHE,
      buildTags: [
        { kind: 'next-explicit', value: `upwind:publication:v1:${identity}:${String(until)}` },
      ],
    };

    let now = NOW;
    Object.assign(test.input.edge.runtime, { now: () => now });
    mocks.document.mockImplementationOnce(() => {
      now = until;
      return Promise.resolve(new Response('expired build'));
    });

    expect((await serveCachedDocument(test.input)).status).toBe(503);
    expect(test.passthrough).not.toHaveBeenCalled();
  });
});
