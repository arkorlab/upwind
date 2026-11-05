import { deriveEntry } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type DataGetResponse,
  dataGetRequestSchema,
  dataSetRequestSchema,
  invalidateRequestSchema,
} from '../../host/src/cache/gateway-contract.ts';
import { withClock } from '../src/cache/clock.ts';
import { withRequestContext } from '../src/cache/context.ts';
import { configureCacheHandlers, useCacheHandler } from '../src/cache/handlers.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { requestKeeping } from './request-context.ts';

const NOW = 1_800_000_000_000;
const FRACTION = 0.25;
const SCOPE = 'timestamp-test';
const BUSINESS = 'business';
const UNRELATED = 'unrelated';
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const HTTP_NOT_FOUND = 404;

function result(value: unknown): Response {
  return Response.json({ ok: true, result: value });
}

/** A gateway retaining accepted writes under the existing integer-millisecond wire contract. */
function harness() {
  const stored = new Map<string, DataGetResponse>();
  const timestamps: number[] = [];
  let revision = 0;
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => NOW,
    fetchImpl: async (request) => {
      const { pathname } = new URL(request.url);
      if (request.method === 'PUT' && pathname.endsWith('/data')) {
        const write = dataSetRequestSchema.parse(await request.json());
        const { entryId } = await deriveEntry(SCOPE, {
          kind: write.entry.kind,
          key: write.key,
          handler: write.entry.handler,
        });
        revision += 1;
        const generationId = `generation-${revision}`;
        stored.set(write.key, {
          entryId,
          generationId,
          dependencyRevision: revision,
          entry: write.entry,
          value: { kind: 'inline', base64: write.valueBase64 },
        });
        timestamps.push(write.entry.timestamp);
        return result({ entryId, generationId, revision });
      }
      if (pathname.endsWith('/data/get') || pathname.endsWith('/data/current')) {
        const read = dataGetRequestSchema.parse(await request.json());
        const value = stored.get(read.key);
        return value === undefined ? new Response(null, { status: HTTP_NOT_FOUND }) : result(value);
      }
      if (pathname.endsWith('/tags/get')) return result({ tags: [] });
      if (pathname.endsWith('/invalidations')) {
        const asked = invalidateRequestSchema.parse(await request.json());
        const at = typeof asked.inForceAt === 'number' ? asked.inForceAt : NOW;
        revision += 1;
        return result({
          revision,
          affectedEntryIds: [],
          invalidations: asked.tags.map(({ value }) => {
            return {
              invalidationId: `invalidation-${revision}`,
              tagId: `tag-${value}`,
              value,
              staleAt: at,
              hardExpireAt: at,
              meaning: 'immediate',
            };
          }),
        });
      }
      throw new Error('unexpected timestamp-test request');
    },
  });
  if (runtime === undefined) throw new Error('timestamp-test runtime is missing');
  const log = vi.spyOn(runtime, 'log').mockImplementation(vi.fn());
  configureCacheHandlers(runtime);
  const handler = useCacheHandler('default');
  return {
    handler,
    log,
    timestamps,
    request: async (work: () => Promise<void>): Promise<void> => {
      const kept: Promise<unknown>[] = [];
      await withClock(NOW, () => withRequestContext(requestKeeping(runtime, kept), work));
      await Promise.all(kept);
    },
  };
}

/** Next.js's value timestamp may contain a fraction from timeOrigin + performance.now(). */
function writeCached(key: string, timestamp: number, value = key): Promise<void> {
  return useCacheHandler('default').set(
    key,
    Promise.resolve({
      value: new Blob([value]).stream(),
      tags: [key],
      stale: 300,
      timestamp,
      expire: 3600,
      revalidate: 60,
    }),
  );
}

async function readCached(key: string): Promise<{ timestamp: number; value: string } | undefined> {
  const entry = await useCacheHandler('default').get(key, []);
  if (entry === undefined) return undefined;
  return { timestamp: entry.timestamp, value: await new Response(entry.value).text() };
}

describe('fractional Next.js use-cache timestamps', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  it('persists integer milliseconds and retains an unrelated tagged value after a refresh', async () => {
    const h = harness();
    await h.request(async () => {
      await Promise.all([
        writeCached(BUSINESS, NOW + FRACTION),
        writeCached(UNRELATED, NOW + FRACTION),
      ]);
    });

    expect(h.timestamps).toStrictEqual([NOW, NOW]);

    await h.request(async () => {
      await h.handler.updateTags([BUSINESS]);

      await expect(readCached(BUSINESS)).resolves.toBeUndefined();

      await writeCached(BUSINESS, NOW + FRACTION, 'refreshed');

      await expect(readCached(BUSINESS)).resolves.toStrictEqual({
        timestamp: NOW + 1,
        value: 'refreshed',
      });
      await expect(readCached(UNRELATED)).resolves.toStrictEqual({
        timestamp: NOW,
        value: UNRELATED,
      });
    });

    expect(h.log).not.toHaveBeenCalled();
  });

  it('lets a later invalidation in the same millisecond reach the locally retained value', async () => {
    const h = harness();
    await h.request(async () => {
      await writeCached(BUSINESS, NOW + FRACTION);

      await expect(readCached(BUSINESS)).resolves.toStrictEqual({
        timestamp: NOW,
        value: BUSINESS,
      });

      await h.handler.updateTags([BUSINESS]);

      await expect(readCached(BUSINESS)).resolves.toBeUndefined();
    });

    expect(h.log).not.toHaveBeenCalled();
  });

  it('keeps its own mark floor and lets the next mark invalidate that same-millisecond write', async () => {
    const h = harness();
    await h.request(async () => {
      await h.handler.updateTags([BUSINESS]);
      await h.handler.get(BUSINESS, []);
      await writeCached(BUSINESS, NOW + 1 + FRACTION);

      await expect(readCached(BUSINESS)).resolves.toStrictEqual({
        timestamp: NOW + 1,
        value: BUSINESS,
      });

      await h.handler.updateTags([BUSINESS]);

      await expect(readCached(BUSINESS)).resolves.toBeUndefined();
    });

    expect(h.timestamps).toStrictEqual([NOW + 1]);
    expect(h.log).not.toHaveBeenCalled();
  });
});
