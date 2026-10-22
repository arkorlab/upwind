import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { MAX_TAGS_PER_CALL } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { DataGetResponse, InvalidateResponse } from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { cacheHostFor } from '../src/function/cache-host.ts';
import { IN_FORCE_WITHIN_MS, inForceMoment } from '../src/scope/invalidations.ts';

/**
 * The moment an invalidation takes effect at: when the Worker that asked put it in force
 * (`InvalidateRequest.inForceAt`), within the window the authority allows, or the authority's own
 * clock where the Worker said none it can read. A runtime puts an invalidation in force in its isolate
 * before it calls, renders on, and stamps what it computes after the invalidation later than it; what
 * it wrote before the authority had the call is not condemned by the invalidation it followed.
 */

const NOW = 1_800_000_000_000;

describe('the moment an invalidation takes effect at', () => {
  it('is the authority’s clock where the Worker said none', () => {
    expect(inForceMoment({}, NOW)).toBe(NOW);
  });

  it('is the Worker’s moment within the window', () => {
    expect(inForceMoment({ inForceAt: NOW - 400 }, NOW)).toBe(NOW - 400);
    expect(inForceMoment({ inForceAt: NOW - IN_FORCE_WITHIN_MS }, NOW)).toBe(
      NOW - IN_FORCE_WITHIN_MS,
    );
  });

  it('reaches no further back than the window, nor past the authority’s clock', () => {
    expect(inForceMoment({ inForceAt: 0 }, NOW)).toBe(NOW - IN_FORCE_WITHIN_MS);
    expect(inForceMoment({ inForceAt: NOW + 1 }, NOW)).toBe(NOW);
  });

  it('takes a fraction of a millisecond to the next whole one, which reaches more', () => {
    expect(inForceMoment({ inForceAt: NOW - 400.25 }, NOW)).toBe(NOW - 400);
  });

  it.each([NaN, Infinity, '1800000000000', null])(
    'is the authority’s clock for a moment it cannot read: %s',
    (inForceAt) => {
      expect(inForceMoment({ inForceAt }, NOW)).toBe(NOW);
    },
  );
});

const NAMING = { copyCache: 'in-force-copies', copyKeyOrigin: 'https://copies.example' };

/** The Function's cache host over a transport that records each invalidation it is asked to send. */
function functionHost() {
  const sent: Record<string, unknown>[] = [];
  const send = vi.fn<FetchLike>(async (request) => {
    const body = await request.json<{ readonly tags: readonly { value: string }[] }>();
    sent.push(body);
    const answer: InvalidateResponse = {
      revision: sent.length + 1,
      affectedEntryIds: [],
      invalidations: body.tags.map(({ value }, index) => {
        return {
          invalidationId: `inv_${String(sent.length)}_${String(index)}`,
          tagId: `tag_${String(index)}`,
          value,
          staleAt: NOW,
          hardExpireAt: NOW,
          meaning: 'immediate',
        };
      }),
    };
    return Response.json({ ok: true, result: answer });
  });
  const binding = cacheHostFor(NAMING)({
    env: {
      ARKOR_CACHE_GATEWAY_URL: 'https://authority.example',
      ARKOR_CACHE_TOKEN: 'scope-token',
      NEXT_DEPLOYMENT_ID: 'scope_in_force',
    },
    fetchImpl: send,
  });
  if (binding === undefined) {
    throw new Error('the host reached no cache');
  }
  return { host: binding.host, sent };
}

describe('the Function’s cache host', () => {
  it('asks the authority with the moment the runtime put the invalidation in force, each chunk', async () => {
    const { host, sent } = functionHost();
    const tags = Array.from(
      { length: MAX_TAGS_PER_CALL + 1 },
      (_, index) => `tag-${String(index)}`,
    );

    await host.invalidate({ tags, api: 'updateTag', inForceAt: NOW });

    expect(sent.map((body) => body['inForceAt'])).toStrictEqual([NOW, NOW]);
  });

  it('asks with none where the runtime said none', async () => {
    const { host, sent } = functionHost();

    await host.invalidate({ tags: ['posts'], api: 'updateTag' });

    expect(sent[0]).not.toHaveProperty('inForceAt');
  });
});

