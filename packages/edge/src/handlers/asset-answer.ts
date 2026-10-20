import { releaseStream } from '@stayingupwind/core/util';

import { hasCredentials, unshareable } from '../request-context.ts';
import { type AssetInput, handleAsset } from './asset.ts';
import { observeMetric } from './observer.ts';

/**
 * An immutable-asset candidate answered: the asset strategy's answer where it may be handed to this
 * client, or the client's own request (`unshared`) where that is the one to answer with — handed what
 * the strategy sent for the answer it was not given (`subrequests`), for the one point the request
 * writes to count it.
 *
 * An app can put cookie-aware middleware in front of `/_next/static/`. The asset fetch carries no
 * credentials, so what came back is what an anonymous visitor sees. A client with credentials goes
 * straight to its own request, before any asset cache lookup or anonymous fetch, even where an
 * anonymous response was previously admitted. Only anonymous clients reach the strategy.
 *
 * An anonymous answer that sets a cookie also needs the client's own request. The header is checked
 * independently of admission's first rejection reason: a redirect or a response that is not
 * immutable can set a cookie too.
 */
export async function answerAsset(
  input: AssetInput,
  unshared: (subrequests: number) => Promise<Response>,
): Promise<Response> {
  // An anonymous asset cannot decide how the application answers this client's credentials.
  // Send the client's request directly, without a cache lookup or anonymous probe ahead of it.
  if (hasCredentials(input.request.headers)) {
    return unshared(0);
  }
  const asset = await handleAsset(input);
  if (asset.admitted) {
    return asset.response;
  }
  if (!unshareable(input.request, asset)) {
    observeMetric(input.edge.host, asset.point);
    return asset.response;
  }
  // Released, not awaited: a stalled upstream may never acknowledge the cancel, and the client is
  // waiting on the request that follows — whose point counts the refused fetch among its requests,
  // where a point of its own would count a request the client never made.
  releaseStream(asset.response.body, 'asset refused as unshareable');
  return unshared(asset.point.subrequests);
}
