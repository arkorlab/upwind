import { kvScopeKey } from '@stayingupwind/core/cache';
import { TEST_CLOCK_HEADER } from '@stayingupwind/core/paas';
import type { Context, MiddlewareHandler } from 'hono';

import type { AuthorityHost } from '../authority-host.ts';
import type { CacheBindings } from '../bindings.ts';
import { parseVars, type Vars } from '../env.ts';
import { createLogger, detailOf } from '../logger.ts';
import type { CacheScope } from '../scope/cache-scope.ts';
import type { IsrWrite } from '../scope/metering.ts';
import { isRefusal } from '../scope/state.ts';
import { scopeStub } from '../scope/stub.ts';
import { answer, fail } from './respond.ts';
import { scopeRetired } from './retirement.ts';
import { tokenCheckOf } from './token.ts';

/**
 * Every scope route carries the scope's token as a bearer. The token names the scope it was made
 * for and is verified by recomputation, so a token that leaks from one deployment's isolate
 * opens nothing but that deployment's own scope. The clock a request acts at is the gateway's,
 * unless a test configuration lets the request name it.
 */

interface Variables {
  readonly scopeId: string;
  readonly scope: DurableObjectStub<CacheScope>;
  readonly now: number;
  readonly vars: Vars;
  /** What the host decided for the authority (`createGatewayApp`), the same for every request. */
  readonly host: AuthorityHost;
}

export interface GatewayEnv {
  Bindings: CacheBindings;
  Variables: Variables;
}

export type GatewayContext = Context<GatewayEnv>;

/** The marker outlives the object; a straggler asks for it at most once per refusal. */
const MARKER_CACHE_TTL_SECONDS = 30;

/**
 * The authority's answer, with one correction only the gateway can make.
 *
 * Retention deletes a retired scope's Durable Object in the end, and the deterministic id a
 * straggling deployment still holds addresses an empty one, which knows nothing, writes nothing,
 * and says `not_found`. The marker in KV is what outlives the object, and it is read here, on the
 * refusal. A change is not held back for it — the authority refuses a retired scope's changes
 * itself, and what the object holds no tables for, it answers without keeping any — save the data
 * write, which stores its bytes before the authority answers.
 */
export async function answerScope(c: GatewayContext, result: unknown): Promise<Response> {
  if (isRefusal(result) && result.code === 'not_found') {
    const marker = await c.env.CACHE_STATE.get(kvScopeKey(c.get('scopeId')), {
      cacheTtl: MARKER_CACHE_TTL_SECONDS,
    });
    if (marker !== null) {
      return refuseRetired(c);
    }
  }
  return answer(c, result);
}

export function refuseRetired(c: GatewayContext): Response {
  return fail(c, 'scope_retired', 'the scope is retired');
}

const logger = createLogger({ component: 'gateway' });

/**
 * Tell the host's meter of a write the authority made (`CacheMeter.write`), as its answer goes out.
 * The write has committed by then, and is answered as made whatever the meter does: a meter that
 * throws loses the write's line, which the gateway's log says instead. Answered as a failure, the
 * write is one its caller gives up on or makes again, and made again it is answered for what the
 * first made, with nothing to meter (`metering.ts`).
 */
export function meterWrite(c: GatewayContext, write: IsrWrite): void {
  try {
    c.get('host').meter.write(c.get('scopeId'), write);
  } catch (error) {
    logger.error('write not metered', {
      scopeId: c.get('scopeId'),
      bytes: write.bytes,
      recorded: write.recorded,
      detail: detailOf(error),
    });
  }
}

/**
 * Whether the scope is retired, for a read answered from what KV or the authority still holds:
 * started beside the read, never before it, and held per isolate (`scopeRetired`).
 */
export function retiredScope(c: GatewayContext): Promise<boolean> {
  return scopeRetired(c.env.CACHE_STATE, c.get('scopeId'));
}

function clockOf(c: GatewayContext, vars: Vars): number {
  if (vars.ARKOR_TEST_HOOKS) {
    const claimed = Number(c.req.header(TEST_CLOCK_HEADER));
    if (Number.isSafeInteger(claimed) && claimed > 0) {
      return claimed;
    }
  }
  return Date.now();
}

/** The token check every scope route is behind, under what the host decided (`AuthorityHost`). */
export function scopeAuthOf(host: AuthorityHost): MiddlewareHandler<GatewayEnv> {
  const authorizedScope = tokenCheckOf(host.naming);
  return async (c, next): Promise<Response | undefined> => {
    const scopeId = c.req.param('scope') ?? '';
    const vars = parseVars(c.env);
    if (!(await authorizedScope(c.req.raw, scopeId, vars))) {
      return fail(c, 'unauthorized', 'the token does not open this scope');
    }
    c.set('scopeId', scopeId);
    c.set('scope', scopeStub(c.env, scopeId, host.locationHint));
    c.set('now', clockOf(c, vars));
    c.set('vars', vars);
    c.set('host', host);
    await next();
    return undefined;
  };
}
