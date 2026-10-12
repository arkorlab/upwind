import { GATEWAY_API_VERSION } from '@stayingupwind/host/cache';
import { Hono } from 'hono';

import type { AuthorityHost } from '../authority-host.ts';
import type { CacheBindings } from '../bindings.ts';
import { createLogger, detailOf } from '../logger.ts';
import { type GatewayEnv, scopeAuthOf } from './auth.ts';
import { fail } from './respond.ts';
import { attemptRoutes } from './routes/attempts.ts';
import { dataRoutes } from './routes/data.ts';
import { entryRoutes } from './routes/entries.ts';
import { tagRoutes } from './routes/tags.ts';

/**
 * The gateway an application's Worker reaches over HTTPS: every route under a scope, every route
 * behind the scope's token. Tag checks, misses and regenerations reach the authority, wherever its
 * host placed it. KV projections use the separate unplaced read gateway when its URL is configured.
 */

const logger = createLogger({ component: 'gateway' });
const SCOPE_PREFIX = `/${GATEWAY_API_VERSION}/scopes/:scope`;

/** The gateway under what a host decided for its authority; made once, at module scope. */
export function createGatewayApp(host: AuthorityHost): Hono<GatewayEnv> {
  return new Hono<GatewayEnv>()
    .onError((error, c) => {
      logger.error('gateway request failed', {
        path: c.req.path,
        kind: error.name,
        detail: detailOf(error),
      });
      return fail(c, 'internal', 'internal error');
    })
    .notFound((c) => fail(c, 'not_found', 'no such endpoint'))
    .get(`/${GATEWAY_API_VERSION}/healthz`, (c) => c.json({ ok: true as const }))
    .use(`${SCOPE_PREFIX}/*`, scopeAuthOf(host))
    .route(SCOPE_PREFIX, attemptRoutes)
    .route(SCOPE_PREFIX, entryRoutes)
    .route(SCOPE_PREFIX, dataRoutes)
    .route(SCOPE_PREFIX, tagRoutes);
}

/** The cache Worker's own handler: the gateway, answering every request it is sent. */
export function createCacheWorker(app: Hono<GatewayEnv>): ExportedHandler<CacheBindings> {
  return {
    fetch: (request, env, ctx): Promise<Response> => Promise.resolve(app.fetch(request, env, ctx)),
  };
}
