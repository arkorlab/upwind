import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import {
  type BoundedBody,
  isDeadlineError,
  readBoundedBody,
  releaseStream,
  withDeadline,
} from '@stayingupwind/core/util';
import type {
  AssetBackendId,
  AssetDeliveryStrategy,
  AssetHandleResult,
  AssetKeepOutcome,
} from '@stayingupwind/host/delivery';

import { dispatchesOf, fetchUpstream } from '../handlers/upstream.ts';
import { logWarn } from '../observability/logger.ts';
import {
  assetDebug,
  assetHeaders,
  assetUpstreamRequest,
  notModifiedIfMatches,
  shapeAssetResponse,
  storableAssetCacheControl,
} from './asset-upstream.ts';
import type { EdgeContext } from './context.ts';

const STRATEGY_ID = 'cache-api-readthrough';

/** Percent-encoded dots still normalize; these spellings cannot be URI-encoded input. */
function cacheSegment(value: string): string {
  if (value === '.' || value === '..') {
    return value === '.' ? '%2E_' : '%2E%2E_';
  }
  try {
    return encodeURIComponent(value);
  } catch {
    // JSON preserves lone surrogates. A literal tilde never encodes to this prefix.
    return `%7E${encodeURIComponent(JSON.stringify(value).slice(1, -1))}`;
  }
}

/**
 * Per-data-center Cache API read-through keyed by the asset's URL (including `?dpl`); the
 * upstream is the deployment's own Worker.
 */
/**
 * The key an admitted asset is held under.
 *
 * The forwarded hostname is part of it. A project may answer at more than one hostname, and
 * `assetUpstreamRequest` forwards whichever one the visitor asked at — so an application with
 * host-aware middleware in front of `/_next/static/` can answer them differently. Keyed by the
 * origin URL alone, whichever hostname missed first would fill the entry and the others would be
 * served those bytes without the origin ever being asked.
 *
 * The cost is a miss the first time each hostname asks for each asset. That is the price of the
 * entry being about one representation rather than whichever arrived first.
 *
 * And the project, ahead of the hostname: a hostname is not a project's for good. A host may give a
 * hostname one project let go of to another — and an entry outlives the move, for as long as the
 * policy keeps it. Keyed by the hostname alone, the new project would be served the old one's
 * asset, its script run on the new project's origin, without its own Worker ever being asked.
 */
export function admittedAssetCacheKey(
  originUrl: URL,
  previewHost: string,
  projectId: string,
): string {
  const key = new URL(originUrl.href);
  // Leading path segments, not query parameters. The query is the application's and reaches here
  // from the client — only `?dpl` does today, because `isImmutableAssetPath` admits no other key —
  // so writing a parameter of ours into it would mean two of their URLs, which the origin answers
  // separately, sharing one entry the day that rule widens. Each segment is encoded, so neither the
  // project nor the hostname can carry a `/` of its own: the first two segments are exactly the two
  // of them, and nothing else can look like them.
  key.pathname = `/${cacheSegment(projectId)}/${cacheSegment(previewHost)}${key.pathname}`;
  return key.href;
}

