import { invalidateRequestSchema, tagsGetRequestSchema } from '@stayingupwind/host/cache';
import { Hono } from 'hono';

import { announceBehind, announceMoved } from '../../announce.ts';
import { isRefusal } from '../../scope/state.ts';
import { answerScope, type GatewayEnv, refuseRetired, retiredScope } from '../auth.ts';
import { readRequest, TAGS_BODY_BYTES } from '../body.ts';
import { readTagRecords } from '../read-tags.ts';
import { ok } from '../respond.ts';

/** Invalidations, and the delta a Worker syncs its view of the tags with. */

const DEFAULT_DELTA_LIMIT = 500;
const MAX_DELTA_LIMIT = 1000;

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
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
    const limit = Math.min(
      nonNegativeInt(c.req.query('limit'), DEFAULT_DELTA_LIMIT),
      MAX_DELTA_LIMIT,
    );
    const [delta, retired] = await Promise.all([
      c.get('scope').tagsDelta(since, Math.max(limit, 1)),
      retiredScope(c),
    ]);
    return retired ? refuseRetired(c) : ok(c, delta);
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
