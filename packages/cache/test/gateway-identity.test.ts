import { deriveEntry, type EntryDescriptor } from '@stayingupwind/core/cache';
import { toBase64 } from '@stayingupwind/core/util';
import {
  type DataGetRequest,
  type DataGetResponse,
  MAX_DATA_KEY_LENGTH,
  type StartAttemptResponse,
} from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { describe, expect, it, vi } from 'vitest';

import { cacheHostFor } from '../src/function/cache-host.ts';
import { DataCopies } from '../src/function/data-copies.ts';
import { Gateway } from '../src/function/gateway.ts';
import { ReadBudget } from '../src/function/read-budget.ts';

const SCOPE = 'scope_identity';
const ENTRY = { kind: 'app-page', route: '/articles/[slug]', pathname: '/articles/a' } as const;

/** A real client parses the response; only its transport supplies the deliberate wrong entry. */
function gatewayFor(result: unknown) {
  const send = vi.fn<FetchLike>().mockResolvedValue(Response.json({ ok: true, result }));
  const gateway = new Gateway({
    gatewayUrl: 'https://cache.example',
    scopeId: SCOPE,
    token: 'scope-token',
    naming: { copyCache: 'copies', copyKeyOrigin: 'https://copies.example' },
    fetchImpl: send,
  });
  return { gateway, send };
}

