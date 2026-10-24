import { policyFromCacheControl } from '@stayingupwind/core/cache';
import { describe, expect, it, vi } from 'vitest';

import type { CacheHost, CommitRequest, FetchLike } from '../src/cache/host.ts';
import { createCacheHost } from './function-cache-host.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

/**
 * What a deployment's Worker tells the authority of the render's view of the tags as it commits
 * (`upwind/packages/cache/src/function/cache-host.ts`): the revision the view was brought up to,
 * and what it held of each of the generation's tags where the runtime says it (`heldTagRevisions`)
 * — which is all the authority excuses an invalidation recorded after the lease on. A runtime from
 * before says only the revision, and its commit is sent with nothing of what the view held.
 */

const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://authority.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-commit-view',
};

/** A page's generation with no outputs, committed as the runtime says it: `home` held through 7. */
const COMMIT = {
  fencingToken: 1,
  observedTagRevision: 9,
  heldTagRevisions: { home: 7 },
  generation: {
    cacheTimestamp: 1,
    producedAt: 1,
    policy: policyFromCacheControl({ revalidate: 60, expire: 3600 }),
    status: 200,
    headers: {},
    tags: [{ kind: 'next-explicit', value: 'home' }],
    outputs: [],
    reason: 'expired',
  },
} as const;

/** The host a deployment's runtime is given, and the bodies of the commits it sends. */
function hostSending(): { readonly host: CacheHost; readonly sent: unknown[] } {
  const sent: unknown[] = [];
  const fetchImpl: FetchLike = async (request) => {
    sent.push(await request.json());
    return Response.json({
      ok: true,
      result: {
        kind: 'published',
        generationId: 'generation',
        seq: 1,
        revision: 9,
        condemned: null,
      },
    });
  };
  const binding = createCacheHost({ env: ENV, fetchImpl });
  if (binding === undefined) {
    throw new Error('these bindings reach no cache');
  }
  return { host: binding.host, sent };
}

describe("a commit's view of the tags", () => {
  it('carries what the runtime says its view held of each tag', async () => {
    const { host, sent } = hostSending();

    await host.commit('attempt-1', COMMIT);

    expect(sent).toMatchObject([{ observedTagRevision: 9, heldTagRevisions: { home: 7 } }]);
  });

  /**
   * A runtime from before the field says nothing of it. No build gives this host one any more, as
   * the runtime's type says, but what such a commit carries is still nothing of what the view held.
   */
  it('carries nothing of what the view held where the runtime says nothing of it', async () => {
    const { host, sent } = hostSending();
    const before: CommitRequest = { ...COMMIT };
    Reflect.deleteProperty(before, 'heldTagRevisions');

    await host.commit('attempt-1', before);

    expect(sent).toMatchObject([{ observedTagRevision: 9 }]);
    expect(sent[0]).not.toHaveProperty('heldTagRevisions');
  });
});
