import type { Prerender } from '@stayingupwind/core/bundle';
import { deriveEntry, packBodyDigests, policyFromBuild } from '@stayingupwind/core/cache';
import { withDeadline } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import type { NodeHandler } from '../../src/app-module.ts';
import { createCacheRuntime } from '../../src/cache/runtime.ts';
import { documentFromBuild } from '../../src/documents.ts';
import { serveFromGeneration } from '../../src/generations.ts';
import { concatShell, type RoutedInput } from '../../src/serve.ts';
import type { Store } from '../../src/store.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEADLINE_MS = 1000;
const shell: Prerender = {
  id: '/page',
  route: '/page',
  pathname: '/page',
  parentOutputId: '/page',
  groupId: 1,
  body: { sha256: 'shell', byteLength: 5, contentType: 'text/html' },
  postponed: { sha256: 'state', byteLength: 5, contentType: 'text/plain' },
};

/** Only the build artifacts a document reads; the handler below is a real Node bridge request. */
const store = {
  manifest: { entrypoints: [{ pathname: '/page', kind: 'app-page' }] },
  prerendersByPathname: new Map([['/page', shell]]),
  shellsByRoute: new Map([['/page', { pages: new Map([['/page', shell]]), patterns: [] }]]),
  readBlob: (id: string) => encoder.encode(id === 'shell' ? 'SHELL' : 'state'),
} as unknown as Store;

/** A fresh generation already held locally, so only the resume can delay this response. */
async function generationInput(): Promise<RoutedInput> {
  const scopeId = 'dpl_4Fixture2Minima1AppXy';
  const descriptor = { kind: 'app-page' as const, route: '/page', pathname: '/page' };
  const runtime = createCacheRuntime({
    env: {
      NEXT_DEPLOYMENT_ID: scopeId,
      ARKOR_CACHE_GATEWAY_URL: 'https://cache.fixture.test',
      ARKOR_CACHE_TOKEN: 'test-token',
    },
    now: Date.now,
    fetchImpl: () => {
      throw new Error('a fresh local generation needs no gateway request');
    },
  });
  if (runtime === undefined) {
    throw new Error('no cache runtime');
  }
  const { entryId } = await deriveEntry(scopeId, descriptor);
  const html = encoder.encode('SHELL');
  const postponed = encoder.encode('state');
  runtime.recordMemo.set(entryId, {
    header: {
      schemaVersion: 1,
      scopeId,
      entryId,
      generationId: 'gen_1',
      seq: 1,
      source: 'build',
      ...descriptor,
      cacheTimestamp: Date.now(),
      producedAt: Date.now(),
      policy: policyFromBuild({ initialRevalidate: false }),
      status: 200,
      headers: {},
      tags: [],
      artifacts: [],
      revision: 1,
      ...(await packBodyDigests(html, postponed)),
    },
    html,
    postponed,
  });
  return { ...input(), cache: runtime };
}

function input(): RoutedInput {
  return {
    app: { entries: {} },
    edge: { entries: {} },
    request: new Request('https://fixture.test/page'),
    initURL: 'https://fixture.test/page',
    run: (work) => work(),
    waitUntil: () => {
      // These handlers schedule no background work.
    },
  };
}

describe('a document streamed ahead of its continuation', () => {
  it.each(['build', 'generation'] as const)(
    'returns the %s shell while the Node handler waits for headers',
    async (source) => {
      const gate = Promise.withResolvers<undefined>();
      const handler: NodeHandler = async (_request, reply) => {
        await gate.promise;
        reply.end('TAIL');
      };
      const entry = { kind: 'node' as const, handler };
      const resolved = { route: '/page', pathname: '/page', url: '/page' };
      const response =
        source === 'build'
          ? documentFromBuild(input(), store, resolved, { status: 200, entry })
          : serveFromGeneration(
              await generationInput(),
              store,
              { ...resolved, representation: 'html', onMiss: 'build' },
              entry.handler,
            );
      try {
        const answered = await withDeadline(response, DEADLINE_MS, 'shell response');
        const reader = answered?.body?.getReader();

        expect(reader).toBeDefined();

        const first = await withDeadline(reader!.read(), DEADLINE_MS, 'shell bytes');

        expect(decoder.decode(first.value)).toBe('SHELL');

        gate.resolve(undefined);

        expect(decoder.decode((await reader!.read()).value)).toBe('TAIL');
        await expect(reader!.read()).resolves.toMatchObject({ done: true });
      } finally {
        gate.resolve(undefined);
      }
    },
  );

  it('errors the stream instead of appending a failed resume response to the shell', async () => {
    const reader = concatShell(
      encoder.encode('SHELL'),
      Promise.resolve(new Response('Internal Server Error', { status: 500 })),
    ).getReader();

    expect(decoder.decode((await reader.read()).value)).toBe('SHELL');
    await expect(reader.read()).rejects.toThrow('resume answered 500');
  });

  it('observes a rejected resume even before the continuation is pulled', async () => {
    const reader = concatShell(
      encoder.encode('SHELL'),
      Promise.reject(new Error('resume failed')),
    ).getReader();

    expect(decoder.decode((await reader.read()).value)).toBe('SHELL');
    await expect(reader.read()).rejects.toThrow('resume failed');
  });

  it('cancels immediately and releases a continuation whose headers arrive later', async () => {
    const gate = Promise.withResolvers<Response>();
    const released = Promise.withResolvers<unknown>();
    const reader = concatShell(encoder.encode('SHELL'), gate.promise).getReader();
    await reader.read();
    await withDeadline(reader.cancel('visitor left'), DEADLINE_MS, 'cancel shell');
    gate.resolve(
      new Response(
        new ReadableStream({
          cancel(reason: unknown) {
            released.resolve(reason);
          },
        }),
      ),
    );

    await expect(withDeadline(released.promise, DEADLINE_MS, 'cancel resume')).resolves.toBe(
      'visitor left',
    );
  });

  it('cancels a continuation already waiting for its next bytes', async () => {
    const released = Promise.withResolvers<unknown>();
    const response = new Response(
      new ReadableStream({
        cancel(reason: unknown) {
          released.resolve(reason);
        },
      }),
    );
    const reader = concatShell(encoder.encode('SHELL'), Promise.resolve(response)).getReader();
    await reader.read();
    const pending = reader.read();
    await reader.cancel('visitor left');

    await expect(released.promise).resolves.toBe('visitor left');
    await expect(pending).resolves.toMatchObject({ done: true });
  });
});
