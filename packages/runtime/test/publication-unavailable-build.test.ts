import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { admitBuildSource, requirePublication } from '../src/publication.ts';
import type { RoutedInput } from '../src/serve.ts';

const NOW = 1_800_000_000_000;
const ROUTE = '/items';
const ID = 'a'.repeat(64);
const GRANT = `upwind:publication:v1:${ID}:${String(NOW + 1000)}`;
const SNAPSHOT = `upwind:resource-snapshot:v1:${'b'.repeat(64)}:1`;

function fixture() {
  const request = new Request('https://site.test/items');
  const cache = {
    host: {
      publication: {
        version: 3,
        valueObservers: true,
        resourceSnapshots: true,
        identities: [ID],
        routes: [ROUTE],
      },
    },
  } as unknown as CacheRuntime;
  const tables = { app: { entries: {} }, edge: { entries: {} } };
  const context = requestContextFor({
    tables,
    runtime: cache,
    request,
    startedAt: NOW,
    waitUntil: vi.fn(),
    clock: NOW,
  });
  const input: RoutedInput = {
    ...tables,
    request,
    cache,
    waitUntil: vi.fn(),
    run: context.run,
    initURL: request.url,
  };
  return { input, context };
}

describe('unavailable build publication admission', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: 'expired grant', tags: [`upwind:publication:v1:${ID}:${String(NOW)}`, SNAPSHOT] },
    { name: 'malformed grant', tags: ['upwind:publication:v1:invalid', SNAPSHOT] },
    { name: 'malformed snapshot', tags: [GRANT, 'upwind:resource-snapshot:v1:invalid:0'] },
    { name: 'missing grant', tags: [SNAPSHOT] },
  ])('returns the unavailable response for $name instead of throwing', async ({ tags }) => {
    const test = fixture();
    const cancel = vi.fn();
    const source = new Response(new ReadableStream({ cancel }));

    const response = await test.context.run(() => {
      requirePublication(test.input.cache, ROUTE);
      return Promise.resolve(admitBuildSource(test.input, ROUTE, source, tags));
    });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('Publication unavailable');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(cancel).toHaveBeenCalledExactlyOnceWith('publication expired');
    expect(test.context.publication.size).toBe(0);
  });

  it('still observes a valid original grant when the source itself answers 503', async () => {
    const test = fixture();

    const response = await test.context.run(() => {
      requirePublication(test.input.cache, ROUTE);
      return Promise.resolve(
        admitBuildSource(
          test.input,
          ROUTE,
          new Response('current unavailable data', { status: 503 }),
          [GRANT, SNAPSHOT],
        ),
      );
    });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('current unavailable data');
    expect(test.context.publication).toContain(GRANT);
    expect(test.context.resourceTags).toContain(SNAPSHOT);
  });
});