export async function readThrough(
  request: Request,
  originUrl: URL,
  ctx: EdgeContext,
  strategyId: AssetBackendId,
): Promise<AssetHandleResult> {
  const cacheKey = new Request(
    admittedAssetCacheKey(originUrl, ctx.forwarding.previewHost, ctx.projectId),
  );
  // Shadow validation reads the candidate's own Worker and nothing in front of it, as a shell's read
  // does (`loadShell`): an entry live traffic kept under the active deployment would answer under
  // the candidate's policy without the candidate being asked at all.
  const cached = ctx.validated ? undefined : await lookupCache(ctx.host.names.assetCache, cacheKey);
  if (cached !== undefined) {
    // Belt and braces on the way out of the cache: an entry an older Worker stored can still
    // carry the origin's own directives, which outrank the lifetime set on the next line, and the
    // edge's own headers (`assetHeaders`).
    const headers = assetHeaders(cached.headers);
    headers.set('cache-control', storableAssetCacheControl(ctx));
    headers.set(EDGE_DEBUG_HEADER, assetDebug(ctx, strategyId, 'hit=1'));
    const notModified = notModifiedIfMatches(request, headers);
    if (notModified !== undefined) {
      releaseStream(cached.body, 'not modified');
      return { response: notModified, admitted: true, hit: true, subrequests: 0 };
    }
    const response = new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
    return { response, admitted: true, hit: true, subrequests: 0 };
  }
  const originResponse = await fetchUpstream(
    ctx.runtime,
    ctx.app,
    assetUpstreamRequest(request, originUrl, ctx),
  );
  // Shadow validation must not populate a cache that production traffic reads: the key names the
  // asset and the host it was asked at, never the policy, so a candidate's response would be
  // served under the active one.
  const shaped = shapeAssetResponse(request, originResponse, ctx, {
    strategyId,
    keep: ctx.validated ? undefined : (body, response) => keepAsset(ctx, cacheKey, body, response),
  });
  return {
    response: shaped.response,
    admitted: shaped.admitted,
    rejection: shaped.rejection,
    hit: false,
    subrequests: dispatchesOf(originResponse),
    kept: shaped.kept,
  };
}

export const cacheApiReadthroughAssetStrategy: AssetDeliveryStrategy<
  EdgeContext,
  typeof STRATEGY_ID
> = {
  id: STRATEGY_ID,
  handle: (request, originUrl, ctx) => readThrough(request, originUrl, ctx, STRATEGY_ID),
};

/**
 * How long the copy may go without a chunk before it is given up.
 *
 * Off the client's path entirely: the client is reading the other half of the same body and is
 * never cut off by this. Silence rather than the whole body, because this reads at the origin's
 * pace and a large asset is not an origin that stopped sending — the two differ only in how long
 * the quiet lasts.
 */
const KEEP_STALL_MS = 20_000;
/**
 * How long the copy may take in total.
 *
 * The runtime gives work behind a response
 * [thirty seconds](https://developers.cloudflare.com/workers/runtime-apis/context/) from the
 * moment the response is sent or the client leaves, and shares that between every `waitUntil` on
 * the request — including the metric written once this settles. A copy still running when it ends
 * is stopped where it stands and reports nothing at all, which is the one outcome worse than not
 * keeping the asset: the request disappears from the metrics too. This gives up first, with time
 * left to say so. A large asset behind a slow client is the case that reaches it.
 */
const KEEP_BUDGET_MS = 25_000;
/**
 * What the write after the read may take, out of the same window.
 *
 * A read that spends its whole budget leaves the `put` a few seconds, and a `put` the runtime
 * stops mid-flight is a copy nobody stored and a metric nobody wrote — the disappearance the
 * budget above exists to prevent, one step further along. Twenty-eight seconds between them, so
 * the outcome still has time to be recorded.
 */
const STORE_BUDGET_MS = 3000;

/**
 * Read the copy to the end and store it, and say what became of it.
 *
 * Held with `waitUntil` here rather than by the caller, so the read is allowed to outlive the
 * response it was taken from — including a client that left in the middle, which is when an
 * unstored asset would otherwise stay uncached for good.
 */
function keepAsset(
  ctx: EdgeContext,
  cacheKey: Request,
  body: ReadableStream<Uint8Array>,
  response: Response,
): Promise<AssetKeepOutcome> {
  const kept = captureAndStore(ctx, cacheKey, body, response);
  ctx.ctx.waitUntil(kept);
  return kept;
}

/**
 * Which budget ran out, or neither. The stall can only fire while there is total budget left, so
 * having waited the whole budget is what says the read was still arriving when time ran out.
 */
function keepFailure(error: unknown, elapsedMs: number): AssetKeepOutcome {
  if (!isDeadlineError(error)) {
    return 'interrupted';
  }
  return elapsedMs >= KEEP_BUDGET_MS ? 'out-of-time' : 'stalled';
}

