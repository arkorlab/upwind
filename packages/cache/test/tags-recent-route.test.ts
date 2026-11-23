import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import {
  type InvalidateResponse,
  type TagsRecentResponse,
  tagsRecentResponseSchema,
} from '@stayingupwind/host/cache';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/**
 * The window of a scope's recent invalidations a Function's isolate catches up with
 * (`GET /tags/recent`): the newest past a revision that took effect from a moment on, as many as it
 * asked for, oldest first, at the scope's revision, and truncated where the window held more.
 */

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

/** The result of a gateway call of `at`'s, which must have succeeded. */
async function call<T>(at: Scope, method: string, path: string, body?: unknown): Promise<T> {
  const response = await exports.default.fetch(
    new Request(`https://cache.invalid/v1/scopes/${at.scopeId}${path}`, {
      method,
      headers: { authorization: `Bearer ${at.token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
  const envelope = await response.json<{ readonly ok: boolean; readonly result?: T }>();
  if (!envelope.ok || envelope.result === undefined) {
    throw new Error(`the gateway answered ${String(response.status)}`);
  }
  return envelope.result;
}

/** An invalidation of `tag` at once, as a Function records one: the revision it was recorded at. */
async function invalidate(at: Scope, tag: string): Promise<number> {
  const recorded = await call<InvalidateResponse>(at, 'POST', '/invalidations', {
    tags: [{ value: tag }],
    cause: { source: 'app-worker', api: 'updateTag' },
  });
  return recorded.revision;
}

/** The window `query` asks for, as its reader checks it. */
async function recent(at: Scope, query: string): Promise<TagsRecentResponse> {
  return tagsRecentResponseSchema.parse(await call(at, 'GET', `/tags/recent?${query}`));
}

describe('the window of a scope’s recent invalidations', () => {
  it('answers the newest it was asked for, oldest first, truncated where there were more', async () => {
    const at = await scope();
    const first = await invalidate(at, 'a');
    await invalidate(at, 'b');
    const last = await invalidate(at, 'c');

    const window = await recent(at, 'since=0&from=0&limit=2');

    expect(window.truncated).toBe(true);
    expect(window.tags.map((tag) => tag.value)).toStrictEqual(['b', 'c']);
    // Nothing else invalidates the scope meanwhile: the revision it was read at is the last (cubic).
    expect(window.revision).toBe(last);

    // Whole past where it was asked from, and never past the revision it was read at.
    const whole = await recent(at, `since=${String(first)}&from=0`);

    expect(whole.truncated).toBe(false);
    expect(whole.tags.map((tag) => tag.value)).toStrictEqual(['b', 'c']);
    expect(whole.tags.every((tag) => tag.revision <= whole.revision)).toBe(true);
  });

  it('holds nothing that took effect before the moment it is asked from', async () => {
    const at = await scope();
    await invalidate(at, 'a');

    const later = await recent(at, `since=0&from=${String(Date.now() + 60_000)}`);

    expect(later).toMatchObject({ truncated: false, tags: [] });
  });

  it('answers at least one, however few it is asked for', async () => {
    const at = await scope();
    await invalidate(at, 'a');
    await invalidate(at, 'b');

    const window = await recent(at, 'since=0&from=0&limit=0');

    expect(window.tags.map((tag) => tag.value)).toStrictEqual(['b']);
    expect(window.truncated).toBe(true);
  });
});