async function valueOf(request: DataGetRequest): Promise<DataGetResponse> {
  const { entryId } = await deriveEntry(SCOPE, request);
  return {
    entryId,
    generationId: 'generation_value',
    dependencyRevision: 1,
    entry: {
      kind: request.kind,
      ...(request.handler !== undefined && { handler: request.handler }),
      tags: [],
      stale: 30,
      timestamp: 1,
      expire: 120,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
    value: { kind: 'inline', base64: btoa('value') },
  };
}

async function attemptOf(
  descriptor: EntryDescriptor,
  kind: 'leased' | 'busy',
): Promise<StartAttemptResponse> {
  const { entryId } = await deriveEntry(SCOPE, descriptor);
  const common = { entryId, attemptId: 'attempt_current', leaseExpiresAt: 10_000, current: null };
  return kind === 'leased'
    ? { ...common, kind, fencingToken: 1, dependencyRevision: 0 }
    : { ...common, kind };
}

const READS: readonly DataGetRequest[] = [
  { kind: 'data:fetch', key: 'key-a' },
  { kind: 'data:use-cache', handler: 'remote', key: 'key-a' },
];

describe('the entry named by a gateway answer', () => {
  describe.each(READS)('$kind', (request) => {
    it.each(['getData', 'currentData'] as const)(
      'refuses %s bytes of a different key in the same namespace',
      async (method) => {
        const { gateway, send } = gatewayFor(await valueOf({ ...request, key: 'key-b' }));

        await expect(gateway[method](request)).rejects.toThrow(/another entry/u);
        expect(send).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['getData', 'currentData'] as const)(
      'accepts %s bytes of the requested key',
      async (method) => {
        const value = await valueOf(request);
        const { gateway, send } = gatewayFor(value);

        await expect(gateway[method](request)).resolves.toStrictEqual(value);
        expect(send).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('accepts the largest key the data contract permits', async () => {
    const request = { kind: 'data:fetch', key: 'x'.repeat(MAX_DATA_KEY_LENGTH) } as const;
    const value = await valueOf(request);
    const { gateway, send } = gatewayFor(value);

    await expect(gateway.getData(request)).resolves.toStrictEqual(value);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['leased', 'busy'] as const)(
    'refuses a %s answer for a different route',
    async (kind) => {
      const { gateway, send } = gatewayFor(
        await attemptOf({ ...ENTRY, pathname: '/articles/b' }, kind),
      );

      await expect(gateway.startAttempt({ entry: ENTRY, reason: 'miss' })).rejects.toThrow(
        /another entry/u,
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['leased', 'busy'] as const)(
    'accepts a %s answer under pathname normalization and query metadata',
    async (kind) => {
      const value = await attemptOf(ENTRY, kind);
      const { gateway, send } = gatewayFor(value);

      await expect(
        gateway.startAttempt({
          entry: { ...ENTRY, pathname: `${ENTRY.pathname}/` },
          allowQuery: ['language'],
          reason: 'miss',
        }),
      ).resolves.toStrictEqual(value);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
});

describe('the entry named by a data copy', () => {
  it('reads a kept 600 KiB value after another isolate gets a KV miss', async () => {
    const scopeId = `scope-${crypto.randomUUID()}`;
    const request = { kind: 'data:fetch', key: 'large-written-value' } as const;
    const { entryId } = await deriveEntry(scopeId, request);
    const original = await valueOf(request);
    const base64 = toBase64(new Uint8Array(600 * 1024));
    const answer = {
      ...original,
      entryId,
      entry: { ...original.entry, timestamp: Date.now(), expire: 3600 },
      value: { kind: 'inline' as const, base64 },
    };
    const naming = { copyCache: 'large-data-copies', copyKeyOrigin: 'https://copies.example' };
    const copies = new DataCopies(
      caches,
      naming,
      { scopeId, token: 'scope-token' },
      new ReadBudget(2 * 1024 * 1024),
    );
    await copies.keep(
      { key: request.key, entry: answer.entry, valueBase64: base64 },
      { entryId, generationId: answer.generationId, revision: answer.dependencyRevision },
    );

    await expect(copies.find(request)).resolves.toStrictEqual(answer);

    const missing = Response.json({ ok: false, error: { code: 'not_found' } }, { status: 404 });
    const send = vi.fn<FetchLike>().mockResolvedValue(missing);
    const createHost = cacheHostFor(naming);
    const binding = createHost({
      env: {
        ARKOR_CACHE_GATEWAY_URL: 'https://authority.example',
        ARKOR_CACHE_READ_GATEWAY_URL: 'https://read.example',
        ARKOR_CACHE_TOKEN: 'scope-token',
        NEXT_DEPLOYMENT_ID: scopeId,
      },
      fetchImpl: send,
    });

    await expect(binding?.host.getData(request)).resolves.toStrictEqual(answer);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].url).toContain('https://read.example/');
  });

  it.each(['key', 'kind', 'handler', 'entry-id', 'matching'] as const)(
    'judges a cached %s identity before answering',
    async (variation) => {
      const scopeId = `scope-${crypto.randomUUID()}`;
      const request = { kind: 'data:use-cache', key: 'key-a', handler: 'remote' } as const;
      const derived = await deriveEntry(scopeId, request);
      const value = await valueOf(request);
      const answer = {
        ...value,
        entryId: derived.entryId,
        entry: { ...value.entry, timestamp: Date.now(), expire: 3600 },
      };
      switch (variation) {
        case 'key': {
          answer.entryId = (await deriveEntry(scopeId, { ...request, key: 'key-b' })).entryId;

          break;
        }
        case 'kind': {
          answer.entry.kind = 'data:fetch';
          delete answer.entry.handler;

          break;
        }
        case 'handler': {
          answer.entry.handler = 'another-handler';

          break;
        }
        case 'entry-id': {
          answer.entryId = 'entry_wrong';

          break;
        }
        case 'matching': {
          break;
        }
      }
      const copies = new DataCopies(
        caches,
        { copyCache: 'data-copy-identities', copyKeyOrigin: 'https://copies.example' },
        { scopeId, token: 'scope-token' },
        new ReadBudget(2 * 1024 * 1024),
      );
      // A schema-valid value planted at the requested key, as unrelated application code can do.
      await copies.keepCurrent(request, answer);

      const found = await copies.find(request);

      expect(found).toStrictEqual(variation === 'matching' ? answer : undefined);
    },
  );
});