async function captureAndStore(
  ctx: EdgeContext,
  cacheKey: Request,
  body: ReadableStream<Uint8Array>,
  response: Response,
): Promise<AssetKeepOutcome> {
  const startedAt = ctx.runtime.now();
  let captured: BoundedBody;
  try {
    captured = await readBoundedBody(body, {
      limit: ctx.assetMaxBytes,
      stallMs: KEEP_STALL_MS,
      budgetMs: KEEP_BUDGET_MS,
    });
  } catch (error) {
    const outcome = keepFailure(error, ctx.runtime.now() - startedAt);
    logWarn('asset copy given up', { outcome, detail: errorDetail(error) });
    return outcome;
  }
  if (captured.kind === 'over-limit') {
    // The client is reading the other half of this body; the half too large to keep is let go of.
    releaseStream(captured.body, 'asset over the budget');
    return 'too-large';
  }
  return storeCache(ctx.host.names.assetCache, cacheKey, cacheEntry(response, captured.bytes));
}

/**
 * A second response over the same measured bytes rather than `clone()`.
 *
 * `clone()` tees the body, and a tee of a stream is what leaves the write without a length: the
 * Cache API blocks every later `.put()` behind a chunked one, and a page load writes a chunk for
 * every script it pulled. Built from a `Uint8Array` the write is fixed-length and they run together.
 */
function cacheEntry(response: Response, bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Longest an asset request waits on the Cache API before treating it as a miss. */
const CACHE_API_READ_BUDGET_MS = 100;

/** A failing or slow Cache API is a miss; the origin remains the source of truth. */
async function lookupCache(cacheName: string, cacheKey: Request): Promise<Response | undefined> {
  const lookup = matchAdmittedAsset(cacheName, cacheKey);
  try {
    return await withDeadline(lookup, CACHE_API_READ_BUDGET_MS, 'asset cache-api read');
  } catch (error) {
    // The deadline ends this wait, not the lookup. A hit arriving after the miss belongs to no
    // response, so let its body go; the timely hit takes the unchanged path above.
    void releaseLateAsset(lookup).catch(() => {
      // A lookup that failed has no body to release; its failure was logged below.
    });
    logWarn('asset cache-api read failed', { detail: errorDetail(error) });
    return undefined;
  }
}

/** A lookup the request gave up on owns no response by the time its hit arrives. */
async function releaseLateAsset(lookup: Promise<Response | undefined>): Promise<void> {
  const late = await lookup;
  releaseStream(late?.body, 'an asset cache hit that came too late');
}

/**
 * Only explicitly admitted assets enter the host's asset cache (`EdgeNames.assetCache`), never
 * `caches.default`, which `fetch()` also populates.
 */
async function matchAdmittedAsset(
  cacheName: string,
  cacheKey: Request,
): Promise<Response | undefined> {
  const cache = await caches.open(cacheName);
  return cache.match(cacheKey);
}

async function putAdmittedAsset(
  cacheName: string,
  cacheKey: Request,
  response: Response,
): Promise<void> {
  const cache = await caches.open(cacheName);
  await cache.put(cacheKey, response);
}

/**
 * Write the entry, and say what the edge knows about it afterwards.
 *
 * Running out of time is not the same as failing. The deadline stops this waiting; it does not
 * stop the write, which may land after the metric has been reported — so a copy that ran out is
 * one nothing can vouch for rather than one that was refused.
 */
async function storeCache(
  cacheName: string,
  cacheKey: Request,
  response: Response,
): Promise<AssetKeepOutcome> {
  try {
    await withDeadline(
      putAdmittedAsset(cacheName, cacheKey, response),
      STORE_BUDGET_MS,
      'asset cache-api write',
    );
    return 'kept';
  } catch (error) {
    const outcome: AssetKeepOutcome = isDeadlineError(error) ? 'store-unconfirmed' : 'store-failed';
    logWarn('asset cache-api write given up', { outcome, detail: errorDetail(error) });
    return outcome;
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
