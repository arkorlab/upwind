import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { CACHE_ENTRY_HEADER, GENERATION_HEADER } from '@stayingupwind/core/paas';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { keepCopyAhead, readCopy } from '../src/cache/generation-copy.ts';
import { readCurrentBehind } from '../src/cache/generation-current.ts';
import { loadGeneration } from '../src/cache/generation-hold.ts';
import { readGeneration } from '../src/cache/generation-loader.ts';
import { regenerationHeaders } from '../src/cache/regenerate.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const NOW = 100;
const SCOPE = 'scope-wire-identities';
const BODY = encodeUtf8('a complete generation');
const SETTINGS = { ...DEFAULT_RUNTIME_CACHE_SETTINGS, cacheApiMaxAgeMs: 0 };
const COPY_SETTINGS = { ...SETTINGS, cacheApiMaxAgeMs: 1000 };

function fixture(): EdgeContext {
  return {
    env,
    ctx: createExecutionContext(),
    runtime: standaloneRuntime(env, { memory: createEdgeMemory(() => NOW), now: () => NOW }),
    host: standaloneHost(env),
    forwarding: {
      previewDomain: 'example.test',
      previewHost: 'customer.example.test',
      clientIp: undefined,
    },
    app: undefined,
    originalUrl: undefined,
    policy: DEFAULT_DELIVERY_POLICY,
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: true,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: 'b'.repeat(64),
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: 0 },
  };
}

async function record(entryId: string, generationId: string, revision = 1): Promise<ArrayBuffer> {
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId,
      seq: revision,
      revision,
      source: 'runtime',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: await sha256Hex(BODY),
      htmlLength: BODY.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    BODY,
    undefined,
  );
  return new Uint8Array(bytes).buffer;
}

function decoded(bytes: ArrayBuffer) {
  const value = decodeGenerationPack(new Uint8Array(bytes));
  if (value.kind !== 'ok') throw new TypeError('the fixture record must decode');
  return value.pack;
}

describe('generation identities adopted before regeneration headers are built', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { entryId: 'entry-wire-nul', generationId: 'generation\u{0}bad' },
    { entryId: 'entry-日本語', generationId: 'generation-wire-entry' },
    { entryId: 'entry-wire-astral', generationId: 'generation-\u{1F600}' },
    { entryId: 'entry-wire-crlf\r\n', generationId: 'generation-wire-entry' },
  ])(
    'refuses an invalid KV identity before holding $entryId',
    async ({ entryId, generationId }) => {
      const edge = fixture();
      const key = { scopeId: SCOPE, entryId };
      const recordKey = kvGenerationKey(SCOPE, entryId);
      await env.CACHE_STATE.put(recordKey, await record(entryId, generationId));

      const load = await readGeneration(edge, key, SETTINGS);
      await waitOnExecutionContext(edge.ctx);

      expect(load).toMatchObject({ kind: 'unusable', reason: 'corrupt' });
      expect(edge.runtime.memory.generations.get(recordKey)).toBeUndefined();
    },
  );

  it('refuses a copy whose generation ID ends in a newline before the appended timestamp', async () => {
    const edge = fixture();
    const entryId = 'entry-wire-copy';
    const key = { scopeId: SCOPE, entryId };
    const recordKey = kvGenerationKey(SCOPE, entryId);
    const bytes = await record(entryId, 'generation-copy\r\n');
    await env.CACHE_STATE.delete(recordKey);
    // A failed KV read must actually try the copy, rather than disproving it before adoption.
    vi.spyOn(env.CACHE_STATE, 'get').mockRejectedValueOnce(new Error('fixture KV unavailable'));
    await keepCopyAhead(
      edge,
      recordKey,
      { bytes, revision: 1 },
      { maxAgeMs: 1000, wanted: () => true },
    );
    const copy = await readCopy(edge, recordKey, 1000);

    expect(copy?.revision).toBe(1);

    const load = await readGeneration(edge, key, COPY_SETTINGS);
    await waitOnExecutionContext(edge.ctx);

    expect(load.kind).not.toBe('generation');
    expect(edge.runtime.memory.generations.get(recordKey)).toBeUndefined();
  });

  it('does not adopt a newer authority currentRecord with an invalid generation ID', async () => {
    const original = fixture();
    const entryId = 'entry-wire-authority';
    const recordKey = kvGenerationKey(SCOPE, entryId);
    const initial = decoded(await record(entryId, 'generation-current'));
    const unsafe = await record(entryId, 'generation-次', 2);
    const currentRecord = vi
      .fn<NonNullable<EdgeContext['host']['currentRecord']>>()
      .mockResolvedValue(unsafe);
    const edge = { ...original, host: { ...original.host, currentRecord } };
    const held = { pack: initial, readAt: NOW, bytes: BODY.byteLength };
    edge.runtime.memory.generations.set(recordKey, held, BODY.byteLength);

    readCurrentBehind(edge, initial, SETTINGS, 1000);
    await waitOnExecutionContext(edge.ctx);

    expect(currentRecord).toHaveBeenCalledWith(SCOPE, entryId, 1);
    expect(edge.runtime.memory.generations.get(recordKey)).toBe(held);
  });

  it('keeps header-safe Latin1 IDs and serves the next request from memory without another read', async () => {
    const edge = fixture();
    const entryId = 'entry-wire-é';
    const generationId = 'generation-wire-é';
    const key = { scopeId: SCOPE, entryId };
    const recordKey = kvGenerationKey(SCOPE, entryId);
    await env.CACHE_STATE.put(recordKey, await record(entryId, generationId));
    const get = vi.spyOn(env.CACHE_STATE, 'get');

    const first = await loadGeneration(edge, key, SETTINGS);
    const second = await loadGeneration(edge, key, SETTINGS);
    await waitOnExecutionContext(edge.ctx);

    assert(first.kind === 'generation', 'the safe record must be adopted');

    const headers = new Headers(
      regenerationHeaders(edge, 'foreground', { pack: first.pack, entryId }),
    );

    expect(first.source).toBe('kv');
    expect(second.kind === 'generation' && second.source).toBe('memory');
    expect(get).toHaveBeenCalledTimes(1);
    expect(headers.get(CACHE_ENTRY_HEADER)).toBe(entryId);
    expect(headers.get(GENERATION_HEADER)).toBe(generationId);
  });
});
