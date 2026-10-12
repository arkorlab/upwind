import { crc32, encodeUtf8, releaseStream } from '@stayingupwind/core/util';

import { refusedAssetKey } from '../memory/caches.ts';
import { hasCredentials, unshareable } from '../request-context.ts';
import { passthroughAssetStrategy } from '../strategies/asset-passthrough.ts';
import { FORWARDED_ASSET_HEADERS } from '../strategies/asset-upstream.ts';
import { type AssetInput, handleAsset } from './asset.ts';

/**
 * The longest URL a refusal is remembered for: far longer than any file's, and short enough that a
 * memo full of them is about a megabyte. The client chooses the URL; a longer one is not remembered.
 */
const MAX_REMEMBERED_URL_CHARS = 1024;
const HEX = 16;

/**
 * Which of the asset's answers the anonymous fetch asked for, past its URL: the request headers it
 * forwards, which an origin or a middleware may answer apart, as one short tag. Two variants that
 * come to one tag only cost the second its anonymous fetch: it goes to its own request instead,
 * which the origin answers for it — never another visitor's answer.
 */
function variantOf(request: Request): string {
  const forwarded = FORWARDED_ASSET_HEADERS.map(
    (name) => `${name}:${request.headers.get(name) ?? ''}`,
  );
  return crc32(encodeUtf8(forwarded.join('\n'))).toString(HEX);
}

/**
 * An immutable-asset candidate answered: the asset strategy's answer where it may be handed to this
 * client, or `undefined` where the client's own request is the one to answer with.
 *
 * An app can put cookie-aware middleware in front of `/_next/static/`. The asset fetch carries no
 * credentials, so what came back is what an anonymous visitor sees. When the client sent
 * credentials, or the answer sets a cookie, the client's own request is the one to answer with.
 * The header is checked independently of admission's first rejection reason: a redirect or a
 * response that is not immutable can set a cookie too.
 *
 * A refusal is remembered a short while (`refusedAssets`), for the asset's URL on the hostname the
 * request came in on — the asset cache keeps them apart, as a middleware may answer them apart —
 * and for the headers the fetch forwarded, which the origin may answer apart as well. A
 * client with credentials that asks for it again would be refused again, so its own request is sent
 * at once, rather than after a fetch whose answer nobody reads. Only the strategy's own refusal is
 * remembered (`rejection`): an upstream that could not be reached refused nothing. An admission
 * forgets the refusal.
 */
export async function answerAsset(input: AssetInput): Promise<Response | undefined> {
  const { edge, clientUrl } = input;
  // A strategy that keeps nothing never answers a client with credentials: what its fetch got is an
  // anonymous visitor's, which such a client is refused every time (`unshareable`). Its own request
  // goes at once, with no anonymous fetch ahead of it to throw away.
  if (input.strategy === passthroughAssetStrategy && hasCredentials(input.request.headers)) {
    return undefined;
  }
  const refused = edge.runtime.memory.refusedAssets;
  const url = `${clientUrl.pathname}${clientUrl.search}`;
  const key =
    url.length > MAX_REMEMBERED_URL_CHARS
      ? undefined
      : refusedAssetKey(
          edge.manifestId,
          edge.forwarding.previewHost,
          variantOf(input.request),
          url,
        );
  if (
    key !== undefined &&
    hasCredentials(input.request.headers) &&
    refused.get(key) !== undefined
  ) {
    return undefined;
  }
  const asset = await handleAsset(input);
  if (asset.admitted) {
    if (key !== undefined) {
      refused.delete(key);
    }
    return asset.response;
  }
  if (key !== undefined && asset.rejection !== undefined) {
    refused.set(key, true);
  }
  if (!unshareable(input.request, asset)) {
    return asset.response;
  }
  // Released, not awaited: a stalled upstream may never acknowledge the cancel, and the client is
  // waiting on the credentialed request that follows.
  releaseStream(asset.response.body, 'asset refused as unshareable');
  return undefined;
}
