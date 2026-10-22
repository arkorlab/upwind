import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { MAX_TAGS_PER_CALL } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type {
  DataGetResponse,
  DataSetResponse,
  InvalidateRequest,
  InvalidateResponse,
} from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { cacheHostFor } from '../src/function/cache-host.ts';
import { IN_FORCE_WITHIN_MS, inForceMoment } from '../src/scope/invalidations.ts';
import { isRefusal } from '../src/scope/state.ts';
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

/** What an invalidation of `article`, said to have been put in force at `inForceAt`, asks. */
function invalidationOf(inForceAt: unknown): InvalidateRequest {
  return {
    tags: [{ value: 'article' }],
    cause: { source: 'app-worker', api: 'updateTag' },
    inForceAt,
  };
}

/**
 * An invalidation of `article` through the gateway, said to have been put in force at `inForceAt`:
 * recorded by the gateway's own clock, which moves on while a test runs, so what it records is known
 * only within the clock's readings around the call.
 */
function invalidate(at: Scope, inForceAt: unknown): Promise<InvalidateResponse> {
  return call(at, 'POST', '/invalidations', invalidationOf(inForceAt));
}

/**
 * `request`, asked of the scope's object itself at the authority's clock `NOW`: the clock the gateway
 * would hand it (`CacheScope.invalidate`), which the object records the invalidation by and reads no
 * other for — so what it records does not move with the time the test takes. `NOW` lies months from
 * the clock the test runs at: an object that read a clock of its own would record another moment.
 */
async function recordedAtNow(at: Scope, request: InvalidateRequest): Promise<InvalidateResponse> {
  const recorded = await scopeStub(env, at.scopeId).invalidate(request, NOW);
  if (isRefusal(recorded)) {
    throw new Error(`the scope refused the invalidation: ${recorded.code}`);
  }
  return recorded;
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

/** The Function's cache host, reaching the scope's authority through `send`. */
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
 * Asked of the scope's object at the authority's clock `NOW` (`recordedAtNow`): the moment it records is
 * the one it is told, exactly, however long the test takes.
 */
describe('an invalidation the authority is told the moment of', () => {
  const moment = NOW - 400;

  it('is recorded at that moment, and keeps what was made after it', async () => {
    const at = await scope();

    const recorded = await recordedAtNow(at, invalidationOf(moment));
    const read = await written(at, moment + 1);

    expect(recorded.invalidations[0]).toMatchObject({ staleAt: moment, hardExpireAt: moment });
    expect(read.invalidation).toBeUndefined();
  });

  it('condemns what was made at that moment itself, as made before it', async () => {
    const at = await scope();

    const recorded = await recordedAtNow(at, invalidationOf(moment));
    const read = await written(at, moment);

    expect(read.invalidation).toStrictEqual({
      revision: recorded.revision,
      staleAt: moment,
      hardExpireAt: moment,
    });
  });
});

/**
 * Where a moment the gateway recorded stands, as the clock read `before` and `after` the call: at
 * `moment`, the one it was told; at the edge of its window, where the call came later than the window
 * reaches back to that moment; or elsewhere — at the gateway's clock, between `before` and `after`,
 * for a call whose moment was dropped.
 */
function whereRecorded(staleAt: number, moment: number, before: number, after: number): string {
  if (staleAt === moment) {
    return 'the moment';
  }
  const edge = staleAt >= before - IN_FORCE_WITHIN_MS && staleAt <= after - IN_FORCE_WITHIN_MS;
  return edge ? "the window's edge" : `elsewhere (${String(staleAt)})`;
}

/**
 * Through the gateway, by the authority's own clock, which moves on while the test runs: what it
 * records is asserted only as it holds whatever time the call took, from the clock read before and
 * after it.
 */
describe('an invalidation the gateway is told the moment of', () => {
  it('records it at that moment, or at the edge of its window, never at its clock', async () => {
    const at = await scope();
    const before = Date.now();
    const moment = before - 400;

    const recorded = await invalidate(at, moment);
    const after = Date.now();

    const where = whereRecorded(recorded.invalidations[0]?.staleAt ?? NaN, moment, before, after);

    expect(['the moment', "the window's edge"]).toContain(where);
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
  const moment = NOW - 400;

  it('is kept, made after the moment, and is none of what the invalidation reached', async () => {
    const at = await scope();
    const { entryId } = await write(at, 'made-after', moment + 1);

    const recorded = await recordedAtNow(at, invalidationOf(moment));
    const read = await readOf(at, 'made-after');

    expect(read.invalidation).toBeUndefined();
    expect(recorded.affectedEntryIds).not.toContain(entryId);
    await expect(tombstoneOf(at, entryId)).resolves.toBeNull();
  });

  it('is condemned, made at the moment, and is among what the invalidation reached', async () => {
    const at = await scope();
    const { entryId } = await write(at, 'made-at', moment);

    const recorded = await recordedAtNow(at, invalidationOf(moment));
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
    // The second chunk's only tag: the value under it is written once the first has been recorded.
    const late = `tag-${String(MAX_TAGS_PER_CALL)}`;
    const tags = Array.from(
      { length: MAX_TAGS_PER_CALL + 1 },
      (_, index) => `tag-${String(index)}`,
    );
    const writes: Promise<DataSetResponse>[] = [];
    // Each chunk the Function's host sends is asked of the scope's object at the authority's clock.
    const host = hostOf(at, async (request) => {
      const asked = await request.json<InvalidateRequest>();
      if (writes.length === 0 && asked.tags.some(({ value }) => value === late)) {
        writes.push(write(at, 'between-chunks', moment + 1, [late]));
        await writes[0];
      }
      return Response.json({ ok: true, result: await recordedAtNow(at, asked) });
    });

    await host.invalidate({ tags, api: 'updateTag', inForceAt: moment });

    expect(writes).toHaveLength(1);
    await expect(readOf(at, 'between-chunks')).resolves.not.toHaveProperty('invalidation');
  });
});