interface Scope {
  readonly scopeId: string;
  readonly token: string;
}

/** A scope of its own, seeded through the cache's control entrypoint. */
async function scope(): Promise<Scope> {
  const scopeId = createId(DEPLOYMENT_ID_PREFIX);
  const seeded = await exports.CacheControl.seedScope({
    scope: {
      scopeId,
      organizationId: 'org_site',
      projectId: 'site',
      environmentId: 'production',
      deploymentId: scopeId,
      keySchemaVersion: 1,
      buildId: 'build-site',
    },
  });
  if (seeded.kind === 'conflict') {
    throw new Error('the scope was not seeded');
  }
  return { scopeId, token: seeded.token };
}

/** The result of a gateway call of `scope`'s, which must have succeeded. */
async function call<T>(at: Scope, method: string, path: string, body: unknown): Promise<T> {
  const response = await exports.default.fetch(
    new Request(`https://cache.invalid/v1/scopes/${at.scopeId}${path}`, {
      method,
      headers: { authorization: `Bearer ${at.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const envelope = await response.json<{ readonly ok: boolean; readonly result?: T }>();
  if (!envelope.ok || envelope.result === undefined) {
    throw new Error(`the gateway answered ${String(response.status)}`);
  }
  return envelope.result;
}

/** An invalidation of `article`, said to have been put in force at `inForceAt`. */
function invalidate(at: Scope, inForceAt: unknown): Promise<InvalidateResponse> {
  return call(at, 'POST', '/invalidations', {
    tags: [{ value: 'article' }],
    cause: { source: 'app-worker', api: 'updateTag' },
    inForceAt,
  });
}

/** A fetch of `article` made at `timestamp`, written once the invalidation is in, and read back. */
async function written(at: Scope, timestamp: number): Promise<DataGetResponse> {
  const key = `fetched-at-${String(timestamp)}`;
  await call(at, 'PUT', '/data', {
    key,
    valueBase64: btoa('fetched'),
    entry: {
      kind: 'data:fetch',
      tags: ['article'],
      stale: 300,
      timestamp,
      expire: 900,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
  });
  return call(at, 'POST', '/data/get', { key, kind: 'data:fetch' });
}

/**
 * Through the gateway and the scope's object, by the authority's own clock: read before and after
 * each call, as no test clock is given here.
 */
describe('an invalidation the authority is told the moment of', () => {
  it('is recorded at that moment, and keeps what was made after it', async () => {
    const at = await scope();
    const moment = Date.now() - 400;

    const recorded = await invalidate(at, moment);
    const read = await written(at, moment + 1);

    expect(recorded.invalidations[0]).toMatchObject({ staleAt: moment, hardExpireAt: moment });
    expect(read.invalidation).toBeUndefined();
  });

  it('condemns what was made at that moment itself, as made before it', async () => {
    const at = await scope();
    const moment = Date.now() - 400;

    const recorded = await invalidate(at, moment);
    const read = await written(at, moment);

    expect(read.invalidation).toStrictEqual({
      revision: recorded.revision,
      staleAt: moment,
      hardExpireAt: moment,
    });
  });

  it.each([
    ['earlier than the window reaches', () => 0, -IN_FORCE_WITHIN_MS],
    ['later than the authority’s clock', () => Date.now() + 60_000, 0],
    ['that is no number', () => 'soon', 0],
  ])('takes a moment %s as one within the window', async (_said, inForceAt, offset) => {
    const at = await scope();
    const before = Date.now();

    const recorded = await invalidate(at, inForceAt());
    const after = Date.now();

    const staleAt = recorded.invalidations[0]?.staleAt ?? NaN;

    expect(staleAt).toBeGreaterThanOrEqual(before + offset);
    expect(staleAt).toBeLessThanOrEqual(after + offset);
  });
});
