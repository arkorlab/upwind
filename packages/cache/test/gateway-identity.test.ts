import { deriveEntry, type EntryDescriptor } from '@stayingupwind/core/cache';
import {
  type DataGetRequest,
  type DataGetResponse,
  MAX_DATA_KEY_LENGTH,
  type StartAttemptResponse,
} from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { describe, expect, it, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';

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
