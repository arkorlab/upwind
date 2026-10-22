import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { MAX_TAGS_PER_CALL } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type {
  DataGetResponse,
  DataSetResponse,
  InvalidateResponse,
} from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { cacheHostFor } from '../src/function/cache-host.ts';
import { IN_FORCE_WITHIN_MS, inForceMoment } from '../src/scope/invalidations.ts';
import { scopeStub } from '../src/scope/stub.ts';

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

/** A fetch's value of `key` under `tags`, made at `timestamp`, written to the scope. */
function write(
  at: Scope,
  key: string,
  timestamp: number,
  tags: readonly string[] = ['article'],
): Promise<DataSetResponse> {
  return call(at, 'PUT', '/data', {
    key,
    valueBase64: btoa('fetched'),
    entry: {
      kind: 'data:fetch',
      tags,
      stale: 300,
      timestamp,
      expire: 900,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
  });
}

/** What a read of the fetch's value of `key` is answered with. */
function readOf(at: Scope, key: string): Promise<DataGetResponse> {
  return call(at, 'POST', '/data/get', { key, kind: 'data:fetch' });
}

/** A fetch of `article` made at `timestamp`, written once the invalidation is in, and read back. */
async function written(at: Scope, timestamp: number): Promise<DataGetResponse> {
  const key = `fetched-at-${String(timestamp)}`;
  await write(at, key, timestamp);
  return readOf(at, key);
}

/**
 * What an immediate invalidation left on the entry, as the scope's object keeps it: the revision of
 * the one that tombstoned it, or none.
 */
function tombstoneOf(at: Scope, entryId: string): Promise<number | null> {
  return runInDurableObject(scopeStub(env, at.scopeId), (_instance, state) => {
    const [row] = state.storage.sql
      .exec<{ tombstone_revision: number | null }>(
        `SELECT tombstone_revision FROM entries WHERE entry_id = ?`,
        entryId,
      )
      .toArray();
    return row?.tombstone_revision ?? null;
  });
}

/** The Function's cache host, reaching the scope's gateway through `send`. */
function hostOf(at: Scope, send: FetchLike) {
  const binding = cacheHostFor(NAMING)({
    env: {
      ARKOR_CACHE_GATEWAY_URL: 'https://cache.invalid',
      ARKOR_CACHE_TOKEN: at.token,
      NEXT_DEPLOYMENT_ID: at.scopeId,
    },
    fetchImpl: send,
  });
  if (binding === undefined) {
    throw new Error('the host reached no cache');
  }
  return binding.host;
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

/**
 * A value of the data cache that stands current at the authority before the invalidation does: a
 * render's write, made after the invalidation was put in force in the Worker that asked, which the
 * authority received first — say between two chunks of a large invalidation. Made after the moment,
 * it is kept, as the same write arriving after the invalidation would be; made at it, condemned.
 */
describe('a value written before the invalidation it was made after', () => {
  it('is kept, made after the moment, and is none of what the invalidation reached', async () => {
    const at = await scope();
    const moment = Date.now() - 400;
    const { entryId } = await write(at, 'made-after', moment + 1);

    const recorded = await invalidate(at, moment);
    const read = await readOf(at, 'made-after');

    expect(read.invalidation).toBeUndefined();
    expect(recorded.affectedEntryIds).not.toContain(entryId);
    await expect(tombstoneOf(at, entryId)).resolves.toBeNull();
  });

  it('is condemned, made at the moment, and is among what the invalidation reached', async () => {
    const at = await scope();
    const moment = Date.now() - 400;
    const { entryId } = await write(at, 'made-at', moment);

    const recorded = await invalidate(at, moment);
    const read = await readOf(at, 'made-at');

    expect(read.invalidation).toStrictEqual({
      revision: recorded.revision,
      staleAt: moment,
      hardExpireAt: moment,
    });
    expect(recorded.affectedEntryIds).toContain(entryId);
    await expect(tombstoneOf(at, entryId)).resolves.toBe(recorded.revision);
  });

  it('is kept, written between two chunks of a large invalidation and made after its moment', async () => {
    const at = await scope();
    const moment = Date.now() - 400;
    // The second chunk's only tag: the value under it is written once the first has been recorded.
    const late = `tag-${String(MAX_TAGS_PER_CALL)}`;
    const tags = Array.from(
      { length: MAX_TAGS_PER_CALL + 1 },
      (_, index) => `tag-${String(index)}`,
    );
    const writes: Promise<DataSetResponse>[] = [];
    const host = hostOf(at, async (request) => {
      if (writes.length === 0 && (await request.clone().text()).includes(`"${late}"`)) {
        writes.push(write(at, 'between-chunks', moment + 1, [late]));
        await writes[0];
      }
      return exports.default.fetch(request);
    });

    await host.invalidate({ tags, api: 'updateTag', inForceAt: moment });

    expect(writes).toHaveLength(1);
    await expect(readOf(at, 'between-chunks')).resolves.not.toHaveProperty('invalidation');
  });
});
