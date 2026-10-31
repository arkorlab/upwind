import type { Prerender } from '@stayingupwind/core/bundle';
import {
  CACHE_ROUTE_HEADER,
  RESUME_STATE_BODY,
  RESUME_STATE_HEADER,
  RESUME_STATE_LENGTH_HEADER,
} from '@stayingupwind/core/paas';
import { PLATFORM_HEADER_PREFIX } from '@stayingupwind/core/request';
import { describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { admitRequestPublication } from '../src/publication.ts';
import { observeResumePublication } from '../src/resume-publication.ts';
import { handleRuntimeResume } from '../src/runtime-resume.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

vi.mock(import('../src/entries.ts'), () => ({ nodeHandlerOf: () => Promise.resolve(vi.fn()) }));
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: vi.fn(() =>
      Promise.resolve(new Response('suffix without another data read')),
    ),
  };
});
const ID = 'a'.repeat(64);
const NOW = 1_800_000_000_000;
const HEADER = `${PLATFORM_HEADER_PREFIX}publication-resume`;

async function answer(
  tags?: readonly string[],
  initialHeaders?: Prerender['initialHeaders'],
  snapshots = false,
) {
  const headers = new Headers({
    [CACHE_ROUTE_HEADER]: '/items',
    [RESUME_STATE_HEADER]: RESUME_STATE_BODY,
    [RESUME_STATE_LENGTH_HEADER]: '5',
  });
  if (tags !== undefined) headers.set(HEADER, JSON.stringify(tags));
  const request = new Request('https://site.test/items', {
    method: 'POST',
    body: 'state',
    headers,
  });
  const cache = {
    host: {
      publication: {
        version: snapshots ? 3 : 1,
        valueObservers: true,
        resourceSnapshots: true,
        identities: [ID],
        routes: ['/items'],
      },
    },
  } as unknown as CacheRuntime;
  const tables = { app: { entries: {} }, edge: { entries: {} } };
  const context = requestContextFor({
    tables,
    request,
    runtime: cache,
    startedAt: NOW,
    waitUntil: vi.fn(),
    clock: NOW,
  });
  const input: RoutedInput = {
    ...tables,
    request,
    initURL: request.url,
    cache,
    waitUntil: vi.fn(),
    run: context.run,
  };
  const store = {
    manifest: { config: { basePath: '' }, entrypoints: [{ pathname: '/items', kind: 'app-page' }] },
    prerendersByPathname: new Map(),
    dynamicRoutes: [],
  } as unknown as Store;
  return context.run(async () => {
    observeResumePublication(input, '/items', initialHeaders);
    return admitRequestPublication(await handleRuntimeResume(input, store), context);
  });
}

describe('selected publication grants on continuation resumes', () => {
  it('admits a suffix with no new data reads using only its selected generation grant', async () => {
    const response = await answer([`upwind:publication:v1:${ID}:${String(NOW + 1000)}`]);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('suffix without another data read');
  });

  it('retains all tags from Next prerender multi-value headers without another data read', async () => {
    const tags = [
      `upwind:publication:v1:${ID}:${String(NOW + 1000)}`,
      `upwind:publication:v1:${ID}:${String(NOW + 2000)}`,
    ];
    const response = await answer(undefined, { 'X-Next-Cache-Tags': ['resource', ...tags] });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('suffix without another data read');
  });

  it('does not discard an expired member of a multi-value prerender header', async () => {
    vi.mocked(invokeNodeHandler).mockClear();

    await expect(
      answer(undefined, {
        'x-next-cache-tags': [
          `upwind:publication:v1:${ID}:${String(NOW)}`,
          `upwind:publication:v1:${ID}:${String(NOW + 1000)}`,
        ],
      }),
    ).rejects.toThrow('Publication unavailable');
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('keeps the reused shell resource watermark when its suffix performs no new read', async () => {
    const response = await answer(
      undefined,
      {
        'x-next-cache-tags': [
          `upwind:publication:v1:${ID}:${String(NOW + 1000)}`,
          'source-resource',
          `upwind:resource-snapshot:v1:${ID}:4`,
        ],
      },
      true,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('suffix without another data read');
  });

  it('keeps a missing selected-generation grant closed', async () => {
    expect((await answer()).status).toBe(503);
  });

  it.each([`upwind:publication:private:${ID}`, `upwind:publication:v1:${ID}:${String(NOW)}`])(
    'refuses private or expired handoff tags before suffix values (%s)',
    async (tag) => {
      vi.mocked(invokeNodeHandler).mockClear();

      await expect(answer([tag])).rejects.toThrow(/publication|Publication/u);
      expect(invokeNodeHandler).not.toHaveBeenCalled();
    },
  );
});
