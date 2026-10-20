import { releaseStream } from '@stayingupwind/core/util';
import { withoutHostCredentials } from '@stayingupwind/host/credentials';

import { hasCredentials } from '../request-context.ts';
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
 * anonymous response was previously admitted. Host-owned credentials are removed before this
 * decision, as they are from anything forwarded. Only clients anonymous to the app reach the strategy.
 *
 * An anonymous answer that sets a cookie also needs the client's own request. The header is checked
 * independently of admission's first rejection reason: a redirect or a response that is not
 * immutable can set a cookie too.
 */
export async function answerAsset(
  input: AssetInput,
  unshared: (subrequests: number) => Promise<Response>,
): Promise<Response> {
  // No copy or cookie parsing for a request without credentials. The host's own fields stay on
  // the original request; only a copy is filtered to decide what the application would see.
  if (hasCredentials(input.request.headers)) {
    const { credentials } = input.edge.host;
    if (
      (credentials.cookies.length === 0 && credentials.headers.length === 0) ||
      hasCredentials(withoutHostCredentials(new Headers(input.request.headers), credentials))
    ) {
      return unshared(0);
    }
  }
  const asset = await handleAsset(input);
  if (asset.admitted) {
    return asset.response;
  }
  // Every client that reaches the strategy is anonymous to the app. Only the response's own
  // cookie requires its original request after a refusal.
  if (!asset.response.headers.has('set-cookie')) {
    observeMetric(input.edge.host, asset.point);
    return asset.response;
  }
  // Released, not awaited: a stalled upstream may never acknowledge the cancel, and the client is
  // waiting on the request that follows — whose point counts the refused fetch among its requests,
  // where a point of its own would count a request the client never made.
  releaseStream(asset.response.body, 'asset refused as unshareable');
  return unshared(asset.point.subrequests);
}
