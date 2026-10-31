import { AsyncLocalStorage } from 'node:async_hooks';

import { publicationIdentity, publicationDeadline } from '@stayingupwind/core/cache';
import {
  beginPublicationRead,
  observePublicationGrant,
  observePrivatePublication,
  installNextCacheRegistry,
  type NextCacheStore,
  type NextStorage,
} from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NEXT_CACHE_STORAGE_SYMBOL_KEY } from '../../core/src/paas/next-cache-registry.ts';
import { requestContextFor } from '../src/cache/context.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { admitRequestPublication, requirePublication } from '../src/publication.ts';

const NOW = 1_800_000_000_000;
const grant = {
  scope: 'records',
  dataGeneration: 'generation-1',
  publicationEpoch: 1,
  release: { id: 'release-1', digest: 'b'.repeat(64) },
  validUntil: NOW + 1000,
};
const bytes = (value: string) => new TextEncoder().encode(value);

async function scenario() {
  const context = requestContextFor({
    tables: { app: { entries: {} }, edge: { entries: {} } },
    runtime: undefined,
    request: new Request('https://example.test/items'),
    startedAt: NOW,
    waitUntil: vi.fn(),
    clock: undefined,
  });
  context.publicationRequirement = {
    version: 1,
    identities: [await publicationIdentity(grant)],
    routes: ['/items'],
  };
  const clock = vi.spyOn(performance, 'now').mockReturnValue(NOW - performance.timeOrigin);
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({
    start: (value) => {
      controller = value;
    },
    cancel,
  });
  const response = new Response(source, {
    headers: {
      'cache-control': 'public,s-maxage=3600,no-transform',
      'cdn-cache-control': 'max-age=3600',
    },
  });
  return { context, clock, cancel, response, source: () => controller! };
}

describe('publication observations during a streamed response', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([204, 304])(
    'cannot extend a grant through a cacheable bodyless response (%s)',
    async (status) => {
      const { context } = await scenario();
      await context.run(() => observePublicationGrant(grant));
      const admitted = admitRequestPublication(
        new Response(null, {
          status,
          headers: { 'cache-control': 'public,s-maxage=3600', 'cdn-cache-control': 'max-age=3600' },
        }),
        context,
      );

      expect(admitted.status).toBe(status);
      expect(admitted.headers.get('cache-control')).toBe('private, no-store');
      expect(admitted.headers.has('cdn-cache-control')).toBe(false);
    },
  );

  it('admits a v2 outer shell before its descendant has started the authority read', async () => {
    const { context, source, response } = await scenario();
    const publication = {
      ...context.publicationRequirement!,
      version: 2 as const,
      valueObservers: true as const,
    };
    await context.run(() => {
      requirePublication({ host: { publication } } as unknown as CacheRuntime, '/items');
      return Promise.resolve();
    });
    const reader = admitRequestPublication(response, context).body!.getReader();
    source().enqueue(bytes('outer shell'));

    await expect(reader.read()).resolves.toMatchObject({ value: bytes('outer shell') });

    // The ancestor resolves only after the shell was accepted. No authority preflight occurred.
    await context.run(() => observePublicationGrant(grant));
    source().enqueue(bytes('inner data'));
    source().close();

    await expect(reader.read()).resolves.toMatchObject({ value: bytes('inner data') });
    await expect(reader.read()).resolves.toStrictEqual({ done: true, value: undefined });
  });

  it('streams an independent Suspense shell before its existing authority call resolves', async () => {
    const { context, source, response } = await scenario();
    await context.run(() => {
      beginPublicationRead();
      return Promise.resolve();
    });
    const admitted = admitRequestPublication(response, context);

    expect(admitted.status).toBe(200);
    expect(admitted.headers.get('cache-control')).toBe('private, no-store, no-transform');
    expect(admitted.headers.has('cdn-cache-control')).toBe(false);

    const reader = admitted.body!.getReader();
    source().enqueue(bytes('shell'));

    await expect(reader.read()).resolves.toMatchObject({ value: bytes('shell') });

    await context.run(() => observePublicationGrant(grant));
    source().enqueue(bytes('protected part'));

    await expect(reader.read()).resolves.toMatchObject({ value: bytes('protected part') });

    source().close();

    await expect(reader.read()).resolves.toStrictEqual({ done: true, value: undefined });
  });

  it('rejects a late expired child before its values and bytes can be emitted', async () => {
    const { context, source, response, cancel } = await scenario();
    await context.run(() => observePublicationGrant(grant));
    const reader = admitRequestPublication(response, context).body!.getReader();
    source().enqueue(bytes('first part'));
    await reader.read();

    await expect(
      context.run(() => observePublicationGrant({ ...grant, validUntil: NOW })),
    ).rejects.toThrow('Publication unavailable');

    source().enqueue(bytes('expired secret'));

    await expect(reader.read()).rejects.toThrow('Publication unavailable');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('checks the fresh clock after awaiting a deferred chunk', async () => {
    const { context, source, response, clock, cancel } = await scenario();
    await context.run(() => observePublicationGrant(grant));
    const reader = admitRequestPublication(response, context).body!.getReader();
    const pending = reader.read();
    clock.mockReturnValue(grant.validUntil - performance.timeOrigin);
    source().enqueue(bytes('late secret'));

    await expect(pending).rejects.toThrow('Publication unavailable');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not complete a pending stream without an actual authority proof', async () => {
    const { context, source, response, cancel } = await scenario();
    await context.run(() => {
      beginPublicationRead();
      return Promise.resolve();
    });
    const reader = admitRequestPublication(response, context).body!.getReader();
    source().close();

    await expect(reader.read()).rejects.toThrow('Publication unavailable');
    // A closed upstream need not call its cancellation callback.
    expect(cancel).not.toHaveBeenCalled();
  });

  it('propagates downstream cancellation without pulling an unready deferred part', async () => {
    const { context, response, cancel } = await scenario();
    await context.run(() => {
      beginPublicationRead();
      return Promise.resolve();
    });
    await admitRequestPublication(response, context).body!.cancel('visitor left');

    expect(cancel).toHaveBeenCalledExactlyOnceWith('visitor left');
  });

  it('admits an authenticated private identity without minting a public deadline', async () => {
    const { context, response, source } = await scenario();
    await context.run(() => observePrivatePublication(grant));

    expect(publicationDeadline([...context.publication])).toBe(0);

    const admitted = admitRequestPublication(response, context);
    source().enqueue(bytes('private result'));
    source().close();

    expect(admitted.headers.get('cache-control')).toContain('no-store');
    await expect(admitted.text()).resolves.toBe('private result');
  });

  it('does not let a private identity exempt an expired public child', async () => {
    const { context } = await scenario();
    await context.run(() => observePrivatePublication(grant));

    await expect(
      context.run(() => observePublicationGrant({ ...grant, validUntil: NOW })),
    ).rejects.toThrow('Publication unavailable');
  });

  it('refuses a private result inside a shared Next component cache', async () => {
    installNextCacheRegistry();
    const stores = new AsyncLocalStorage<NextCacheStore>();
    const register = Reflect.get(globalThis, Symbol.for(NEXT_CACHE_STORAGE_SYMBOL_KEY)) as (
      storage: NextStorage<NextCacheStore>,
    ) => void;
    register(stores);

    await expect(
      stores.run({ type: 'cache' }, () => observePrivatePublication(grant)),
    ).rejects.toThrow('Private publication cannot enter a shared cache.');
  });
});
