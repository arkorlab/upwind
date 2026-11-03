import {
  invalidateRequestSchema,
  MAX_DELTA_PAGE_TAGS,
  tagsGetRequestSchema,
} from '@stayingupwind/host/cache';
import { Hono } from 'hono';

import { announceBehind, announceMoved } from '../../announce.ts';
import { isRefusal } from '../../scope/state.ts';
import { answerScope, type GatewayEnv, refuseRetired, retiredScope } from '../auth.ts';
import { readRequest, TAGS_BODY_BYTES } from '../body.ts';
import { readTagRecords } from '../read-tags.ts';
import { ok } from '../respond.ts';

/**
 * Invalidations, the delta a Worker syncs its view of the tags with, and the window of recent ones
 * it catches up with first.
 */

const DEFAULT_DELTA_LIMIT = 500;

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The `limit` a read of the tags asked for, no more than a page may hold (`MAX_DELTA_PAGE_TAGS`). */
function limitOf(value: string | undefined): number {
  return Math.max(Math.min(nonNegativeInt(value, DEFAULT_DELTA_LIMIT), MAX_DELTA_PAGE_TAGS), 1);
}

export const tagRoutes = new Hono<GatewayEnv>()
  // Not `zValidator`: it parses whatever arrives before anything has measured it.
  .post('/tags/get', async (c) => {
    const request = await readRequest(c, tagsGetRequestSchema, TAGS_BODY_BYTES);
    return request instanceof Response
      ? request
      : ok(c, await readTagRecords(c.env.CACHE_STATE, c.get('scopeId'), request.tags));
  })
  // Where the scope's tags stand, and no more: asked again and again, by every data center's copy
  // of it (`function/scope-beacon.ts`), so nothing of the delta itself is read.
  .get('/tags/revision', async (c) => {
    const [delta, retired] = await Promise.all([
      c.get('scope').tagsDelta(Number.MAX_SAFE_INTEGER, 1),
      retiredScope(c),
    ]);
    return retired ? refuseRetired(c) : ok(c, delta.latest ?? { revision: 0, invalidatedAt: null });
  })
  .get('/tags/delta', async (c) => {
    const since = nonNegativeInt(c.req.query('since'), 0);
    // No more than a page may hold (`MAX_DELTA_PAGE_TAGS`), which its reader holds it to.
    const limit = limitOf(c.req.query('limit'));
    const [delta, retired] = await Promise.all([
      c.get('scope').tagsDelta(since, limit),
      retiredScope(c),
    ]);
    return retired ? refuseRetired(c) : ok(c, delta);
  })
  // The newest invalidations past `since` that took effect from `from` on (`recentDelta`,
  // `tagsRecentResponseSchema`): what an isolate behind its scope may find its reads behind on, in
  // one round trip however long the scope's history is. Its own route, never the delta's: cut at its
  // oldest end where it holds more than its limit, it is no page a reader of the delta may stand at.
  // A `from` left out asks from the beginning, which leaves out nothing.
  .get('/tags/recent', async (c) => {
    const since = nonNegativeInt(c.req.query('since'), 0);
    const from = nonNegativeInt(c.req.query('from'), 0);
    const limit = limitOf(c.req.query('limit'));
    const [recent, retired] = await Promise.all([
      c.get('scope').tagsDelta(since, limit, from),
      retiredScope(c),
    ]);
    return retired
      ? refuseRetired(c)
      : ok(c, { revision: recent.revision, truncated: recent.truncated, tags: recent.tags });
  })
  .post('/invalidations', async (c) => {
    const request = await readRequest(c, invalidateRequestSchema, TAGS_BODY_BYTES);
    if (request instanceof Response) {
      return request;
    }
    const recorded = await c.get('scope').invalidate(request, c.get('now'));
    if (!isRefusal(recorded)) {
      const waitUntil = (work: Promise<void>): void => {
        c.executionCtx.waitUntil(work);
      };
      // An invalidation sent a chunk at a time waits for the host's telling on its last chunk only.
      if (request.more === true) {
        announceBehind(c.get('host'), c.get('scopeId'), c.env, waitUntil);
      } else {
        await announceMoved(c.get('host'), c.get('scopeId'), c.env, waitUntil);
      }
    }
    return answerScope(c, recorded);
  });
