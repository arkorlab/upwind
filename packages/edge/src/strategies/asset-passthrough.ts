import { EDGE_DEBUG_HEADER, NO_STORE_CACHE_CONTROL } from '@stayingupwind/core/request';
import type { AssetDeliveryStrategy } from '@stayingupwind/host/delivery';

import { applyCspReporting } from '../handlers/csp-reporting-headers.ts';
import { dispatchesOf, fetchUpstream } from '../handlers/upstream.ts';
import { assetDebug, assetHeaders, assetUpstreamRequest } from './asset-upstream.ts';
import type { EdgeContext } from './context.ts';

/** No edge caching at all: every asset request goes to the deployment's own Worker. */
export const passthroughAssetStrategy: AssetDeliveryStrategy<EdgeContext, 'passthrough'> = {
  id: 'passthrough',
  async handle(request, originUrl, ctx) {
    const originResponse = await fetchUpstream(
      ctx.runtime,
      ctx.app,
      assetUpstreamRequest(request, originUrl, ctx),
    );
    // The lifetimes that outrank `cache-control` wherever they are read go, or an application that
    // sent one would decide the storage of a response from the strategy whose whole point is that
    // nothing is stored; and so do the edge's own headers (`assetHeaders`).
    const headers = assetHeaders(originResponse.headers);
    headers.set('cache-control', NO_STORE_CACHE_CONTROL);
    headers.set(EDGE_DEBUG_HEADER, assetDebug(ctx, 'passthrough', 'admit=0;reason=strategy'));
    applyCspReporting(headers, ctx.cspReportingPath);
    const response = new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers,
    });
    return { response, admitted: false, hit: false, subrequests: dispatchesOf(originResponse) };
  },
};
