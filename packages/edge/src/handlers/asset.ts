import type { AssetRejection } from '@stayingupwind/core/assets';
import type {
  AssetDeliveryStrategy,
  AssetHandleResult,
  AssetKeepOutcome,
} from '@stayingupwind/host/delivery';

import { logWarn } from '../observability/logger.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { observeMetric } from './observer.ts';
import { badGatewayResponse, keptByNobody } from './responses.ts';

export interface AssetInput {
  readonly request: Request;
  readonly clientUrl: URL;
  readonly strategy: AssetDeliveryStrategy<EdgeContext>;
  readonly edge: EdgeContext;
}

export interface AssetOutcome {
  readonly response: Response;
  /** False when the origin's answer was refused: the caller may have a better one to give. */
  readonly admitted: boolean;
  /** Why it was refused, when it was. */
  readonly rejection: AssetRejection | undefined;
}

/**
 * What the metric says happened. An asset the edge streamed but could not keep is `admitted` on
 * the wire and never in a cache, so the reason it was not kept is named here or nowhere.
 */
function assetOutcomeKind(admitted: boolean, kept: AssetKeepOutcome | undefined): string {
  if (!admitted) {
    return 'not-admitted';
  }
  return kept === undefined || kept === 'kept' ? 'admitted' : `uncached-${kept}`;
}

/** What an asset's point says of the answer, past what every asset's says alike. */
interface AssetAnswered {
  readonly outcomeKind: string;
  readonly originCacheHeader: string;
  readonly ttfbInternalMs: number;
  readonly assetHit: number;
  readonly subrequests: number;
}

function assetMetric(input: AssetInput, answered: AssetAnswered): EdgeMetric {
  const { edge } = input;
  return {
    projectId: edge.projectId,
    kind: 'asset',
    pathname: input.clientUrl.pathname,
    shellStrategy: '',
    shellSource: '',
    outcomeKind: answered.outcomeKind,
    colo: edge.colo ?? '',
    originCacheHeader: answered.originCacheHeader,
    encoding: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    ttfbInternalMs: answered.ttfbInternalMs,
    shellLookupMs: 0,
    originFirstByteMs: 0,
    originTotalMs: 0,
    shellBytes: 0,
    suffixBytes: 0,
    recovery: 0,
    retry: 0,
    assetHit: answered.assetHit,
    subrequests: answered.subrequests,
  };
}

/**
 * The answer as a project whose delivery is private gives it (`privateDelivery`): kept by nobody,
 * the browser or a cache between, either of which could hand the asset back without the host
 * being asked — to a visitor it no longer lets through, or to one it never did. A copy with
 * headers of its own, so the entry the edge keeps behind it is the asset's as the strategy made it.
 */
function privateCopy(response: Response): Response {
  const headers = new Headers(response.headers);
  keptByNobody(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Serve an immutable-asset candidate through the policy's asset strategy. */
export async function handleAsset(input: AssetInput): Promise<AssetOutcome> {
  const startedAt = input.edge.runtime.now();
  const originUrl = new URL(
    `https://${input.edge.forwarding.previewHost}${input.clientUrl.pathname}${input.clientUrl.search}`,
  );
  let result: AssetHandleResult;
  try {
    result = await input.strategy.handle(input.request, originUrl, input.edge);
  } catch (error) {
    // The same controlled answer the document and passthrough paths give. Letting this out would
    // end the request as an unhandled Worker exception instead.
    logWarn('asset upstream fetch failed', {
      pathname: input.clientUrl.pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    // Counted as an answer is: an outage the host is told nothing of is one it cannot see.
    observeMetric(
      input.edge.host,
      assetMetric(input, {
        outcomeKind: 'upstream-error',
        originCacheHeader: '',
        ttfbInternalMs: input.edge.runtime.now() - startedAt,
        assetHit: 0,
        // The request the strategy sent upstream, which is what failed — as a passthrough that
        // could not reach the application counts its own.
        subrequests: 1,
      }),
    );
    return {
      response: badGatewayResponse('asset-upstream-error'),
      admitted: false,
      rejection: undefined,
    };
  }
  const firstByteMs = input.edge.runtime.now() - startedAt;
  const { response } = result;
  const report = (kept: AssetKeepOutcome | undefined): void => {
    observeMetric(
      input.edge.host,
      assetMetric(input, {
        outcomeKind: assetOutcomeKind(result.admitted, kept),
        originCacheHeader: response.headers.get('x-vercel-cache') ?? '',
        // A time to first byte again: on a miss the strategy answers on the origin's headers and
        // streams the body behind them, and on a hit this is the Cache API read.
        ttfbInternalMs: firstByteMs,
        assetHit: result.hit ? 1 : 0,
        subrequests: result.subrequests,
      }),
    );
  };
  // A copy kept behind the response is the one thing this cannot report yet, and the reason an
  // asset went unstored is the only place that shows — the header committed `admit=1` long before.
  if (result.kept === undefined) {
    report(undefined);
  } else {
    input.edge.ctx.waitUntil(
      (async (): Promise<void> => {
        report(await result.kept);
      })(),
    );
  }
  return {
    response: input.edge.privateDelivery ? privateCopy(response) : response,
    admitted: result.admitted,
    rejection: result.rejection,
  };
}
